// Naming a new session in the real app: the real main process, real Copilot CLI sessions, real clicks and typing. Every way
// to start a fresh session opens one dialog with the project's name greyed out as the default; OK keeps it, typing
// replaces it, and a project that starts sessions in a worktree previews the worktree name. Isolated data folders.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/session-name-dialog')
const delay = ms => new Promise(accept => setTimeout(accept, ms))

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const directory = await mkdtemp(join(tmpdir(), 'session-name-dialog-'))
  const env = { ...process.env, NAME_DIR: directory, NAME_ARTIFACTS: artifacts }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 170_000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Session name dialog check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
    console.log('New sessions are named in a dialog: the default is greyed out and kept on OK, a typed name replaces it, the menu and Ctrl+T use the same dialog, and a worktree project previews its worktree name, and each session can choose its own worktree or start in an existing one.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow, Menu } = await import('electron')
  const directory = process.env.NAME_DIR
  const out = process.env.NAME_ARTIFACTS
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
    await writeFile(join(directory, 'copilot-home', 'config.json'), JSON.stringify({ trustedFolders: [directory] }))
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const projects = {}
    for (const name of ['project', 'trees']) {
      const repo = join(directory, name)
      await mkdir(repo, { recursive: true })
      git(repo, 'init', '-q')
      await writeFile(join(repo, 'a.txt'), `${name}\n`)
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'init')
      projects[name] = repo
    }

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const project = createWorkspaceProfile(projects.project)
    // A project whose fresh sessions start in a worktree. The check never starts one there, so no worktree is created in it.
    const trees = createWorkspaceProfile(projects.trees)
    trees.launch = { ...trees.launch, worktree: true }
    trees.defaultResumeMode = 'new'
    await writeDesktopConfig(join(userData, 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [project, trees], activeProfileId: project.id,
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
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(candidate => candidate.getClientRects().length > 0);
        if (!element) throw new Error('Missing click target: ' + ${JSON.stringify(selector)});
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`)
      main.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
    const press = (keyCode, modifiers = []) => {
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      if (keyCode === 'Return') main.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    const type = text => { for (const keyCode of text) main.webContents.sendInputEvent({ type: 'char', keyCode }) }
    // Picks where the session starts, the way choosing in the list does (a native list cannot be driven by mouse events).
    const choose = value => ui(`(() => {
      const select = document.querySelector('select[name="start-in"]');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    const dialog = () => ui(`(() => {
      const form = document.querySelector('.input-dialog');
      if (!form) return null;
      const input = form.querySelector('#input-dialog-value');
      return { title: form.querySelector('h2').innerText, value: input.value, placeholder: input.placeholder, focused: document.activeElement === input,
        hint: form.querySelector('.fork-hint')?.innerText ?? '', submit: form.querySelector('button[type="submit"]').innerText,
        worktree: form.querySelector('select[name="start-in"]') ? form.querySelector('select[name="start-in"]').value === 'new' : null,
        startIn: [...(form.querySelector('select[name="start-in"]')?.options ?? [])].map(option => option.value),
        sharedOverrides: form.querySelector('input[name="shared-overrides"]')?.checked ?? null };
    })()`)
    const titles = async () => (await ui('window.copilotDesktop.getState()')).tabs.map(tab => tab.title)
    const results = {}

    await until('!!document.querySelector(".session-git-toggle") && !!document.querySelector(".xterm")', 'first session')
    assert.deepEqual(await titles(), ['project'], 'the startup session keeps its default name without asking')

    // The project's + opens the dialog: empty, focused, the default greyed out as the placeholder. OK keeps the default.
    await click(`[aria-label="New session in ${project.name}"]`)
    await until('!!document.querySelector(".input-dialog")', 'dialog from the project +')
    let shown = await dialog()
    assert.deepEqual({ title: shown.title, value: shown.value, placeholder: shown.placeholder, focused: shown.focused, submit: shown.submit },
      { title: 'New session', value: '', placeholder: 'project', focused: true, submit: 'Start session' })
    assert.match(shown.hint, /Leave it empty and Copilot names the session from your first prompt; until then the tab shows “project”/)
    assert.doesNotMatch(shown.hint, /worktree/, 'no worktree preview for a project without worktrees')
    assert.equal(shown.worktree, false, 'the start-in choice follows the project setting: the project folder')
    assert.deepEqual(shown.startIn, ['folder', 'new'], 'no existing worktrees to offer yet')
    assert.equal(shown.sharedOverrides, true, 'the Local Overrides box follows the Settings default: shared')
    assert.equal(await ui(`getComputedStyle(document.querySelector('#input-dialog-value'), '::placeholder').color !== getComputedStyle(document.querySelector('#input-dialog-value')).color`), true, 'the default is shown greyed out')
    await writeFile(join(out, 'default-name.png'), (await main.webContents.capturePage()).toPNG())
    press('Return')
    await until('!document.querySelector(".input-dialog") && document.querySelectorAll(".sidebar-session").length === 2', 'default session started')
    assert.deepEqual(await titles(), ['project', 'project'])
    results.okKeepsDefault = true

    // Ctrl+T opens the same dialog; typing replaces the greyed default. With a real keyboard the File menu's accelerator
    // takes Ctrl+T (checked below through the menu); synthetic keys skip accelerators, so this checks the page's own
    // shortcut, outside the terminal.
    await ui('document.querySelector(".workspace-row").focus()')
    press('T', ['control'])
    await until('!!document.querySelector(".input-dialog")', 'dialog from Ctrl+T')
    type('Fix login')
    shown = await dialog()
    assert.equal(shown.value, 'Fix login')
    assert.equal(await ui(`document.querySelector('#input-dialog-value').matches(':placeholder-shown')`), false, 'typing hides the default')
    press('Return')
    await until('!document.querySelector(".input-dialog") && document.querySelectorAll(".sidebar-session").length === 3', 'named session started')
    assert.deepEqual(await titles(), ['project', 'project', 'Fix login'])
    results.typedName = true

    // The File menu's New Session Tab asks the window for the same dialog; Escape closes it without starting anything.
    const menuItem = Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? []).find(item => item.label === 'New Session Tab')
    assert.ok(menuItem, 'File > New Session Tab exists')
    menuItem.click()
    await until('!!document.querySelector(".input-dialog")', 'dialog from the menu')
    press('Escape')
    await until('!document.querySelector(".input-dialog")', 'Escape closes the dialog')
    await delay(500)
    assert.equal((await titles()).length, 3, 'a cancelled dialog starts nothing')
    results.menuAndEscape = true

    // A worktree project previews the worktree and branch name, following what is typed.
    await click(`[aria-label="New session in ${trees.name}"]`)
    await until('!!document.querySelector(".input-dialog")', 'dialog for the worktree project')
    shown = await dialog()
    assert.equal(shown.placeholder, 'trees')
    assert.equal(shown.worktree, true, 'the start-in choice follows the project setting: a new worktree')
    assert.match(shown.hint, /own Git worktree and branch, desktop-trees-…/)
    type('Fix login race')
    await until(`/desktop-fix-login-race-…/.test(document.querySelector('.input-dialog .fork-hint')?.innerText ?? '')`, 'preview follows the typed name')
    await writeFile(join(out, 'worktree-preview.png'), (await main.webContents.capturePage()).toPNG())
    // This one session can work in the project folder instead.
    await choose('folder')
    await until(`document.querySelector('select[name="start-in"]').value === 'folder' && !/worktree and branch/.test(document.querySelector('.input-dialog .fork-hint')?.innerText ?? '')`, 'worktree turned off for this session')
    await choose('new')
    await until(`document.querySelector('select[name="start-in"]').value === 'new'`, 'worktree turned back on')
    await click('.input-dialog-actions button[type="button"]')
    await until('!document.querySelector(".input-dialog")', 'Cancel closes the dialog')
    assert.equal((await titles()).length, 3)
    results.worktreePreview = true

    // A project without worktrees, one session in a new worktree: choose it, and the real CLI runs it in one.
    await click(`[aria-label="New session in ${project.name}"]`)
    await until('!!document.querySelector(".input-dialog")', 'dialog for one worktree session')
    type('In a worktree')
    await choose('new')
    await until(`/desktop-in-a-worktree-…/.test(document.querySelector('.input-dialog .fork-hint')?.innerText ?? '')`, 'preview for the chosen worktree')
    await click('input[name="shared-overrides"]')
    await until(`!document.querySelector('input[name="shared-overrides"]').checked`, 'own Local Overrides for this session')
    await delay(300)
    await writeFile(join(out, 'worktree-chosen.png'), (await main.webContents.capturePage()).toPNG())
    press('Return')
    await until(`(async () => (await window.copilotDesktop.getState()).tabs.find(tab => tab.title === 'In a worktree' && tab.worktree))()`, 'the session runs in its own worktree')
    const worktree = (await ui('window.copilotDesktop.getState()')).tabs.find(tab => tab.title === 'In a worktree').worktree
    assert.match(worktree.branch ?? '', /^desktop-in-a-worktree-[0-9a-f]{6}$/, JSON.stringify(worktree))
    assert.equal(JSON.parse(await readFile(join(userData, 'desktop.json'), 'utf8')).profiles.find(entry => entry.id === project.id).launch.worktree, false, 'the project setting is unchanged')
    results.worktreeChosen = worktree.branch
    const chosenTab = (await ui('window.copilotDesktop.getState()')).tabs.find(tab => tab.title === 'In a worktree')
    assert.equal(chosenTab.privateOverrides, true, 'its browser keeps Local Overrides to itself')
    assert.equal((await ui('window.copilotDesktop.getState()')).tabs.filter(tab => tab.privateOverrides).length, 1, 'only that session')
    results.privateOverridesChosen = true

    // The worktree that session made is now offered to the next one: it starts there, with no new worktree, and says so.
    await click(`[aria-label="New session in ${project.name}"]`)
    await until('!!document.querySelector(".input-dialog")', 'dialog for a session in an existing worktree')
    const existing = `existing:${worktree.path}`
    await until(`[...document.querySelectorAll('select[name="start-in"] option')].some(option => option.value === ${JSON.stringify(existing)})`, 'the existing worktree is offered')
    assert.match(await ui(`[...document.querySelectorAll('select[name="start-in"] option')].find(option => option.value === ${JSON.stringify(existing)}).innerText`),
      /used by In a worktree/, 'the option names the session already there')
    type('Same worktree')
    await choose(existing)
    await until(`/existing worktree/.test(document.querySelector('.input-dialog .fork-hint')?.innerText ?? '')`, 'preview for the existing worktree')
    const fit = await ui(`(() => { const dialog = document.querySelector('.input-dialog').getBoundingClientRect(); const input = document.querySelector('#input-dialog-value').getBoundingClientRect(); const select = document.querySelector('select[name="start-in"]').getBoundingClientRect(); return { dialog: [dialog.left, dialog.right], input: [input.left, input.right], select: [select.left, select.right] } })()`)
    assert.ok(fit.select[0] >= fit.dialog[0] && fit.select[1] <= fit.dialog[1], `the Start in list stays inside the dialog with a long worktree option chosen: ${JSON.stringify(fit)}`)
    assert.ok(Math.abs(fit.select[1] - fit.input[1]) < 1, `the Start in list is as wide as the name box: ${JSON.stringify(fit)}`)
    await delay(300)
    await writeFile(join(out, 'existing-worktree-chosen.png'), (await main.webContents.capturePage()).toPNG())
    press('Return')
    await until(`(async () => (await window.copilotDesktop.getState()).tabs.find(tab => tab.title === 'Same worktree' && tab.worktree))()`, 'the session runs in the existing worktree')
    const same = (await ui('window.copilotDesktop.getState()')).tabs.find(tab => tab.title === 'Same worktree')
    assert.equal(same.worktree.path.toLowerCase(), worktree.path.toLowerCase(), JSON.stringify(same.worktree))
    assert.equal(same.launchWorktreePath.toLowerCase(), worktree.path.toLowerCase())
    assert.equal(git(projects.project, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 2, 'no further worktree was made')
    results.existingWorktreeChosen = same.worktree.path

    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, ...results }, null, 2))
    app.quit()
  }
}
