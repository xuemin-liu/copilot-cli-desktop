// Real app, real CLI, local mock model: a turn in a Git project is snapshotted into the app's data folder, and the
// project's own repository is left exactly as it was.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}

export async function runTurnCheckpointsCheck() {
  await app.whenReady()
  const window = await until(() => BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html')), 'renderer')
  const ui = code => window.webContents.executeJavaScript(code)
  const state = () => ui('window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const userData = app.getPath('userData')
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd, env, ...args) => execFileSync('git', args, { cwd, env: { ...gitEnv, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const source = await until(async () => (await state()).tabs.find(tab => tab.status === 'running' && tab.activity === 'idle'), 'resumed session idle')
    await until(async () => (await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(source.id)})`)).includes('open sidebar'), 'prompt')
    const workspace = (await state()).profiles.find(profile => profile.id === source.workspaceProfileId).path
    const project = (...args) => git(workspace, {}, ...args)
    const fingerprint = async () => JSON.stringify({
      refs: project('for-each-ref'), head: project('rev-parse', 'HEAD'), status: project('status', '--porcelain=v1'), stash: project('stash', 'list'),
      index: (await readFile(join(workspace, '.git', 'index'))).toString('base64'), objects: project('count-objects', '-v'),
    })
    const before = await fingerprint()
    assert.equal(existsSync(join(userData, 'checkpoints')), false, 'nothing is snapshotted before a turn')

    const activity = () => state().then(value => value.tabs.find(tab => tab.id === source.id)?.activity)
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(source.id)}, "Reply with the saved marker.")`)
    await delay(300)
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(source.id)}, "\\r")`)
    await until(async () => await activity() === 'working', 'turn working')
    // The start snapshot is taken while the model is still thinking.
    const meta = async () => {
      const root = join(userData, 'checkpoints')
      for (const name of await readdir(root).catch(() => [])) {
        if (!/^[0-9a-f]{24}$/.test(name)) continue
        try { return { store: join(root, name), ...JSON.parse(await readFile(join(root, name, 'meta.json'), 'utf8')) } } catch { /* being written */ }
      }
      return null
    }
    const turnOf = async () => { const found = await meta(); const turns = found?.sessions?.[source.lastSessionId]?.turns; return turns?.length ? { store: found.store, turn: turns.at(-1), count: turns.length } : null }
    await until(async () => (await turnOf())?.turn.before?.commit, 'start snapshot')
    assert.equal(await activity(), 'working', 'the start snapshot did not wait for the turn to end')
    // What the agent would do: change the project while the turn runs.
    await writeFile(join(workspace, 'agent.txt'), 'written during the turn\r\n')
    await writeFile(join(workspace, 'a.txt'), 'edited during the turn\n')
    await until(async () => await activity() === 'idle', 'turn finished')
    const done = await until(async () => { const found = await turnOf(); return found?.turn.state === 'complete' ? found : null }, 'end snapshot')
    assert.equal(done.count, 1)
    assert.equal(done.turn.label, 'Reply with the saved marker.')
    assert.equal(done.turn.before.reason, null)
    assert.notEqual(done.turn.before.commit, done.turn.after.commit)

    const shadow = (...args) => git(join(done.store, 'empty'), { GIT_DIR: join(done.store, 'git') }, ...args)
    assert.equal(shadow('ls-tree', '-r', '--name-only', done.turn.before.commit).trim(), 'a.txt')
    assert.equal(shadow('cat-file', 'blob', `${done.turn.before.commit}:a.txt`), 'one\n')
    assert.deepEqual(shadow('ls-tree', '-r', '--name-only', done.turn.after.commit).trim().split('\n'), ['a.txt', 'agent.txt'])
    assert.equal(shadow('cat-file', 'blob', `${done.turn.after.commit}:agent.txt`), 'written during the turn\r\n', 'the bytes on disk')
    assert.equal(shadow('diff', '--stat', done.turn.before.commit, done.turn.after.commit).trim().split('\n').at(-1).trim(), '2 files changed, 2 insertions(+), 1 deletion(-)')
    assert.equal(shadow('log', '-1', '--format=%s|%P', done.turn.after.commit).trim(), 'checkpoint|', 'no prompt text and no parent in the commit')

    // The project's repository: only the files the "agent" wrote differ. No ref, object, index or stash change.
    const after = JSON.parse(await fingerprint())
    const was = JSON.parse(before)
    assert.equal(after.status, ' M a.txt\n?? agent.txt\n')
    assert.deepEqual({ ...after, status: '' }, { ...was, status: '' })
    assert.equal(existsSync(join(workspace, '.git', 'refs', 'checkpoints')), false)

    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: source.lastSessionId, cli: (await state()).resolution.version, checks: ['start snapshot while the turn runs', 'end snapshot when idle', 'turn diff of two files', 'bytes on disk', 'project repository untouched'] }, null, 2))
    console.log('[turn-checkpoints] PASS: a real turn was snapshotted in the app data folder and the project repository is untouched')
  } catch (error) {
    await writeFile(join(artifacts, 'failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {})
    console.error('[turn-checkpoints] state', JSON.stringify(await state()).slice(0, 2000))
    throw error
  } finally { app.quit() }
}
