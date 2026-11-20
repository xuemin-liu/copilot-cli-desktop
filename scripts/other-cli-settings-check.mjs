// Per-CLI permission/model settings in the real app. Antigravity is a local fixture: node.exe copied to agy.exe on
// PATH, which reports a version and whose --help has no --model — an installed CLI build that would reject the flag.
// Checks, through the real main process and windows:
//  1. Settings renders the per-CLI editor, and a malformed new value fails the save instead of being dropped.
//  2. A new tab whose workspace model the installed agy does not list is refused before any process starts.
//  3. A saved tab with that setting, restored on startup, does not launch; it shows a notice naming the field.
//  4. "Use … settings" clears just that field on the tab, starts it, and the next restart keeps working.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = resolve('test-results/other-cli-settings')
const delay = ms => new Promise(accept => setTimeout(accept, ms))

if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const directory = await mkdtemp(join(process.env.CHECK_TMP ?? tmpdir(), 'other-cli-settings-'))
  let timer
  try {
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const agy = join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy')
    if (process.platform === 'win32') await copyFile(process.execPath, agy)
    else await symlink(process.execPath, agy)
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
    const env = { ...process.env, CHECK_DIR: directory, COPILOT_DESKTOP_MEETING_MCP_PORT: '0',
      ANTIGRAVITY_GEMINI_DIR: join(directory, 'gemini-home'), [pathKey]: [bin, process.env[pathKey]].filter(Boolean).join(delimiter) }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.SHELL
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    timer = setTimeout(() => child.kill(), 180_000)
    assert.equal(await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) }), 0, 'other CLI settings check failed')
    console.log('Per-CLI settings: editor, save validation, launch preflight and recovery work in the real app.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.env.CHECK_DIR
  const userData = join(directory, 'userdata')
  app.setPath('userData', userData)
  void run().catch(async error => {
    console.error(error)
    app.exit(1)
  })

  async function run() {
    for (const name of ['copilot-home', 'userdata', 'gemini-home']) await mkdir(join(directory, name), { recursive: true })
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    const repo = join(directory, 'project')
    await mkdir(repo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo })

    const { resolveAgentCli } = await import('../dist/src/main/agent-cli.js')
    const fixture = await resolveAgentCli('antigravity')
    assert.equal(fixture.error, null, 'the agy fixture resolves')

    // A workspace whose Antigravity model the fixture cannot take, and one saved Antigravity tab that snapshotted it.
    const configPath = join(userData, 'desktop.json')
    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig, readDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const project = createWorkspaceProfile(repo)
    project.defaultResumeMode = 'new'
    project.otherCli = { antigravity: { model: 'model-x' } }
    project.tabs = [{ title: 'Saved Antigravity', lastSessionId: null, cli: 'antigravity', otherCliConfig: { model: 'model-x' }, active: true }]
    await writeDesktopConfig(configPath, { ...DEFAULT_DESKTOP_CONFIG, profiles: [project], activeProfileId: project.id,
      closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })

    await import('../dist/src/main/main.js')
    await app.whenReady()
    let main
    for (let attempt = 0; attempt < 150 && !main; attempt++) {
      main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html'))
      if (!main) await delay(100)
    }
    assert.ok(main, 'main window')
    main.setContentSize(1400, 900)
    const ui = code => main.webContents.executeJavaScript(code)
    const tabs = async () => (await ui('window.copilotDesktop.getState()')).tabs
    const tabWhere = async (predicate, label, timeout = 30_000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        const found = (await tabs()).find(predicate)
        if (found) return found
        await delay(150)
      }
      await writeFile(join(out, 'failure.png'), (await main.webContents.capturePage()).toPNG())
      throw new Error(`Timed out: ${label}\n${JSON.stringify(await tabs(), null, 1)}`)
    }

    // 3. The saved tab was restored on startup but did not launch with a model agy cannot take.
    const blocked = await tabWhere(tab => tab.cli === 'antigravity' && tab.otherCliBlocked?.length, 'restored tab blocked by its saved model')
    assert.equal(blocked.processId, null, 'no process was started with the unsupported model')
    await delay(500)
    assert.equal((await tabs()).find(tab => tab.id === blocked.id).status, 'dormant', 'shown as Not running, not as a crash')
    assert.deepEqual(blocked.otherCliBlocked.map(field => [field.key, field.value]), [['model', 'model-x']])
    assert.match(blocked.otherCliBlocked[0].reason, /does not list --model/)
    const notice = await ui('document.querySelector(".other-cli-blocked")?.innerText ?? ""')
    assert.match(notice, /Model “model-x”/)
    await writeFile(join(out, 'blocked.png'), (await main.webContents.capturePage()).toPNG())
    console.log('OK: restored tab with an unsupported saved model did not launch and names the field')

    // 2. A new tab from the same workspace is refused before anything starts.
    const before = (await tabs()).length
    const refused = await ui(`window.copilotDesktop.createTab('new', ${JSON.stringify(project.id)}, null, { cli: 'antigravity' }).then(() => 'started', error => String(error))`)
    assert.match(refused, /Model "model-x".*does not list --model/)
    assert.equal((await tabs()).length, before, 'no tab was added')
    console.log('OK: a new tab with an unsupported workspace model is refused before launch')

    // 4. Recovery clears only that field on the tab, starts it, and the next restart keeps working.
    await ui('document.querySelector(".other-cli-blocked button").click()')
    const started = await tabWhere(tab => tab.id === blocked.id && tab.processId !== null && !tab.otherCliBlocked, 'tab started after recovery')
    assert.equal(started.otherCliConfig, undefined, 'the tab snapshot no longer has the model')
    // The config is written asynchronously after the state changes: wait for the save.
    let savedTab
    for (let attempt = 0; attempt < 50; attempt++) {
      savedTab = (await readDesktopConfig(configPath)).profiles[0].tabs.find(tab => tab.cli === 'antigravity')
      if (savedTab && savedTab.otherCliConfig === undefined) break
      await delay(100)
    }
    assert.equal(savedTab.otherCliConfig, undefined, `the cleared snapshot is saved: ${JSON.stringify(savedTab)}`)
    assert.deepEqual((await readDesktopConfig(configPath)).profiles[0].otherCli, { antigravity: { model: 'model-x' } }, 'the workspace profile is untouched')
    const firstPid = started.processId
    await ui(`window.copilotDesktop.restartTab(${JSON.stringify(blocked.id)})`)
    await tabWhere(tab => tab.id === blocked.id && tab.processId !== null && tab.processId !== firstPid && !tab.otherCliBlocked, 'next restart')
    console.log('OK: recovery cleared just the field, started the tab, and the next restart works')

    // 1. Settings: the editor renders, and a malformed model fails the save instead of being silently dropped.
    await ui('window.copilotDesktop.openSettings()')
    let settings
    for (let attempt = 0; attempt < 150 && !settings; attempt++) {
      settings = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('settings.html'))
      if (!settings) await delay(100)
    }
    assert.ok(settings, 'settings window')
    settings.setContentSize(1100, 900)
    const sui = code => settings.webContents.executeJavaScript(code)
    const suntil = async (code, label) => {
      const end = Date.now() + 20_000
      while (Date.now() < end) { if (await sui(`Boolean(${code})`)) return; await delay(50) }
      throw new Error(`Timed out: ${label}`)
    }
    await suntil('document.querySelector(".other-cli-settings")', 'per-CLI settings')
    assert.equal(await sui('document.querySelectorAll(".other-cli-tab").length'), 3)
    await sui('document.querySelectorAll(".other-cli-tab")[1].click()')
    await suntil('document.querySelectorAll(".other-cli-settings select").length === 2', 'Codex approval + sandbox')
    const rejected = await sui(`window.copilotDesktopSettings.updateWorkspaceProfile(${JSON.stringify(project.id)}, 'project', 'default', 'new',
      ${JSON.stringify(project.launch)}, { antigravity: { model: 'model-x' }, claude: { model: '--bad' } }).then(() => 'saved', error => String(error))`)
    assert.match(rejected, /not a usable model name/)
    assert.deepEqual((await readDesktopConfig(configPath)).profiles[0].otherCli, { antigravity: { model: 'model-x' } }, 'a rejected save changes nothing')
    const cleared = await sui(`window.copilotDesktopSettings.updateWorkspaceProfile(${JSON.stringify(project.id)}, 'project', 'default', 'new',
      ${JSON.stringify(project.launch)}, { antigravity: { model: '' }, claude: { approval: 'plan' } }).then(() => 'saved', error => String(error))`)
    assert.equal(cleared, 'saved')
    assert.deepEqual((await readDesktopConfig(configPath)).profiles[0].otherCli, { claude: { approval: 'plan' } }, 'an empty value clears just that field')
    await sui('document.querySelectorAll(".other-cli-tab")[0].click()')
    await sui('document.querySelector(".other-cli-settings").scrollIntoView({ block: "center" })')
    await delay(150)
    await writeFile(join(out, 'settings.png'), (await settings.webContents.capturePage()).toPNG())
    console.log('OK: settings editor renders; malformed values fail the save; empty values clear')

    app.exit(0)
  }
}
