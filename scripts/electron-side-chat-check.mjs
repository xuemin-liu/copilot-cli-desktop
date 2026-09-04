// Manual integrated UI check: real Electron, IPC and CLI, isolated data,
// and a loopback-only mock model. Run after building with:
// node scripts/electron-side-chat-check.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.versions.electron) {
  const { app } = await import('electron')
  assert.ok(process.env.DESKTOP_UI_CHECK_DATA)
  app.setPath('userData', process.env.DESKTOP_UI_CHECK_DATA)
  // Everything else, including IPC and PTY lifecycle, is production code.
  await import('../dist/src/main/main.js')
  if (process.env.DESKTOP_UI_PERMISSION_CHECK === '1') {
    const { runPermissionCheck } = await import('./session-permission-check.mjs')
    void runPermissionCheck().catch((error) => {
      console.error(error)
      process.exitCode = 1
      app.quit()
    })
  }
  if (process.env.DESKTOP_UI_CLIPBOARD_CHECK === '1') {
    const { runClipboardSwitchCheck } = await import('./clipboard-switch-check.mjs')
    void runClipboardSwitchCheck().catch((error) => {
      console.error(error)
      process.exitCode = 1
      app.quit()
    })
  }
} else {
  const { CopilotRpc } = await import('../dist/src/main/copilot-rpc.js')
  const { resolveCopilotBinary } = await import('../dist/src/main/resolve-copilot.js')
  const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
  const resolution = await resolveCopilotBinary()
  assert.ok(resolution.version, 'Install Copilot CLI first')
  const directory = await mkdtemp(join(tmpdir(), 'copilot-electron-check-'))
  const workspace = join(directory, 'workspace')
  const appData = join(directory, 'desktop')
  const copilotHome = join(directory, 'copilot')
  const modelServer = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ id: 'local-ui-check', object: 'chat.completion', created: 1, model: 'ui-check-model', choices: [{ index: 0, message: { role: 'assistant', content: 'The saved marker is desktop-side-chat-42.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  let rpc
  try {
    await Promise.all([workspace, appData, copilotHome].map((path) => mkdir(path)))
    await new Promise((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
    const address = modelServer.address()
    assert.ok(address && typeof address !== 'string')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    const env = { ...process.env, COPILOT_HOME: copilotHome, COPILOT_DISABLE_KEYTAR: '1', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: baseUrl, COPILOT_MODEL: 'ui-check-model', OPENAI_API_KEY: 'local-ui-check-only', COPILOT_OFFLINE: 'true', DESKTOP_UI_CHECK_DATA: appData }
    delete env.ELECTRON_RUN_AS_NODE
    if (process.argv.includes('--permissions')) {
      env.DESKTOP_UI_PERMISSION_CHECK = '1'
      env.DESKTOP_UI_CHECK_ARTIFACTS = join(process.cwd(), 'test-results', 'permissions')
    }
    if (process.argv.includes('--clipboard-switch') || process.argv.includes('--clipboard-multi-click') || process.argv.includes('--clipboard-status')) {
      env.DESKTOP_UI_CLIPBOARD_CHECK = '1'
      const multiClick = process.argv.includes('--clipboard-multi-click')
      const statusCheck = process.argv.includes('--clipboard-status')
      env.DESKTOP_UI_COPY_MULTI_CLICK = multiClick ? '1' : '0'
      env.DESKTOP_UI_COPY_STATUS = statusCheck ? '1' : '0'
      env.DESKTOP_UI_CHECK_ARTIFACTS = process.env.DESKTOP_UI_CHECK_ARTIFACTS || join(process.cwd(), 'test-results', statusCheck ? 'clipboard-status' : multiClick ? 'clipboard-multi-click' : 'clipboard-switch')
    }
    // Trust only this newly-created disposable fixture, never a user folder.
    await writeFile(join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [workspace],
      ...(env.DESKTOP_UI_PERMISSION_CHECK === '1' ? { enabledFeatureFlags: { AUTO_APPROVAL: true } } : {}),
    }))
    rpc = new CopilotRpc(resolution, workspace, env)
    const sessionId = randomUUID()
    const provider = { type: 'openai', baseUrl, apiKey: 'local-ui-check-only', wireApi: 'completions' }
    await rpc.request('session.create', { sessionId, workingDirectory: workspace, availableTools: [], model: 'ui-check-model', provider })
    await rpc.request('session.send', { sessionId, prompt: 'Remember the test marker desktop-side-chat-42.' })
    let ready = false
    for (let index = 0; index < 30; index++) {
      if (JSON.stringify(await rpc.request('session.getMessages', { sessionId })).includes('assistant.message')) { ready = true; break }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    assert.ok(ready, 'Mock model did not finish')
    await rpc.request('session.destroy', { sessionId })
    await rpc.stop()
    const historyPath = join(copilotHome, 'session-state', sessionId, 'events.jsonl')
    const originalHistory = await readFile(historyPath, 'utf8')
    const profile = createWorkspaceProfile(workspace, 'read-only')
    profile.name = 'Isolated Electron test'
    profile.tabs = [{ title: 'Main UI test', lastSessionId: sessionId }]
    await writeDesktopConfig(join(appData, 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id, closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false, provider: { type: 'openai', baseUrl, model: 'ui-check-model', offline: true } })
    const electronPath = (await import('electron')).default
    const child = spawn(electronPath, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: false })
    console.log(`[electron-check] Real app PID ${child.pid}; isolated data: ${directory}`)
    console.log(env.DESKTOP_UI_PERMISSION_CHECK === '1'
      ? '[electron-check] Running session permission regression.'
      : env.DESKTOP_UI_CLIPBOARD_CHECK === '1'
      ? '[electron-check] Running automated clipboard/tab-switch regression.'
      : '[electron-check] Use the Fork into side chat button. Close the app when finished.')
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
    assert.equal(code, 0, 'Electron did not exit normally')
    if (env.DESKTOP_UI_PERMISSION_CHECK === '1') {
      const result = JSON.parse(await readFile(join(env.DESKTOP_UI_CHECK_ARTIFACTS, 'result.json'), 'utf8'))
      assert.equal(result.sourceSessionId, sessionId)
      assert.equal(result.passed, true)
    }
    if (env.DESKTOP_UI_CLIPBOARD_CHECK === '1') {
      const result = JSON.parse(await readFile(join(env.DESKTOP_UI_CHECK_ARTIFACTS, 'result.json'), 'utf8'))
      assert.equal(result.sourceSessionId, sessionId, 'UI result must belong to this run, not an earlier success')
      assert.equal(result.passed, true, 'Clipboard/tab-switch UI regression failed (see test-results/clipboard-switch)')
    }
    const remainingHistory = await readFile(historyPath, 'utf8')
    for (const event of originalHistory.trim().split('\n').map(JSON.parse)) assert.ok(remainingHistory.includes(event.id), 'Original history was changed')
    console.log('[electron-check] App exited cleanly; original conversation preserved.')
  } finally {
    await rpc?.stop()
    modelServer.closeAllConnections()
    await new Promise((resolveClose) => modelServer.close(() => resolveClose()))
    await rm(directory, { recursive: true, force: true })
  }
  process.exit(0)
}
