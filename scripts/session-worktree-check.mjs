// A fresh worktree session in the real app: the real CLI creates the worktree and picks the session id; the desktop
// must learn that id from the session store and start monitoring it. Isolated data, loopback mock model.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await delay(200) }
  throw new Error(`Timed out: ${label}`)
}
export async function runWorktreeCheck() {
  await app.whenReady()
  const window = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'renderer')
  const ui = code => window.webContents.executeJavaScript(code)
  const state = () => ui('window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async name => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const initial = await state()
    const profileId = initial.activeProfileId
    const before = new Set(initial.tabs.map(tab => tab.id))
    const created = await ui(`window.copilotDesktop.createTab(null, ${JSON.stringify(profileId)})`)
    const createdId = created.tabs.find(tab => !before.has(tab.id))?.id
    assert.ok(createdId, 'a tab was created')
    const running = await until(async () => (await state()).tabs.find(tab => tab.id === createdId && tab.status === 'running'), 'worktree session running')
    assert.equal(running.lastSessionId, null, 'the desktop could not choose the id')
    // The real CLI creates the worktree and writes its own session id; the desktop reads it back from the store.
    const known = await until(async () => { const tab = (await state()).tabs.find(tab => tab.id === running.id); return tab?.lastSessionId ? tab : null }, 'session id discovered from the store', 90_000)
    assert.match(known.lastSessionId, /^[0-9a-f-]{36}$/)
    const events = await readFile(join(process.env.COPILOT_HOME, 'session-state', known.lastSessionId, 'events.jsonl'), 'utf8')
    const start = JSON.parse(events.split('\n')[0])
    assert.equal(start.type, 'session.start')
    const cwd = start.data?.context?.cwd ?? ''
    const workspace = initial.profiles.find(profile => profile.id === profileId).path
    assert.notEqual(cwd.toLowerCase(), workspace.toLowerCase(), 'a worktree session runs outside the project folder')
    assert.ok(cwd.toLowerCase().includes('.worktrees') || cwd.toLowerCase().includes('copilot-worktrees'), `worktree cwd: ${cwd}`)
    assert.match(cwd.split(/[\\/]/).pop(), /^desktop-isolated-electron-test-[0-9a-f]{6}$/, 'the worktree carries the name the desktop chose')
    assert.equal(known.status, 'running')
    assert.equal(known.processId, running.processId, 'the same CLI process')
    // The monitor tails the discovered log: a prompt round-trip through the mock model ends in a recorded idle state.
    await until(async () => (await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(running.id)})`)).includes('open sidebar'), 'prompt ready')
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(running.id)}, "Reply with the saved marker.\\r")`)
    await until(async () => (await state()).tabs.find(tab => tab.id === running.id)?.activity === 'idle', 'turn recorded in the discovered log', 60_000)
    // Phase 3a: the tab knows its worktree (from the log's cwd, validated on disk) and shows the branch as a chip.
    const withWorktree = await until(async () => { const tab = (await state()).tabs.find(tab => tab.id === running.id); return tab?.worktree ? tab : null }, 'worktree recognised', 30_000)
    assert.equal(withWorktree.sessionCwd.toLowerCase(), cwd.toLowerCase())
    assert.equal(withWorktree.worktree.path.toLowerCase(), cwd.toLowerCase())
    assert.match(withWorktree.worktree.name, /^desktop-isolated-electron-test-[0-9a-f]{6}$/)
    assert.equal(withWorktree.worktree.branch, withWorktree.worktree.name, 'Copilot names the branch after the worktree')
    await until(() => ui(`[...document.querySelectorAll('.session-worktree-chip')].some(element => element.textContent.includes(${JSON.stringify(withWorktree.worktree.branch)}))`), 'branch chip shown')
    // The Git panel lists the worktree beside the repository, selects it for the active session, and the Branches tab names it.
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(running.id)})`)
    await until(async () => (await state()).activeTabId === running.id, 'created tab active')
    await ui('document.querySelector(".session-git-toggle").click()')
    await until(() => ui('!!document.querySelector(".git-repo-selected")'), 'Git panel open', 30_000)
    await until(() => ui('[...document.querySelectorAll(".git-repo-name")].some(element => element.innerText.includes("(worktree)"))'), 'worktree repository listed', 30_000)
    await until(() => ui(`document.querySelector('.git-repo-selected .git-repo-name')?.innerText.includes(${JSON.stringify(withWorktree.worktree.name)})`), 'the session worktree is the selected repository', 30_000)
    await ui('[...document.querySelectorAll(".git-panel button, .git-tabs button, button")].find(element => element.innerText.trim() === "Branches")?.click()')
    await until(() => ui('/used by Isolated Electron test/.test(document.querySelector(".git-worktrees")?.innerText || "")'), 'worktree list names the session', 30_000)
    // Phase 3b: the worktree a running session uses cannot be removed from the panel; the button says why.
    const removeTitle = await ui(`[...document.querySelectorAll('.git-worktree-remove')].find(element => element.closest('li')?.innerText.includes(${JSON.stringify(withWorktree.worktree.name)}))?.getAttribute('title') ?? ''`)
    assert.match(removeTitle, /used by Isolated Electron test|shown in the panel/, `remove button reason: ${removeTitle}`)
    assert.equal(await ui(`!![...document.querySelectorAll('.git-worktree-remove')].find(element => element.closest('li')?.innerText.includes(${JSON.stringify(withWorktree.worktree.name)}))?.disabled`), true, 'Remove is disabled for a worktree in use')
    // The chip follows the worktree's HEAD: rename the branch inside the worktree and the tab picks it up.
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['-C', cwd, 'branch', '-m', 'renamed-by-check'], { env: process.env, stdio: 'ignore' })
    await until(async () => (await state()).tabs.find(tab => tab.id === running.id)?.worktree?.branch === 'renamed-by-check', 'chip follows a branch rename', 30_000)
    await until(() => ui(`[...document.querySelectorAll('.session-worktree-chip')].some(element => element.textContent.includes('renamed-by-check'))`), 'renamed branch chip shown')
    await screenshot('01-worktree-session')
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sessionId: known.lastSessionId, cwd, cli: (await state()).resolution.version, checks: ['fresh worktree launch without --session-id', 'id discovered from the store', 'session.start cwd is a worktree', 'monitor follows the discovered log through a prompt round-trip', 'tab shows the worktree branch chip', 'Git panel lists and selects the session worktree', 'worktree list names the session', 'Remove is refused for a worktree in use', 'chip follows a branch rename'] }, null, 2))
    console.log('[worktree] PASS: fresh worktree session launched, id discovered from the store: ' + known.lastSessionId)
  } catch (error) {
    await screenshot('failure')
    console.error('[worktree] state', JSON.stringify(await state()))
    throw error
  } finally { app.quit() }
}
