// Selecting a session in the real app makes its project the active one: the real main process, real Copilot CLI sessions in
// two projects, real clicks in the sidebar, and the Git panel showing the selected session's repository. Isolated data folders.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/session-project-switch')
const delay = ms => new Promise(accept => setTimeout(accept, ms))

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const directory = await mkdtemp(join(tmpdir(), 'session-project-switch-'))
  const env = { ...process.env, SWITCH_DIR: directory, SWITCH_ARTIFACTS: artifacts }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 170_000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Session project switch check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
    console.log('Selecting a session switched the active project and the Git panel to that session\'s project, and closing it moved to the session left on screen.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.env.SWITCH_DIR
  const out = process.env.SWITCH_ARTIFACTS
  const userData = join(directory, 'userdata')
  app.setPath('userData', userData)
  void run().catch(async error => {
    console.error(error)
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error) })).catch(() => {})
    app.exit(1)
  })

  async function run() {
    await mkdir(join(directory, 'copilot-home'), { recursive: true })
    await mkdir(userData, { recursive: true })
    await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = Check\n\temail = check@example.com\n[init]\n\tdefaultBranch = main\n')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    // Two projects, each holding two repositories with their own names (the panel lists repositories once there are two).
    const projects = {}
    for (const name of ['one', 'two']) {
      for (const suffix of ['a', 'b']) {
        const repo = join(directory, `proj-${name}`, `${name}-${suffix}`)
        await mkdir(repo, { recursive: true })
        git(repo, 'init', '-q')
        await writeFile(join(repo, 'a.txt'), `${name}\n`)
        git(repo, 'add', '.')
        git(repo, 'commit', '-q', '-m', `init ${name}`)
      }
      projects[name] = join(directory, `proj-${name}`)
    }

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const one = createWorkspaceProfile(projects.one)
    const two = createWorkspaceProfile(projects.two)
    await writeDesktopConfig(join(userData, 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [one, two], activeProfileId: one.id,
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
      const end = Date.now() + 30_000
      while (Date.now() < end) { if (await ui(code)) return; await delay(50) }
      throw new Error(`Timed out: ${label}\n--- page text ---\n${(await ui('document.body.innerText.slice(0, 800)')).trim()}`)
    }
    const click = async selector => {
      const point = await ui(`(() => {
        // Each session pane has its own header; click the one on screen.
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(candidate => candidate.getClientRects().length > 0);
        if (!element) throw new Error('Missing click target: ' + ${JSON.stringify(selector)});
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`)
      main.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
    const state = () => ui('window.copilotDesktop.getState()')
    const repoNames = () => ui('[...document.querySelectorAll(".git-repo-name")].map(element => element.innerText)')
    const results = {}

    // A session starts in project one; a second one starts in project two from the sidebar, which makes two active.
    await until('!!document.querySelector(".session-git-toggle") && !!document.querySelector(".xterm")', 'first session')
    await click(`[aria-label="New session in ${two.name}"]`)
    // The new-session dialog: OK with the name left empty keeps the default.
    await until('!!document.querySelector(".input-dialog")', 'new-session dialog')
    await click('.input-dialog button[type="submit"]')
    await until(`document.querySelectorAll(".sidebar-session").length === 2`, 'second session listed')
    assert.equal((await state()).activeProfileId, two.id, 'a new session in project two makes it active')
    await click('.session-git-toggle')
    await until('[...document.querySelectorAll(".git-repo-name")].some(element => element.innerText === "two-a")', 'Git panel shows project two')
    assert.deepEqual(await repoNames(), ['two-a', 'two-b'])

    // Selecting project one's session in the sidebar switches the project, the sidebar highlight and the Git panel.
    await click(`[aria-label="${one.name} sessions"] .sidebar-session`)
    await until(`(() => { const row = document.querySelector('.workspace-row[aria-label="${one.name}"]'); return row?.getAttribute('aria-current') === 'true' })()`, 'project one highlighted')
    const selected = await state()
    assert.equal(selected.tabs.find(tab => tab.id === selected.activeTabId)?.workspaceProfileId, one.id, 'project one\'s session is active')
    assert.equal(selected.activeProfileId, one.id, 'selecting a session makes its project active')
    await until('[...document.querySelectorAll(".git-repo-name")].some(element => element.innerText === "one-a")', 'Git panel shows project one')
    assert.deepEqual(await repoNames(), ['one-a', 'one-b'])
    await writeFile(join(out, 'selected-project-one.png'), (await main.webContents.capturePage()).toPNG())
    // The choice is saved, so a restart opens the same project.
    const end = Date.now() + 10_000
    let saved
    while (Date.now() < end && saved !== one.id) { saved = JSON.parse(await readFile(join(userData, 'desktop.json'), 'utf8')).activeProfileId; await delay(100) }
    assert.equal(saved, one.id, 'the active project is saved')
    results.selectSwitchesProject = true

    // Closing that session leaves project two's session on screen, and the project follows it.
    await ui(`window.copilotDesktop.closeTab(${JSON.stringify(selected.activeTabId)})`)
    await until(`document.querySelectorAll(".sidebar-session").length === 1`, 'session closed')
    assert.equal((await state()).activeProfileId, two.id, 'closing moves to the project of the session left on screen')
    await until('[...document.querySelectorAll(".git-repo-name")].some(element => element.innerText === "two-a")', 'Git panel back on project two')
    results.closeFollowsSession = true

    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, ...results }, null, 2))
    app.quit()
  }
}
