// Real Electron, real preload bridge and real git: the Git panel's main-process service end to end.
// Boots the production main process with an isolated userData folder and no session, then drives
// window.copilotDesktop.git* from the main window the way the panel will.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/git-ipc')

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const directory = await mkdtemp(join(tmpdir(), 'git-ipc-check-'))
  const env = { ...process.env, GIT_IPC_CHECK_DIR: directory, GIT_IPC_CHECK_ARTIFACTS: artifacts }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 120_000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Git IPC check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
    console.log('Git IPC: discovery, status, diff, log, trust gate, main-window-only and teardown on reload all work through the real bridge.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.env.GIT_IPC_CHECK_DIR
  const appData = join(directory, 'desktop')
  const workspace = join(directory, 'workspace')
  app.setPath('userData', appData)
  // Do not await app readiness at module scope: Electron waits for ESM evaluation before emitting ready.
  void run().catch(async error => {
    console.error(error)
    await writeFile(join(process.env.GIT_IPC_CHECK_ARTIFACTS, 'result.json'), JSON.stringify({ passed: false, error: String(error) })).catch(() => {})
    app.exit(1)
  })

  async function run() {
    const isolated = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'gitconfig') }
    await mkdir(workspace, { recursive: true })
    await mkdir(appData, { recursive: true })
    await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = Check\n\temail = check@example.com\n[init]\n\tdefaultBranch = main\n')
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: isolated, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const name of ['alpha', 'beta', 'gamma']) {
      await mkdir(join(workspace, name))
      git(join(workspace, name), 'init', '-q')
      await writeFile(join(workspace, name, 'a.txt'), 'one\n')
      git(join(workspace, name), 'add', '.')
      git(join(workspace, name), 'commit', '-q', '-m', `init ${name}`)
    }
    // gamma names a program in its own config, so it must wait for review.
    git(join(workspace, 'gamma'), 'config', 'core.sshCommand', 'ssh -i check')

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const profile = createWorkspaceProfile(workspace)
    // No active profile: the app shows its welcome screen and starts no session.
    await writeDesktopConfig(join(appData, 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: null, closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })

    // Git for the main process comes from PATH-independent resolution; give it the isolated config too.
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
    await import('../dist/src/main/main.js')
    await app.whenReady()
    let main
    for (let attempt = 0; attempt < 100 && !main; attempt++) {
      main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html'))
      if (!main) await new Promise(accept => setTimeout(accept, 100))
    }
    assert.ok(main, 'main window did not load')
    await new Promise(accept => main.webContents.isLoading() ? main.webContents.once('did-finish-load', accept) : accept())
    const inPage = (code) => main.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
    const rejects = async (code, pattern) => {
      const message = await inPage(`try { ${code}; return null } catch (error) { return String(error && error.message || error) }`)
      assert.ok(message && pattern.test(message), `expected /${pattern.source}/ but got ${JSON.stringify(message)}`)
    }
    const results = {}

    assert.equal(await inPage('return typeof window.copilotDesktop.gitOpen'), 'function')
    await inPage(`window.__gitEvents = []; window.__off = window.copilotDesktop.onGitChanged(payload => window.__gitEvents.push(payload))`)

    // Discovery and status through the real bridge.
    const view = await inPage(`return await window.copilotDesktop.gitOpen(${JSON.stringify(profile.id)})`)
    assert.equal(view.git.available, true, JSON.stringify(view.git))
    assert.deepEqual(view.repos.map(repo => [repo.relativePath, repo.state]), [['alpha', 'ready'], ['beta', 'ready'], ['gamma', 'needs-review']])
    const [alpha, , gamma] = view.repos
    results.discovery = true

    // The trust gate: gamma is listed with its reason, and nothing reads it until trusted.
    assert.deepEqual(gamma.reviewItems.map(item => item.key), ['core.sshcommand'])
    await rejects(`await window.copilotDesktop.gitDiff(${JSON.stringify(profile.id)}, ${JSON.stringify(gamma.id)}, 'e1-0', false)`, /not available/)
    const trusted = await inPage(`return await window.copilotDesktop.gitTrust(${JSON.stringify(profile.id)}, ${JSON.stringify(gamma.id)}, ${JSON.stringify(gamma.configHash)})`)
    assert.equal(trusted.repos.find(repo => repo.id === gamma.id).state, 'ready')
    assert.ok(existsSync(join(appData, 'git-trust.json')), 'the trust decision is saved')
    results.trustGate = true

    // Edit, then see the change through status, a pushed event and a diff.
    await writeFile(join(workspace, 'alpha', 'a.txt'), 'one\ntwo\n')
    await writeFile(join(workspace, 'alpha', 'new.txt'), 'hello\n')
    const status = await inPage(`return await window.copilotDesktop.gitStatus(${JSON.stringify(profile.id)}, ${JSON.stringify(alpha.id)})`)
    assert.deepEqual(status.unstaged.map(entry => entry.path), ['a.txt'])
    assert.deepEqual(status.untracked.map(entry => entry.path), ['new.txt'])
    const diff = await inPage(`return await window.copilotDesktop.gitDiff(${JSON.stringify(profile.id)}, ${JSON.stringify(alpha.id)}, ${JSON.stringify(status.unstaged[0].id)}, false)`)
    assert.equal(diff.kind, 'text')
    assert.match(diff.text, /^\+two$/m)
    const untracked = await inPage(`return await window.copilotDesktop.gitDiff(${JSON.stringify(profile.id)}, ${JSON.stringify(alpha.id)}, ${JSON.stringify(status.untracked[0].id)}, false)`)
    assert.match(untracked.text, /^\+hello$/m)
    const log = await inPage(`return await window.copilotDesktop.gitLog(${JSON.stringify(profile.id)}, ${JSON.stringify(alpha.id)}, 5, 0)`)
    assert.deepEqual(log.map(entry => entry.subject), ['init alpha'])
    const pushed = await inPage(`return window.__gitEvents.map(event => ({ profileId: event.profileId, counts: event.view.repos.map(repo => repo.changeCount) }))`)
    assert.ok(pushed.some(event => event.profileId === profile.id && event.counts[0] === 2), `no change event reached the renderer: ${JSON.stringify(pushed)}`)
    results.statusDiffLogAndEvent = true

    // Bad input never reaches git.
    await rejects(`await window.copilotDesktop.gitStatus('not-a-profile', 'repo-1')`, /Invalid workspace/)
    await rejects(`await window.copilotDesktop.gitStatus(${JSON.stringify(profile.id)}, '..\\\\repo-1')`, /Invalid repository/)
    await rejects(`await window.copilotDesktop.gitDiff(${JSON.stringify(profile.id)}, ${JSON.stringify(alpha.id)}, 'e1-1; calc', false)`, /Invalid file/)
    results.validation = true

    // Only the main window may use the channels: a second window with the same shell is refused.
    const other = new BrowserWindow({ show: false, webPreferences: { preload: join(process.cwd(), 'dist', 'src', 'preload', 'preload.cjs'), contextIsolation: true, sandbox: true } })
    await other.loadFile(join(process.cwd(), 'dist', 'src', 'renderer', 'index.html'))
    const otherMessage = await other.webContents.executeJavaScript(`window.copilotDesktop.gitOpen(${JSON.stringify(profile.id)}).then(() => 'allowed', error => String(error.message))`)
    assert.match(otherMessage, /main window/, otherMessage)
    other.destroy()
    results.mainWindowOnly = true

    // A reload drops the subscription; the next call must open again.
    await new Promise(accept => { main.webContents.once('did-finish-load', accept); main.webContents.reload() })
    await rejects(`await window.copilotDesktop.gitStatus(${JSON.stringify(profile.id)}, ${JSON.stringify(alpha.id)})`, /Open the Git panel/)
    const reopened = await inPage(`return await window.copilotDesktop.gitOpen(${JSON.stringify(profile.id)})`)
    assert.equal(reopened.repos.length, 3)
    assert.equal(reopened.repos.find(repo => repo.relativePath === 'gamma').state, 'ready', 'the trust decision survives a reload')
    results.reloadTeardown = true

    // Ctrl+Shift+G reaches the page as a toggle, handled in the main process before the page sees the key. Near misses do not.
    await inPage(`window.__toggles = 0; window.__offToggle = window.copilotDesktop.onGitToggle(() => { window.__toggles++ })`)
    const press = (keyCode, modifiers) => { main.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); main.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }) }
    press('G', ['control', 'shift'])
    for (let attempt = 0; attempt < 50 && await inPage('return window.__toggles') < 1; attempt++) await new Promise(accept => setTimeout(accept, 50))
    assert.equal(await inPage('return window.__toggles'), 1, 'Ctrl+Shift+G toggles the Git panel')
    press('G', ['control'])
    press('H', ['control', 'shift'])
    press('G', ['shift'])
    await new Promise(accept => setTimeout(accept, 300))
    assert.equal(await inPage('return window.__toggles'), 1, 'Ctrl+G, Ctrl+Shift+H and Shift+G do not')
    results.shortcut = true

    await writeFile(join(process.env.GIT_IPC_CHECK_ARTIFACTS, 'result.json'), JSON.stringify({ passed: true, ...results }, null, 2))
    app.quit()
  }
}
