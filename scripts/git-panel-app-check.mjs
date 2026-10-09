// The Git panel inside the real app: the real main process, a real Copilot CLI session in a pty, the real header button,
// the real shortcut with the terminal focused, persistence across a reload, and a narrow window. Isolated data folders.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/git-panel-app')
const delay = ms => new Promise(accept => setTimeout(accept, ms))

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const directory = await mkdtemp(join(tmpdir(), 'git-panel-app-'))
  const env = { ...process.env, GIT_PANEL_APP_DIR: directory, GIT_PANEL_APP_ARTIFACTS: artifacts }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 170_000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Git panel app check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
    console.log('Git panel in the app: header button, Ctrl+Shift+G with the terminal focused, persistence, narrow-window takeover and an untouched terminal all work.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.env.GIT_PANEL_APP_DIR
  const out = process.env.GIT_PANEL_APP_ARTIFACTS
  const workspace = join(directory, 'workspace')
  app.setPath('userData', join(directory, 'userdata'))
  void run().catch(async error => {
    console.error(error)
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error) })).catch(() => {})
    app.exit(1)
  })

  async function run() {
    await mkdir(workspace, { recursive: true })
    await mkdir(join(directory, 'copilot-home'), { recursive: true })
    await mkdir(join(directory, 'userdata'), { recursive: true })
    await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = Check\n\temail = check@example.com\n[init]\n\tdefaultBranch = main\n')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const name of ['alpha', 'beta']) {
      const repo = join(workspace, name)
      await mkdir(repo)
      git(repo, 'init', '-q')
      await writeFile(join(repo, 'a.txt'), 'one\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', `init ${name}`)
    }
    await writeFile(join(workspace, 'alpha', 'a.txt'), 'one\ntwo\n')

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const profile = createWorkspaceProfile(workspace)
    await writeDesktopConfig(join(directory, 'userdata', 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id,
      closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })
    await import('../dist/src/main/main.js')
    await app.whenReady()
    let main
    for (let attempt = 0; attempt < 150 && !main; attempt++) {
      main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html'))
      if (!main) await delay(100)
    }
    assert.ok(main, 'main window did not load')
    main.setContentSize(1500, 900)
    const ui = code => main.webContents.executeJavaScript(code)
    const until = async (code, label) => {
      const end = Date.now() + 25_000
      while (Date.now() < end) { if (await ui(code)) return; await delay(50) }
      throw new Error(`Timed out: ${label}\n--- page text ---\n${(await ui('document.body.innerText.slice(0, 800)')).trim()}`)
    }
    const click = async selector => {
      const point = await ui(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing click target: ' + ${JSON.stringify(selector)});
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`)
      main.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
    const press = (keyCode, modifiers) => { main.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); main.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }) }
    const results = {}

    // A real session starts in the workspace, and the header carries the Git toggle.
    await until('!!document.querySelector(".session-git-toggle") && !!document.querySelector(".xterm")', 'session header and terminal')
    assert.equal(await ui('!!document.querySelector(".git-panel")'), false, 'the panel starts closed')
    assert.equal(await ui('document.querySelector(".session-git-toggle").getAttribute("aria-pressed")'), 'false')
    // The same terminal element must survive every open, close and takeover below: a remounted xterm would lose the session view.
    await ui('window.__xterm = document.querySelector(".xterm"); window.__inserted = []; window.addEventListener("copilot-desktop:insert-prompt", event => window.__inserted.push(event.detail))')
    const sameTerminal = () => ui('document.querySelector(".xterm") === window.__xterm')

    // The header button opens the panel beside the terminal, with both repositories.
    await click('.session-git-toggle')
    await until('!!document.querySelector(".git-repo-selected")', 'panel opened with repositories')
    assert.deepEqual(await ui('[...document.querySelectorAll(".git-repo-name")].map(element => element.innerText)'), ['alpha', 'beta'])
    assert.equal(await ui('document.querySelector(".session-git-toggle").getAttribute("aria-pressed")'), 'true')
    assert.equal(await ui('localStorage.getItem("git-panel-open")'), 'true')
    const widths = await ui('({ panel: document.querySelector(".git-panel").getBoundingClientRect().width, main: document.querySelector(".project-dock-main").getBoundingClientRect().width })')
    assert.ok(widths.panel >= 320 && widths.main >= 480, JSON.stringify(widths))
    assert.equal(await sameTerminal(), true)
    results.headerButton = true

    // Add to prompt reaches this session.
    await until('[...document.querySelectorAll(".git-entry-name")].some(element => element.innerText === "a.txt")', 'file list')
    await ui('[...document.querySelectorAll(".git-entry")].find(element => element.innerText.includes("a.txt")).setAttribute("data-pick", "")')
    await click('[data-pick]')
    await until('/\\+two/.test(document.querySelector(".git-diff-lines")?.innerText || "")', 'diff shown')
    await click('.git-diff-head button')
    await until('window.__inserted.length === 1', 'prompt text inserted')
    const inserted = await ui('window.__inserted[0]')
    assert.match(inserted.text, /unstaged change to `a\.txt` in `alpha`/)
    assert.match(await ui('document.querySelector(".git-message-info")?.innerText || ""'), /prompt box of/)
    const tabId = await ui('document.querySelector(".session-pane-focused, .session-pane-visible")?.getAttribute("aria-label")')
    assert.match(tabId ?? '', /Main session/)
    assert.match(inserted.tabId, /^tab-\d+$/)
    results.addToPrompt = true

    // Ctrl+Shift+G with the terminal focused toggles the panel and the terminal never sees ^G.
    await ui('document.querySelector(".xterm-helper-textarea").focus()')
    assert.equal(await ui('document.activeElement.classList.contains("xterm-helper-textarea")'), true, 'the terminal has focus')
    press('G', ['control', 'shift'])
    await until('!document.querySelector(".git-panel")', 'shortcut closes the panel')
    assert.equal(await ui('document.querySelector(".session-git-toggle").getAttribute("aria-pressed")'), 'false')
    press('G', ['control', 'shift'])
    await until('!!document.querySelector(".git-repo-selected")', 'shortcut opens the panel again')
    assert.equal(await sameTerminal(), true)
    results.shortcutWithTerminalFocused = true

    // The open state and the chosen repository survive a reload.
    await ui('[...document.querySelectorAll(".git-repo")].find(element => element.innerText.includes("beta")).setAttribute("data-pick", "")')
    await click('[data-pick]')
    await until('/beta/.test(document.querySelector(".git-repo-selected")?.innerText || "")', 'beta selected')
    await new Promise(accept => { main.webContents.once('did-finish-load', accept); main.webContents.reload() })
    await until('!!document.querySelector(".git-repo-selected")', 'panel restored after reload')
    assert.match(await ui('document.querySelector(".git-repo-selected").innerText'), /beta/)
    results.persistence = true

    // A window too narrow for both gives the panel the whole area; the session stays mounted and comes back on close.
    await until('!!document.querySelector(".xterm")', 'terminal after reload')
    await ui('window.__xterm = document.querySelector(".xterm")')
    main.setContentSize(900, 700)
    await until('getComputedStyle(document.querySelector(".project-dock-main")).display === "none"', 'panel takes over a narrow window')
    assert.equal(await ui('document.querySelector(".git-panel").getBoundingClientRect().width > 500'), true)
    assert.equal(await sameTerminal(), true, 'the terminal stays mounted while hidden')
    await click('button[aria-label="Close Git panel and return to the session"]')
    await until('!document.querySelector(".git-panel") && getComputedStyle(document.querySelector(".project-dock-main")).display !== "none"', 'the session returns')
    assert.equal(await sameTerminal(), true)
    results.narrowTakeover = true

    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, ...results }, null, 2))
    app.quit()
  }
}
