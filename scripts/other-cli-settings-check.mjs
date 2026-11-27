// Per-CLI permission/model settings in the real app. Antigravity is a local fixture: node.exe copied to agy.exe on
// PATH, which reports a version and whose --help has no --model — an installed CLI build that would reject the flag.
// Checks, through the real main process and windows:
//  1. Settings saves model and effort selections, reloads a changed provider, and rejects a malformed model.
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
      provider: { type: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'local-test-model', offline: true },
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
    await suntil('document.querySelector(\'option[value="local-test-model"]\')', 'Copilot model from the configured provider')
    const selectOption = (selector, evaluate = sui) => evaluate(`(() => {
      const option = document.querySelector(${JSON.stringify(selector)})
      const select = option.closest('select')
      if (select.disabled) throw new Error('Picker is disabled')
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    const clickButton = (label, evaluate = sui) => evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
    const setInput = (selector, value, evaluate = sui) => evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    const saveLaunch = async (model, effort) => {
      await clickButton('Save profile')
      for (let attempt = 0; attempt < 50; attempt++) {
        const launch = (await readDesktopConfig(configPath)).profiles[0].launch
        if (launch.model === model && launch.reasoningEffort === effort) {
          await suntil('[...document.querySelectorAll("button")].some(button => button.textContent === "Save profile" && !button.disabled)', 'save finished')
          return
        }
        await delay(100)
      }
      throw new Error(`Workspace did not save model "${model}" and effort "${effort}"`)
    }

    const copilotGrid = '.settings-card > .settings-form-grid'
    await selectOption(`${copilotGrid} option[value="high"]`)
    await saveLaunch('', 'high')
    await selectOption(`${copilotGrid} option[value="--custom-model"]`)
    await setInput(`${copilotGrid} input[maxlength="200"]`, 'custom-review-model')
    await saveLaunch('custom-review-model', 'high')
    await selectOption('option[value="local-test-model"]')
    await saveLaunch('local-test-model', 'high')
    await setInput('input[placeholder="Model or deployment identifier"]', 'replacement-test-model')
    await clickButton('Save provider')
    await suntil('document.querySelector(\'option[value="replacement-test-model"]\')', 'updated Copilot provider model')
    assert.equal(await sui('document.querySelector(\'option[value="local-test-model"]\').textContent'), 'local-test-model (saved)')
    assert.equal(await sui('document.querySelectorAll(".other-cli-tab").length'), 3)
    await sui('document.querySelectorAll(".other-cli-tab")[1].click()')
    await suntil('document.querySelectorAll(".other-cli-settings select").length === 4', 'Codex approval, sandbox, model and effort')
    await suntil('document.querySelector(\'.other-cli-settings select:not(:disabled) option[value="high"]\')', 'Codex default model effort')
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

    // Exercise the built renderer with a fixed Auto catalog independent of any installed account's model policies.
    const fixtureState = await sui('window.copilotDesktopSettings.get()')
    const fixturePreload = join(directory, 'fixture-settings-preload.cjs')
    await writeFile(fixturePreload, `
      const { contextBridge } = require('electron')
      const state = ${JSON.stringify(fixtureState)}
      const unsubscribe = () => () => {}
      let saved
      let delaySave = false
      let releaseSave
      contextBridge.exposeInMainWorld('copilotDesktopSettings', {
        get: async () => state,
        getModelCatalog: async (cli) => cli === 'copilot' ? [{id: 'auto', label: 'Auto', efforts: []}] : [],
        onUpdateStateChanged: unsubscribe, onPreferencesChanged: unsubscribe, onCopilotStateChanged: unsubscribe,
        onMigrationProgress: unsubscribe,
        migrationStatus: async () => ({ recoveryIssues: [], recoveryJournals: [], backups: [], warnings: [], lastImport: null, busy: false, progress: null }),
        usageReport: async () => { throw new Error('Usage is unavailable in this fixture') },
        updateWorkspaceProfile: async (_id, name, _permission, _resume, launch) => {
          if (!name.trim()) throw new Error('Profile name is required')
          if (delaySave) {
            delaySave = false
            await new Promise(resolve => { releaseSave = resolve })
            releaseSave = undefined
          }
          saved = launch
          return state
        },
        lastSavedLaunch: () => saved,
        delayNextSave: () => { delaySave = true },
        isSavePending: () => Boolean(releaseSave),
        finishSave: () => releaseSave(),
      })
    `, 'utf8')
    const fixtureSettings = new BrowserWindow({ show: false, webPreferences: { preload: fixturePreload } })
    fixtureSettings.webContents.on('preload-error', (_event, _path, error) => console.error(error))
    const fixtureUi = async (code) => {
      const result = await fixtureSettings.webContents.executeJavaScript(`(() => {
        try { return { value: (${code}) } } catch (error) { return { error: String(error) } }
      })()`)
      if (result.error) throw new Error(`Settings fixture failed: ${result.error}\n${code}`)
      return result.value
    }
    await fixtureSettings.loadFile(resolve('dist/src/renderer/settings.html'))
    for (let attempt = 0; attempt < 100 && !await fixtureUi('Boolean(document.querySelector(\'option[value="auto"]\'))'); attempt++) await delay(50)
    assert.ok(await fixtureUi('document.querySelector(\'option[value="auto"]\') !== null'), 'fixed Auto catalog reached the built renderer')
    await selectOption(`${copilotGrid} option[value="high"]`, fixtureUi)
    await selectOption(`${copilotGrid} option[value="--custom-model"]`, fixtureUi)
    const customInput = `${copilotGrid} input[maxlength="200"]`
    await fixtureUi(`document.querySelector(${JSON.stringify(customInput)}).focus()`)
    await setInput(customInput, 'auto', fixtureUi)
    await setInput(customInput, 'auto-deployment', fixtureUi)
    await fixtureUi(`document.querySelector(${JSON.stringify(customInput)}).blur()`)
    await clickButton('Save profile', fixtureUi)
    const customLaunch = await fixtureUi('window.copilotDesktopSettings.lastSavedLaunch()')
    assert.equal(customLaunch.model, 'auto-deployment')
    assert.equal(customLaunch.reasoningEffort, 'high', 'typing through Auto must preserve effort for the completed custom model')
    const nameInput = `${copilotGrid} input[maxlength="100"]`
    await setInput(customInput, 'auto', fixtureUi)
    await setInput(nameInput, '', fixtureUi)
    await clickButton('Save profile', fixtureUi)
    assert.match(await fixtureUi('document.body.innerText'), /Profile name is required/)
    await setInput(nameInput, 'project', fixtureUi)
    await setInput(customInput, 'auto-deployment', fixtureUi)
    await clickButton('Save profile', fixtureUi)
    const retriedLaunch = await fixtureUi('window.copilotDesktopSettings.lastSavedLaunch()')
    assert.equal(retriedLaunch.model, 'auto-deployment')
    assert.equal(retriedLaunch.reasoningEffort, 'high', 'a rejected save must preserve effort for the retry')
    await fixtureUi(`document.querySelector(${JSON.stringify(customInput)}).focus()`)
    await setInput(customInput, 'auto', fixtureUi)
    await fixtureUi(`document.querySelector(${JSON.stringify(customInput)}).blur()`)
    await fixtureUi('window.copilotDesktopSettings.delayNextSave()')
    await clickButton('Save profile', fixtureUi)
    assert.ok(await fixtureUi('window.copilotDesktopSettings.isSavePending()'))
    const agentInput = 'input[placeholder="Default agent"]'
    await setInput(agentInput, 'draft-agent', fixtureUi)
    await fixtureUi('window.copilotDesktopSettings.finishSave()')
    const saveIsReady = '[...document.querySelectorAll("button")].some(button => button.textContent === "Save profile" && !button.disabled)'
    for (let attempt = 0; attempt < 100 && !await fixtureUi(saveIsReady); attempt++) await delay(50)
    assert.ok(await fixtureUi(saveIsReady), 'delayed save completed')
    const autoLaunch = await fixtureUi('window.copilotDesktopSettings.lastSavedLaunch()')
    assert.equal(autoLaunch.model, 'auto')
    assert.equal(autoLaunch.reasoningEffort, 'default', 'committing Auto clears an unsupported effort')
    assert.equal(await fixtureUi(`document.querySelector(${JSON.stringify(agentInput)}).value`), 'draft-agent', 'the concurrent agent edit stays in the draft')
    const displayedEffort = await fixtureUi(`[...document.querySelectorAll(${JSON.stringify(copilotGrid + ' > label')})]
      .find(label => label.firstChild.textContent.trim() === 'Reasoning effort').querySelector('select').value`)
    assert.equal(displayedEffort, '', 'the saved effort is reflected despite the unrelated edit')
    fixtureSettings.destroy()
    console.log('OK: custom model typing preserves effort until the completed model is saved')

    app.exit(0)
  }
}
