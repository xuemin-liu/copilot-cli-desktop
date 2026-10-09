// The Git panel in real Electron: the real React panel, the real preload bridge and IPC, a real GitService and real git.
// Drives it with native mouse input against three throwaway repositories and saves a screenshot.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
    // A second setting hides a command behind 220 spaces: the review card must show all of it.
    git(join(workspace, 'gamma'), 'config', 'filter.review.clean', `cat${' '.repeat(220)}; echo HIDDEN-COMMAND > review-marker.txt`)

    // delta: 120 commits for history paging, and 31 staged files for the commit-message prompt.
    const delta = join(workspace, 'delta')
    await mkdir(delta)
    git(delta, 'init', '-q')
    let stream = ''
    for (let index = 1; index <= 120; index++) {
      const message = `commit ${index}`
      stream += `commit refs/heads/main\ncommitter Check <check@example.com> ${1_700_000_000 + index} +0000\ndata ${message.length}\n${message}\n${index === 1 ? 'M 100644 inline base.txt\ndata 5\nbase\n' : ''}\n`
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: delta, env: process.env, input: stream })
    git(delta, 'reset', '-q', '--hard', 'main')
    for (let index = 0; index < 31; index++) await writeFile(join(delta, `extra-${index}.txt`), `extra ${index}\n`)
    git(delta, 'add', '.')

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
      onProgress: (_subscriber, profileId, event) => { if (window && !window.isDestroyed()) window.webContents.send('desktop:git-progress', { profileId, event }) },
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
      // A missing target is reported as a value, with what the panel was showing, so a failure says where it stopped.
      const point = await ui(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return { missing: document.body.innerText.slice(0, 1200) };
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`)
      if (point.missing !== undefined) throw new Error(`No click target ${selector}. The panel showed:
${point.missing}`)
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
    assert.match(await text('.git-panel-sub'), /4 repositories/)
    assert.match(await text('.git-repo-selected'), /alpha/)
    assert.deepEqual(await ui('[...document.querySelectorAll(".git-repo-name")].map(element => element.innerText)'), ['alpha', 'beta', 'delta', 'gamma'])
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
    await clickByText('.git-commit-row button', 'Draft with Copilot')
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
    // Trust accepts the whole value, so the card shows the whole value: the command after the padding is on screen.
    const card = await ui('document.querySelector(".git-review").textContent')
    assert.match(card, /HIDDEN-COMMAND > review-marker\.txt/)
    assert.match(card, /⟦220 spaces⟧/)
    assert.doesNotMatch(card, /cat…/)
    assert.equal(await ui('!!document.querySelector(".git-tabs")'), false, 'nothing of the repository is shown before it is trusted')
    await screenshot('needs-review.png')
    await click('.git-review button')
    await until('!document.querySelector(".git-review") && !!document.querySelector(".git-tabs")', 'trusted repository opens')
    results.trustReview = true

    // 9b. History pages without overlap, even when "Load more" is clicked twice while a page is still loading.
    const realGetLog = service.getLog.bind(service)
    service.getLog = async (...args) => { await delay(900); return realGetLog(...args) }
    await clickByText('.git-repo', 'delta')
    await until('!!document.querySelector(".git-tabs")', 'delta opens')
    await clickByText('.git-tabs button', 'History')
    await until('document.querySelectorAll(".git-log li").length === 50', 'first page of history')
    await click('.git-history > button')
    await until('document.querySelector(".git-history > button")?.disabled === true', 'Load more is disabled while the page loads')
    assert.match(await text('.git-history > button'), /Loading/)
    await click('.git-history > button')
    await until('document.querySelectorAll(".git-log li").length >= 100', 'second page appended')
    await delay(1600)
    const hashes = () => ui('[...document.querySelectorAll(".git-log-meta code")].map(element => element.innerText)')
    let seen = await hashes()
    assert.equal(seen.length, 100, 'two quick clicks append one page, not two')
    assert.equal(new Set(seen).size, 100, 'no commit is listed twice')
    await click('.git-history > button')
    await until('document.querySelectorAll(".git-log li").length === 120', 'last page appended')
    seen = await hashes()
    assert.equal(new Set(seen).size, 120, 'every commit is listed exactly once and none is skipped')
    assert.equal(await ui('!document.querySelector(".git-history > button")'), true, 'no Load more once the history is complete')
    service.getLog = realGetLog
    results.historyPaging = true

    // 9c. The commit-message prompt accounts for every staged file, including those whose diffs were not read.
    await clickByText('.git-tabs button', 'Changes')
    await until('/Staged \\(31\\)/.test(document.body.textContent)', 'delta staged files')
    const insertedBefore = await ui('window.__inserted.length')
    await clickByText('.git-commit-row button', 'Draft with Copilot')
    await until(`window.__inserted.length === ${insertedBefore + 1}`, 'draft prompt for delta')
    const stagedDraft = (await ui('window.__inserted.at(-1)')).text
    const headings = (stagedDraft.match(/^### /gm) ?? []).length
    const stated = Number(/(\d+) more staged files? not shown/.exec(stagedDraft)?.[1] ?? 0)
    assert.equal(headings + stated, 31, `${headings} diffs shown + ${stated} stated omitted must be all 31`)
    assert.ok(stagedDraft.includes('extra-30.txt'), 'the last staged file appears in the prompt')
    assert.ok(stagedDraft.length <= 11_000)
    results.draftAccountsForEveryFile = true

    // 10. Back to alpha for the screenshot, then close: the panel tells the main process to stop.
    await clickByText('.git-repo', 'alpha')
    await clickByText('.git-tabs button', 'Changes')
    await until('[...document.querySelectorAll(".git-entry-name")].some(element => element.innerText === "a.txt")', 'alpha files loaded')
    await clickByText('.git-entry', 'a.txt')
    await until('!!document.querySelector(".git-diff-add")', 'diff for the screenshot')
    await screenshot('panel.png')

    // 11. Stage and unstage with the row buttons, and "Stage all", against the real repository.
    const slash = String.fromCharCode(92)
    const forwardSlashes = path => path.split(slash).join('/')
    const groups = () => ui('[...document.querySelectorAll(".git-group h3")].map(element => element.textContent)')
    const gitIn = (...args) => git(alpha, ...args)
    await click('button[aria-label="Stage a.txt"]')
    await until('/Staged \\(2\\)/.test(document.body.textContent)', 'a.txt staged')
    assert.match(gitIn('status', '--porcelain'), /^M[ M] a\.txt$/m, 'the real index changed')
    await click('button[aria-label="Unstage a.txt"]')
    await until('/Staged \\(1\\)/.test(document.body.textContent) && /Changes \\(1\\)/.test(document.body.textContent)', 'a.txt unstaged again')
    assert.equal(await ui('document.body.textContent.includes("Mark resolved")'), false)
    const untrackedGroup = await ui('[...document.querySelectorAll(".git-group")].find(group => group.getAttribute("aria-label") === "Untracked").querySelector(".git-group-action").textContent')
    assert.equal(untrackedGroup, 'Stage all')
    await ui('(() => { const group = [...document.querySelectorAll(".git-group")].find(candidate => candidate.getAttribute("aria-label") === "Untracked"); group.querySelector(".git-group-action").setAttribute("data-pick", "") })()')
    await click('[data-pick]')
    await until('/Staged \\(3\\)/.test(document.body.textContent) && !/Untracked/.test(document.body.textContent)', 'stage all untracked')
    assert.deepEqual((await groups()).map(title => title.replace(/ \(\d+\)/, '')), ['Staged', 'Changes'])
    results.stageAndUnstage = true

    // 12. Type a message and commit; the real repository gets exactly that commit.
    await ui('document.querySelector(".git-commit textarea").focus()')
    window.webContents.insertText('feat: committed from the panel')
    await until('document.querySelector(".git-commit textarea").value === "feat: committed from the panel"', 'message typed')
    await screenshot('commit-box.png')
    const headBefore = gitIn('rev-parse', 'HEAD').trim()
    await click('.git-commit-button')
    await until('/Committed [0-9a-f]{7}: feat: committed from the panel/.test(document.querySelector(".git-message-info")?.innerText || "")', 'commit reported')
    assert.equal(gitIn('log', '-1', '--format=%s').trim(), 'feat: committed from the panel')
    assert.notEqual(gitIn('rev-parse', 'HEAD').trim(), headBefore)
    assert.equal(await ui('document.querySelector(".git-commit textarea")?.value ?? ""'), '', 'the message box is cleared')
    assert.equal(gitIn('diff', '--cached', '--name-only').trim(), '', 'nothing is left staged')
    results.commit = true

    // 13. A repository hook needs approval first, then runs; a slow hook can be cancelled.
    const hookPath = join(alpha, '.git', 'hooks', 'pre-commit')
    const marker = join(directory, 'hook-ran.txt')
    await mkdir(join(alpha, '.git', 'hooks'), { recursive: true })
    await writeFile(hookPath, `#!/bin/sh\necho "hook says hi" >&2\necho ran > "${forwardSlashes(marker)}"\n`)
    await writeFile(join(alpha, 'hooked.txt'), 'x\n')
    service.requestRefresh(PROFILE)
    await until('[...document.querySelectorAll(".git-entry-name")].some(element => element.innerText === "hooked.txt")', 'new file listed')
    await click('button[aria-label="Stage hooked.txt"]')
    await until('/Staged \\(1\\)/.test(document.body.textContent)', 'hooked.txt staged')
    await ui('document.querySelector(".git-commit textarea").focus()')
    window.webContents.insertText('chore: through a hook')
    await until('document.querySelector(".git-commit textarea").value === "chore: through a hook"', 'second message typed')
    await click('.git-commit-button')
    await until('!!document.querySelector(".git-hooks")', 'hook approval requested')
    assert.match(await text('.git-hooks'), /pre-commit/)
    assert.equal(existsSync(marker), false, 'nothing ran before approval')
    await screenshot('hooks-approval.png')
    await clickByText('.git-hooks button', 'Allow these hooks')
    await until('/Committed/.test(document.querySelector(".git-message-info")?.innerText || "")', 'committed after approval')
    assert.equal(existsSync(marker), true, 'the approved hook ran')
    assert.equal(gitIn('log', '-1', '--format=%s').trim(), 'chore: through a hook')

    await writeFile(hookPath, '#!/bin/sh\necho "slow hook started"\nsleep 30\n')
    await writeFile(join(alpha, 'slow.txt'), 'x\n')
    service.requestRefresh(PROFILE)
    await until('[...document.querySelectorAll(".git-entry-name")].some(element => element.innerText === "slow.txt")', 'slow.txt listed')
    await click('button[aria-label="Stage slow.txt"]')
    await until('/Staged \\(1\\)/.test(document.body.textContent)', 'slow.txt staged')
    await ui('document.querySelector(".git-commit textarea").focus()')
    window.webContents.insertText('chore: never finishes')
    await until('document.querySelector(".git-commit textarea").value === "chore: never finishes"', 'third message typed')
    await click('.git-commit-button')
    await until('!!document.querySelector(".git-hooks")', 'the changed hook is a new question')
    await clickByText('.git-hooks button', 'Allow these hooks')
    await until('/slow hook started/.test(document.querySelector(".git-progress")?.innerText || "")', 'the hook output streams into the panel')
    assert.match(await text('.git-commit-button'), /Committing/)
    const headBeforeCancel = gitIn('rev-parse', 'HEAD').trim()
    await clickByText('.git-commit-row button', 'Cancel')
    await until('/Cancelled/.test(document.querySelector(".git-message-error")?.innerText || "")', 'cancelled')
    assert.equal(gitIn('rev-parse', 'HEAD').trim(), headBeforeCancel, 'no commit was made')
    assert.equal(existsSync(join(alpha, '.git', 'index.lock')), false, 'cancelling during a hook leaves no lock behind')
    assert.equal(await ui('!!document.querySelector(".git-commit textarea")?.value'), true, 'the message is kept for another try')
    await screenshot('cancelled.png')
    results.hooksAndCancel = true
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
