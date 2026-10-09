// The Git panel in real Electron: the real React panel, the real preload bridge and IPC, a real GitService and real git.
// Drives it with native mouse input against three throwaway repositories and saves a screenshot.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/git-panel')
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const PROFILE = '0123456789abcdef'

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  await build({ stdin: { contents: `
    import { createRoot } from 'react-dom/client';
    import { useState } from 'react';
    import { GitPanel } from './src/renderer/components/GitPanel';
    import './src/renderer/styles.css';
    window.__inserted = [];
    window.addEventListener('copilot-desktop:insert-prompt', event => window.__inserted.push(event.detail));
    function Harness() {
      const [open, setOpen] = useState(true);
      return open
        ? <GitPanel profileId="${PROFILE}" promptTarget={{ id: 'tab-1', title: 'Main session' }} onClose={() => setOpen(false)} />
        : <p id="closed">closed</p>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', jsx: 'automatic', outfile: join(artifacts, 'fixture.js') })
  await writeFile(join(artifacts, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root" style="display:flex;height:100vh;width:100vw"></div><script src="fixture.js"></script></body></html>')
  const directory = await mkdtemp(join(tmpdir(), 'git-panel-check-'))
  const env = { ...process.env, GIT_PANEL_CHECK_DIR: directory, GIT_PANEL_CHECK_ARTIFACTS: artifacts }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 150_000)
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Git panel check failed')
    assert.equal(JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8')).passed, true)
    console.log('Git panel: repositories, changes, diffs, history, trust review, add-to-prompt, live refresh and teardown all work in Electron.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow, Menu, ipcMain } = await import('electron')
  const directory = process.env.GIT_PANEL_CHECK_DIR
  const out = process.env.GIT_PANEL_CHECK_ARTIFACTS
  const workspace = join(directory, 'workspace')
  app.setPath('userData', join(directory, 'userdata'))
  void run().catch(async error => {
    console.error(error)
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error) })).catch(() => {})
    app.exit(1)
  })

  async function run() {
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = Check\n\temail = check@example.com\n[init]\n\tdefaultBranch = main\n')
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const name of ['alpha', 'beta', 'gamma']) {
      const repo = join(workspace, name)
      await mkdir(repo)
      git(repo, 'init', '-q')
      await writeFile(join(repo, 'a.txt'), 'one\n')
      await writeFile(join(repo, 'b.txt'), 'bee\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', `init ${name}`)
    }
    const alpha = join(workspace, 'alpha')
    await writeFile(join(alpha, 'a.txt'), 'one\ntwo\n')              // unstaged change
    await writeFile(join(alpha, 'b.txt'), 'bee\nbuzz\n'); git(alpha, 'add', 'b.txt') // staged change
    await writeFile(join(alpha, 'new.txt'), 'hello\n')               // untracked
    git(join(workspace, 'gamma'), 'config', 'core.sshCommand', 'ssh -i check') // needs review

    const { GitService } = await import('../dist/src/main/git-service.js')
    const { GitRunner, resolveGitExecutable } = await import('../dist/src/main/git-runner.js')
    const { GitTrustStore } = await import('../dist/src/main/git-trust.js')
    const { registerGitIpc } = await import('../dist/src/main/git-ipc.js')
    await app.whenReady()
    Menu.setApplicationMenu(null)
    const executable = await resolveGitExecutable()
    assert.ok(executable, 'git is required')
    let window
    const service = new GitService({
      getRuntime: async () => ({ executable, runner: new GitRunner({ gitPath: executable.path, hooksDirectory: join(directory, 'no-hooks') }) }),
      trustStore: new GitTrustStore(join(directory, 'git-trust.json')),
      resolveProject: id => id === PROFILE ? workspace : null,
      onChanged: (_subscriber, profileId, view) => { if (window && !window.isDestroyed()) window.webContents.send('desktop:git-changed', { profileId, view }) },
      debounceMs: 20, fallbackMs: 120_000,
    })
    window = new BrowserWindow({ width: 460, height: 900, show: false, webPreferences: {
      preload: join(process.cwd(), 'dist', 'src', 'preload', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
    registerGitIpc({ ipcMain, service: () => service, assertTrustedSender: () => undefined, isMainWindowSender: event => event.sender.id === window.webContents.id })
    await window.loadFile(join(out, 'index.html'))

    const ui = code => window.webContents.executeJavaScript(code)
    const until = async (code, label) => {
      const end = Date.now() + 12_000
      while (Date.now() < end) { if (await ui(code)) return; await delay(40) }
      const text = await ui('document.body.innerText.slice(0, 1500)')
      throw new Error(`Timed out: ${label}\n--- panel text ---\n${text}`)
    }
    const text = selector => ui(`(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`)
    const click = async selector => {
      const point = await ui(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing click target: ' + ${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'nearest' });
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`)
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
    const clickByText = async (selector, label) => {
      // Mark exactly one element, clearing any earlier mark, then click it with native input.
      const found = await ui(`(() => {
        for (const old of document.querySelectorAll('[data-click-target]')) old.removeAttribute('data-click-target');
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(candidate => candidate.innerText.includes(${JSON.stringify(label)}));
        if (!element) return false;
        element.setAttribute('data-click-target', '');
        return true;
      })()`)
      assert.ok(found, `no ${selector} containing ${label}`)
      await click('[data-click-target]')
    }
    // A hidden window does not repaint on its own, so a capture would show the previous frame. Paint, then capture.
    const screenshot = async name => {
      await ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      window.webContents.invalidate()
      await delay(250)
      await window.webContents.capturePage().then(image => writeFile(join(out, name), image.toPNG()))
    }
    const results = {}
    await ui('window.focus()')

    // 1. The panel opens on the repository with changes and lists the others.
    await until('!!document.querySelector(".git-repo-selected")', 'repositories listed')
    assert.match(await text('.git-panel-sub'), /3 repositories/)
    assert.match(await text('.git-repo-selected'), /alpha/)
    assert.deepEqual(await ui('[...document.querySelectorAll(".git-repo-name")].map(element => element.innerText)'), ['alpha', 'beta', 'gamma'])
    results.repositories = true

    // 2. Staged, changed and untracked files are grouped.
    await until('!!document.querySelector(".git-group")', 'file groups')
    assert.deepEqual(await ui('[...document.querySelectorAll(".git-group h3")].map(element => element.textContent)'), ['Staged (1)', 'Changes (1)', 'Untracked (1)'])
    results.groups = true

    // 3. A diff appears for a clicked file, coloured by line kind.
    await clickByText('.git-entry', 'a.txt')
    await until('!!document.querySelector(".git-diff-add")', 'diff shown')
    assert.match(await text('.git-diff-lines'), /\+two/)
    assert.equal(await ui('document.querySelectorAll(".git-diff-hunk").length > 0'), true)
    assert.match(await text('.git-diff-side'), /working tree/)
    results.diff = true

    // 4. Add to prompt puts a bounded, fenced diff in the target session's prompt.
    await click('.git-diff-head button')
    await until('window.__inserted.length === 1', 'prompt text inserted')
    const first = await ui('window.__inserted[0]')
    assert.equal(first.tabId, 'tab-1')
    assert.match(first.text, /unstaged change to `a\.txt` in `alpha`/)
    assert.match(first.text, /```diff[\s\S]*\+two[\s\S]*```/)
    assert.ok(first.text.length <= 11_000)
    assert.match(await text('.git-message-info'), /Main session/)
    results.addToPrompt = true

    // 5. Staged and untracked files have their own diffs.
    await clickByText('.git-entry', 'b.txt')
    await until('/buzz/.test(document.querySelector(".git-diff-lines")?.innerText || "")', 'staged diff')
    assert.match(await text('.git-diff-side'), /staged/)
    await clickByText('.git-entry', 'new.txt')
    await until('/\\+hello/.test(document.querySelector(".git-diff-lines")?.innerText || "")', 'untracked diff')
    results.stagedAndUntracked = true

    // 6. Draft commit message builds a prompt from the staged files only.
    await click('.git-actions button')
    await until('window.__inserted.length === 2', 'draft prompt inserted')
    const draft = await ui('window.__inserted[1]')
    assert.match(draft.text, /conventional-commit message/)
    assert.match(draft.text, /### b\.txt/)
    assert.doesNotMatch(draft.text, /### a\.txt/)
    results.draftMessage = true

    // 7. Hostile file contents are shown as text, never as markup.
    await writeFile(join(alpha, 'evil.txt'), '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\n')
    service.requestRefresh(PROFILE)
    await until('[...document.querySelectorAll(".git-entry-name")].some(element => element.innerText === "evil.txt")', 'new file appears without a manual refresh')
    await clickByText('.git-entry', 'evil.txt')
    await until('/onerror/.test(document.querySelector(".git-diff-lines")?.innerText || "")', 'hostile diff shown as text')
    assert.equal(await ui('document.querySelectorAll(".git-diff img, .git-diff script").length'), 0)
    assert.equal(await ui('window.__pwned === undefined'), true)
    results.liveRefreshAndEscaping = true

    // 8. A clean repository, and its history.
    await clickByText('.git-repo', 'beta')
    await until('/clean/i.test(document.querySelector(".git-changes")?.innerText || "")', 'clean repository')
    await clickByText('.git-tabs button', 'History')
    await until('/init beta/.test(document.querySelector(".git-log")?.innerText || "")', 'history listed')
    assert.match(await text('.git-log'), /Check/)
    results.history = true

    // 9. A repository whose config names a program waits for review, and opens after the user trusts it.
    await clickByText('.git-repo', 'gamma')
    await until('!!document.querySelector(".git-review")', 'review card')
    assert.match(await text('.git-review'), /core\.sshcommand/)
    assert.equal(await ui('!!document.querySelector(".git-tabs")'), false, 'nothing of the repository is shown before it is trusted')
    await screenshot('needs-review.png')
    await click('.git-review button')
    await until('!document.querySelector(".git-review") && !!document.querySelector(".git-tabs")', 'trusted repository opens')
    results.trustReview = true

    // 10. Back to alpha for the screenshot, then close: the panel tells the main process to stop.
    await clickByText('.git-repo', 'alpha')
    await clickByText('.git-tabs button', 'Changes')
    await until('[...document.querySelectorAll(".git-entry-name")].some(element => element.innerText === "a.txt")', 'alpha files loaded')
    await clickByText('.git-entry', 'a.txt')
    await until('!!document.querySelector(".git-diff-add")', 'diff for the screenshot')
    await screenshot('panel.png')
    assert.equal(service.hasSubscribers(), true)
    await click('button[aria-label="Close Git panel"]')
    await until('!!document.querySelector("#closed")', 'panel closed')
    const end = Date.now() + 5_000
    while (service.hasSubscribers() && Date.now() < end) await delay(40)
    assert.equal(service.hasSubscribers(), false, 'closing the panel releases the project in the main process')
    results.teardown = true

    await service.dispose()
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, ...results }, null, 2))
    app.quit()
  }
}
