import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve('test-results/tool-terminal'), delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 120000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timer) }
} else {
  const { app, BrowserWindow } = await import('electron')
  app.setPath('userData', join(out, `userdata-${Date.now()}`))
  void run().catch(error => { console.error(error); app.exit(1) })
  async function run() {
    await app.whenReady()
    const { ProjectToolService } = await import('../dist/src/main/project-tools.js')
    const { prepareBrowserSessionEnvironment } = await import('../dist/src/main/browser-session.js')
    const { terminalCommand } = await import('../dist/src/cli/terminal-control.js')
    const win = new BrowserWindow({ show: false })
    let current = 'tab-1', preset = 'default', tools
    const worktree = join(app.getPath('userData'), 'session-worktree')
    await mkdir(worktree, { recursive: true })
    const projects = new Set(['p1', 'p2'])
    const errors = [], options = { userData: app.getPath('userData'), owner: () => win,
      project: id => projects.has(id) ? { name: id, path: out } : undefined,
      session: id => ['tab-1', 'tab-2'].includes(id) ? { workspaceProfileId: 'p1', status: 'running', sessionPermissionPreset: preset,
        browserProfileId: id === 'tab-1' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
        sessionCwd: id === 'tab-1' ? worktree : out } : undefined,
      currentSession: () => current, defaults: () => ({ shared: false, overrides: 'private' }), browserOptions: () => ({}), changed() {}, error: error => errors.push(String(error)) }
    const until = async (test, label) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await test()) return; await delay(50) } throw new Error(`Timed out: ${label}`) }
    tools = new ProjectToolService(options); tools.showProject('p1')
    try {
      // Deterministic lifecycle barriers: removing a project revokes a held start before it can spawn.
      const removal = new ProjectToolService({ ...options, userData: join(out, `remove-${Date.now()}`) })
      let releaseEnvironment, launches = 0
      const heldEnvironment = new Promise(resolve => { releaseEnvironment = resolve })
      removal.terminalEnvironment = () => heldEnvironment
      removal.terminals = { closeProject() {}, async start() { launches++; return {} }, dispose() {} }
      const creating = removal.terminalAction('p1', { action: 'create', kind: 'local' })
      const removing = removal.removeProject('p1')
      await assert.rejects(removal.terminalAction('p1', { action: 'list' }), /Workspace no longer exists/)
      await assert.rejects(removal.terminalFeature('p1', 'snippets:getAll', []), /Workspace no longer exists/)
      releaseEnvironment({}); await assert.rejects(creating, /closed/); await removing
      assert.equal(launches, 0)
      assert.deepEqual(await removal.terminalAction('p1', { action: 'list' }), [])
      assert.deepEqual(await removal.terminalFeature('p1', 'snippets:getAll', []), [])
      await removal.dispose()
      // Restart must not kill the process whose initial spawn is still pending.
      const { ToolTerminals } = await import('../dist/src/main/tool-terminal.js')
      const starting = new ProjectToolService({ ...options, userData: join(out, `start-${Date.now()}`) })
      starting.terminalEnvironment = async () => ({})
      let releaseSpawn, reachedSpawn, kills = 0
      const spawnReached = new Promise(resolve => { reachedSpawn = resolve })
      starting.terminals = new ToolTerminals(() => new Promise(resolve => { releaseSpawn = resolve; reachedSpawn() }))
      const creatingSlow = starting.terminalAction('p1', { action: 'create', kind: 'local' })
      await spawnReached
      const slowId = starting.state().projects[0].tabs[0].id
      await assert.rejects(starting.terminalAction('p1', { action: 'restart', id: slowId }), /still starting/)
      assert.equal(kills, 0)
      releaseSpawn({ pid: 0, onData() {}, onExit() {}, write() {}, resize() {}, kill() { kills++ }, dispose() {} })
      assert.equal((await creatingSlow).status, 'running'); await starting.dispose()
      const env = await prepareBrowserSessionEnvironment(join(out, `sessions-${Date.now()}`), 'tab-1', process.env)
      await tools.startBridge('tab-1', 'p1', env.COPILOT_DESKTOP_BROWSER_STATE)
      const endpoint = JSON.parse(await readFile(env.COPILOT_DESKTOP_BROWSER_STATE, 'utf8'))
      const call = async (body, status = 200) => {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}/terminal`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify(body) })
        const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result
      }
      assert.deepEqual(await call({ action: 'list' }), []) // No browser page is needed.
      preset = 'read-only'; await call({ action: 'create', kind: 'local' }, 409); preset = 'default'
      const first = await call({ action: 'create', kind: 'local' }), second = await call({ action: 'create', kind: 'local' })
      assert.equal(first.status, 'running'); assert.equal(second.status, 'running'); assert.notEqual(first.pid, second.pid)
      // Upstream broadcast routing reaches only connected parent terminals in the shown project.
      await tools.action('p1', { type: 'select', id: first.id })
      await tools.action('p1', { type: 'broadcast', enabled: true })
      const broadcastCommand = process.platform === 'win32' ? "Write-Output ('BROADCAST_' + 'OK')\r" : "printf 'BROADCAST_%s\\n' OK\r"
      assert.deepEqual((await call({ action: 'broadcast', id: first.id, text: broadcastCommand })).delivered.sort(), [first.id, second.id].sort())
      for (const id of [first.id, second.id]) await until(async () => (await call({ action: 'read', id })).output.includes('BROADCAST_OK'), 'broadcast reaches both real shells')
      await call({ action: 'broadcast', id: second.id, text: 'WRONG' }, 409)
      await tools.action('p1', { type: 'visible', visible: false })
      await call({ action: 'broadcast', id: first.id, text: 'WRONG' }, 409)
      await tools.action('p1', { type: 'visible', visible: true })
      assert.equal(tools.state().projects[0].broadcast, false)
      await tools.action('p1', { type: 'broadcast', enabled: true }); tools.showProject('p2'); tools.showProject('p1')
      assert.equal(tools.state().projects[0].broadcast, false)
      await tools.action('p1', { type: 'metadata', id: first.id, label: 'Build shell', color: '#58a6ff' })
      await tools.action('p1', { type: 'reorder', id: first.id, beforeId: second.id })
      await tools.writing
      const metadataRestored = new ProjectToolService(options)
      const restoredProject = metadataRestored.state().projects.find(project => project.profileId === 'p1')
      assert.equal(restoredProject.tabs[1].id, first.id); assert.equal(restoredProject.tabs[1].label, 'Build shell'); assert.equal(restoredProject.tabs[1].color, '#58a6ff')
      assert.ok(!restoredProject.broadcast); await metadataRestored.dispose()
      const command = process.platform === 'win32' ? "Write-Output ('TERMINAL_' + 'ONE'); (Get-Location).Path\r" : "printf 'TERMINAL_%s\\n' ONE; pwd\r"
      await call({ action: 'write', id: first.id, text: command })
      await until(async () => (await call({ action: 'read', id: first.id })).output.includes('TERMINAL_ONE'), 'real PTY command output')
      const output = await call({ action: 'read', id: first.id }); assert.ok(output.output.includes(worktree)); assert.ok(!(await call({ action: 'read', id: second.id })).output.includes('TERMINAL_ONE'))
      const shellHelperCommand = process.platform === 'win32' ? '& $env:COPILOT_DESKTOP_TERMINAL_HELPER list\r' : 'sh "$COPILOT_DESKTOP_TERMINAL_HELPER" list\r'
      await call({ action: 'write', id: first.id, text: shellHelperCommand })
      await until(async () => (await call({ action: 'read', id: first.id })).output.includes(second.id), 'terminal shell calling terminal helper')
      const helper = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', env.COPILOT_DESKTOP_TERMINAL_HELPER, 'list']] : ['sh', [env.COPILOT_DESKTOP_TERMINAL_HELPER, 'list']]
      const helperResult = await promisify(execFile)(helper[0], helper[1], { env, windowsHide: true })
      assert.ok(helperResult.stdout.includes(first.id), 'CLI session helper lists terminal')
      process.env.COPILOT_DESKTOP_TERMINAL_STATE = env.COPILOT_DESKTOP_TERMINAL_STATE
      assert.equal((await terminalCommand(['list'])).length, 2)
      await tools.action('p1', { type: 'visible', visible: false })
      assert.equal((await call({ action: 'read', id: first.id })).pid, first.pid, 'hiding preserves PTY')
      current = 'tab-2'; tools.refreshConnections()
      assert.equal((await call({ action: 'read', id: first.id })).pid, first.pid)
      const ownedByB = await tools.terminalAction('p1', { action: 'create', kind: 'local' })
      await call({ action: 'write', id: ownedByB.id, text: 'WRONG' }, 409)
      assert.ok(!(await call({ action: 'list' })).some(tab => tab.id === ownedByB.id))
      await tools.action('p1', { type: 'promote', id: ownedByB.id })
      await call({ action: 'read', id: ownedByB.id }, 409)
      current = 'tab-1'
      // A request whose body is still arriving loses authority when the active session changes.
      let responseDone
      const lateResponse = new Promise(resolve => { responseDone = resolve })
      const request = httpRequest({ hostname: '127.0.0.1', port: endpoint.port, path: '/terminal', method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` } }, response => { response.resume(); response.on('end', () => responseDone(response.statusCode)) })
      request.write('{"action":"write",'); await delay(30); current = 'tab-2'; request.end(`"id":"${ownedByB.id}","text":"WRONG"}`)
      assert.equal(await lateResponse, 409); current = 'tab-1'
      await call({ action: 'close', id: ownedByB.id })
      await tools.action('p2', { type: 'add', kind: 'local' })
      const foreign = tools.state().projects.find(project => project.profileId === 'p2').tabs[0]
      await call({ action: 'read', id: foreign.id }, 409)
      await call({ action: 'restart', id: first.id })
      const fresh = await call({ action: 'read', id: first.id, cursor: output.cursor, generation: output.generation })
      assert.notEqual(fresh.generation, output.generation)
      await call({ action: 'close', id: second.id }); await call({ action: 'read', id: second.id }, 409)
      await until(() => { try { process.kill(second.pid, 0); return false } catch { return true } }, 'closed PTY process exits')
      if (process.argv.includes('--wsl') && process.platform === 'win32') {
        const wsl = await call({ action: 'create', kind: 'wsl', config: { distro: 'Ubuntu' } })
        assert.equal(wsl.status, 'running')
        await call({ action: 'write', id: wsl.id, text: 'sh "$COPILOT_DESKTOP_TERMINAL_HELPER" list\r' })
        await until(async () => (await call({ action: 'read', id: wsl.id })).output.includes(first.id), 'real WSL shell helper calls Windows bridge')
        await call({ action: 'close', id: wsl.id })
        console.log('WSL Ubuntu terminal and helper check passed.')
      }
      await tools.terminalFeature('p2', 'snippets:save', [{ id: 'retention', name: 'example', command: 'echo example' }])
      const defaultLog = await tools.terminalFeature('p2', 'logging:start', [foreign.id, ''])
      const dataDirectory = dirname(dirname(defaultLog.filePath))
      await stat(join(dataDirectory, 'myterminal.json'))
      await tools.terminalFeature('p2', 'logging:stop', [foreign.id])
      const customLog = await tools.terminalFeature('p2', 'logging:start', [foreign.id, join(out, 'custom-logs')])
      projects.delete('p2')
      await tools.removeProject('p2')
      await assert.rejects(stat(dataDirectory), { code: 'ENOENT' })
      await stat(customLog.filePath)
      await assert.rejects(tools.terminalFeature('p2', 'snippets:getAll', []), /Workspace no longer exists/)
      await assert.rejects(tools.terminalAction('p2', { action: 'list' }), /Workspace no longer exists/)
      projects.add('p2') // Re-adding the same folder reuses its workspace ID.
      assert.deepEqual(await tools.terminalFeature('p2', 'snippets:getAll', []), [])
      assert.deepEqual(await tools.terminalAction('p2', { action: 'list' }), [])
      await assert.rejects(tools.terminalAction('p2', { action: 'read', id: foreign.id }), /does not belong/)
      const readded = await tools.terminalAction('p2', { action: 'create', kind: 'local' })
      assert.equal(readded.status, 'running'); assert.notEqual(readded.id, foreign.id)
      await tools.terminalAction('p2', { action: 'write', id: readded.id, text: process.platform === 'win32' ? "Write-Output ('READDED_' + 'OK')\r" : "printf 'READDED_%s\\n' OK\r" })
      await until(async () => (await tools.terminalAction('p2', { action: 'read', id: readded.id })).output.includes('READDED_OK'), 're-added workspace shell runs')
      await tools.terminalFeature('p2', 'snippets:save', [{ id: 'fresh', name: 'fresh', command: 'echo fresh' }])
      assert.equal((await tools.terminalFeature('p2', 'snippets:getAll', []))[0].id, 'fresh')
      projects.delete('p2'); await tools.removeProject('p2')
      await tools.dispose()
      tools = new ProjectToolService(options)
      const restored = await tools.terminalAction('p1', { action: 'list' })
      assert.equal(restored.length, 1); assert.equal(restored[0].status, 'disconnected', 'restoring tabs never auto-connects shells')
      assert.deepEqual(errors, [])
      await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, checks: ['native PTY input/output', 'project cwd', 'explicit terminal IDs', 'session helper', 'terminal-shell helper', 'CLI command', 'no Browser required', 'hidden PTYs survive', 'background owner retained', 'in-flight revocation', 'cross-project rejection', 'restart generation', 'close', 'disconnected restoration'] }, null, 2))
      console.log('Terminal native bridge check passed.')
    } finally { await tools.dispose(); win.destroy(); app.quit() }
  }
}
