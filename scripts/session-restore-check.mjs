// Real Electron, CLI, PTYs and disk persistence across three app processes.
// Run after npm run build: node scripts/session-restore-check.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const result = await action()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron')
  assert.ok(process.env.DESKTOP_RESTORE_CHECK_DATA)
  app.setPath('userData', process.env.DESKTOP_RESTORE_CHECK_DATA)
  await import('../dist/src/main/main.js')
  // Electron waits for its entry module to finish evaluating before ready.
  void (async () => {
    try {
      await app.whenReady()
      const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'main renderer')
      const ui = code => main.webContents.executeJavaScript(code)
      const expected = JSON.parse(process.env.DESKTOP_RESTORE_CHECK_EXPECTED)
      const state = await until(async () => {
        const current = await ui('window.copilotDesktop.getState()')
        return current.tabs.length === expected.length && current.tabs.every(tab => tab.status === 'running' && tab.activity === 'idle') ? current : null
      }, `${expected.length} restored sessions idle`)
      assert.deepEqual(state.tabs.map(tab => tab.lastSessionId).sort(), expected.map(tab => tab.lastSessionId).sort())
      assert.equal(state.activeProfileId, process.env.DESKTOP_RESTORE_CHECK_ACTIVE)
      assert.equal(state.tabs.find(tab => tab.id === state.activeTabId).workspaceProfileId, state.activeProfileId)
      for (const tab of state.tabs) {
        assert.equal(tab.title, expected.find(entry => entry.lastSessionId === tab.lastSessionId).title)
        await until(async () => {
          const backlog = await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(tab.id)})`)
          return backlog.includes('restart-marker') && backlog.includes('open sidebar')
        }, `conversation and CLI prompt for ${tab.title}`)
      }
      const side = state.tabs.find(tab => tab.sideChat)
      assert.equal(state.tabs.find(tab => tab.id === side.sideParentTabId).lastSessionId, expected[0].lastSessionId)
      if (process.env.DESKTOP_RESTORE_CHECK_PHASE === '1') {
        await ui(`window.copilotDesktop.popOutTab(${JSON.stringify(state.tabs.at(-1).id)})`)
      }
      if (process.env.DESKTOP_RESTORE_CHECK_PHASE === '2') {
        await ui(`window.copilotDesktop.closeTab(${JSON.stringify(state.tabs.at(-1).id)})`)
      }
      await writeFile(join(process.env.DESKTOP_RESTORE_CHECK_DATA, 'result.json'), JSON.stringify({ passed: true, restored: state.tabs.length }))
      console.log(`[restore-check] Phase ${process.env.DESKTOP_RESTORE_CHECK_PHASE}: ${state.tabs.length} real conversations restored; side-chat link and active workspace verified.`)
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    } finally { app.quit() }
  })()
} else {
  const { CopilotRpc } = await import('../dist/src/main/copilot-rpc.js')
  const { resolveCopilotBinary } = await import('../dist/src/main/resolve-copilot.js')
  const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, readDesktopConfig, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
  const resolution = await resolveCopilotBinary()
  assert.ok(resolution.version, 'Install Copilot CLI first')
  const directory = await mkdtemp(join(tmpdir(), 'copilot-restore-check-'))
  const appData = join(directory, 'desktop'), copilotHome = join(directory, 'copilot')
  const workspaces = [join(directory, 'first'), join(directory, 'second')]
  const modelServer = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ id: 'restore-check', object: 'chat.completion', created: 1, model: 'restore-check-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Saved restart-marker.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  let rpc
  try {
    await Promise.all([appData, copilotHome, ...workspaces].map(path => mkdir(path)))
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`
    const env = { ...process.env, COPILOT_HOME: copilotHome, COPILOT_DISABLE_KEYTAR: '1', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: baseUrl, COPILOT_MODEL: 'restore-check-model', OPENAI_API_KEY: 'local-test-only', COPILOT_OFFLINE: 'true', DESKTOP_RESTORE_CHECK_DATA: appData }
    delete env.ELECTRON_RUN_AS_NODE
    await writeFile(join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: workspaces }))
    const profiles = workspaces.map(path => createWorkspaceProfile(path, 'read-only'))
    rpc = new CopilotRpc(resolution, workspaces[0], env)
    const histories = new Map()
    for (let index = 0; index < 4; index++) {
      const profile = profiles[Math.floor(index / 2)]
      const sessionId = randomUUID()
      await rpc.request('session.create', { sessionId, workingDirectory: profile.path, availableTools: [], model: 'restore-check-model', provider: { type: 'openai', baseUrl, apiKey: 'local-test-only', wireApi: 'completions' } })
      await rpc.request('session.send', { sessionId, prompt: `Remember restart-marker ${index}.` })
      await until(async () => JSON.stringify(await rpc.request('session.getMessages', { sessionId })).includes('assistant.message'), 'seed conversation')
      await rpc.request('session.destroy', { sessionId })
      histories.set(sessionId, await readFile(join(copilotHome, 'session-state', sessionId, 'events.jsonl'), 'utf8'))
      profile.tabs.push({ title: `Restore ${index}`, lastSessionId: sessionId, ...(index === 1 ? { sideChat: true, sideParentSessionId: profile.tabs[0].lastSessionId } : {}) })
    }
    await rpc.stop(); rpc = null
    const configPath = join(appData, 'desktop.json')
    await writeDesktopConfig(configPath, { ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles, activeProfileId: profiles[0].id, closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false, provider: { type: 'openai', baseUrl, model: 'restore-check-model', offline: true } })
    const electronPath = (await import('electron')).default
    let expected = profiles.flatMap(profile => profile.tabs)
    for (let phase = 1; phase <= 3; phase++) {
      await writeFile(join(appData, 'result.json'), '{}')
      const child = spawn(electronPath, [fileURLToPath(import.meta.url), '--background'], { env: { ...env, DESKTOP_RESTORE_CHECK_EXPECTED: JSON.stringify(expected), DESKTOP_RESTORE_CHECK_ACTIVE: profiles[0].id, DESKTOP_RESTORE_CHECK_PHASE: String(phase) }, stdio: 'inherit', windowsHide: true })
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
      assert.equal(code, 0, 'Electron must quit cleanly')
      assert.equal(JSON.parse(await readFile(join(appData, 'result.json'), 'utf8')).passed, true)
      if (phase === 2) expected = expected.slice(0, -1)
      const saved = await readDesktopConfig(configPath)
      assert.deepEqual(saved.profiles.flatMap(profile => profile.tabs).map(tab => tab.lastSessionId).sort(), expected.map(tab => tab.lastSessionId).sort())
    }
    for (const [id, original] of histories) {
      const current = await readFile(join(copilotHome, 'session-state', id, 'events.jsonl'), 'utf8')
      for (const event of original.trim().split('\n').map(JSON.parse)) assert.ok(current.includes(event.id), 'Original history must survive restarts')
    }
    console.log('[restore-check] PASS: three clean launches; four sessions retained across restart, explicitly closed tab stays closed, all conversation histories preserved.')
  } finally {
    await rpc?.stop()
    await new Promise(resolve => modelServer.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}
