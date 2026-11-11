// Production Electron + live CLI, isolated data and loopback mock model: what a session without a process shows in
// place of an empty terminal, in the main window and in its own window.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { ui } from './check-helpers.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label) {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) { const result = await action(); if (result) { console.log(`[stopped-notice] ${label}`); return result }; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
export async function runStoppedNoticeCheck() {
  await app.whenReady()
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'main window')
  const state = (window = main) => ui(window, 'window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async (window, name) => { await delay(300); await writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG()) }
  // The notice in a window, and where the keyboard is.
  const notice = (window, root) => ui(window, `(() => {
    const notice = document.querySelector('${root} .session-stopped-notice');
    const active = document.activeElement;
    return {
      heading: notice?.querySelector('.session-stopped-heading')?.textContent ?? null,
      layout: notice ? (notice.classList.contains('session-stopped-bar') ? 'bar' : 'card') : null,
      buttons: Array.from(notice?.querySelectorAll('button') ?? []).map(button => button.textContent),
      focus: active?.closest('.session-stopped-notice') ? 'notice:' + active.textContent : active?.closest('.xterm') ? 'terminal' : 'elsewhere',
      output: document.querySelector('${root} .xterm-rows')?.textContent.includes('desktop-side-chat-42') ?? false,
    };
  })()`)
  const clickResume = (window, root) => ui(window, `document.querySelector('${root} .session-stopped-notice .primary-button').click()`)
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const source = await until(async () => (await state()).tabs.find(tab => tab.status === 'running' && tab.activity === 'idle'), 'resumed session idle')
    const id = JSON.stringify(source.id)
    const tab = async () => (await state()).tabs.find(candidate => candidate.id === source.id)
    const pane = '.session-pane-visible'
    await until(async () => (await notice(main, pane)).output, 'conversation shown in the terminal')
    assert.equal((await notice(main, pane)).heading, null, 'a running session has no notice')

    // Unloaded in this run: the terminal keeps its text, so the notice is a bar under it.
    main.focus()
    await ui(main, `document.querySelector('${pane} .xterm-helper-textarea').focus()`)
    await ui(main, `window.copilotDesktop.unloadTab(${id})`)
    let view = await until(async () => { const next = await notice(main, pane); return next.heading && next }, 'notice after unload')
    assert.equal((await tab()).status, 'dormant')
    assert.equal(view.heading, 'This session is not running')
    assert.equal(view.layout, 'bar')
    assert.deepEqual(view.buttons, ['Resume session'])
    assert.equal(view.output, true, 'the output from before the unload stays in view')
    await until(async () => (await notice(main, pane)).focus === 'notice:Resume session', 'Resume has the keyboard')
    await screenshot(main, '01-unloaded-bar')

    // Resume from the notice: same tab, new process, and the terminal has the keyboard again.
    await clickResume(main, pane)
    await until(async () => { const next = await tab(); return next.status === 'running' && next.processId && next.processId !== source.processId }, 'resumed from the notice')
    await until(async () => (await notice(main, pane)).heading === null, 'notice gone')
    await until(async () => (await notice(main, pane)).focus === 'terminal', 'terminal has the keyboard')
    await until(async () => (await tab()).activity === 'idle', 'resumed session idle again')
    await screenshot(main, '02-resumed')

    // In its own window an unloaded session starts with an empty terminal: a card, and nothing in the main window.
    await ui(main, `window.copilotDesktop.unloadTab(${id})`)
    await until(async () => (await tab()).status === 'dormant', 'unloaded again')
    await ui(main, `window.copilotDesktop.popOutTab(${id})`)
    const popout = await until(async () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window === main || !window.webContents.getURL().endsWith('/index.html')) continue
        if ((await state(window)).windowSessionId === source.id) return window
      }
    }, 'session window')
    view = await until(async () => { const next = await notice(popout, '.session-window'); return next.heading && next }, 'notice in the session window')
    assert.equal(view.heading, 'This session is not running')
    assert.equal(view.layout, 'card')
    assert.deepEqual(view.buttons, ['Resume session'])
    await screenshot(popout, '03-session-window-card')
    await until(() => ui(main, `document.querySelector('${pane} .empty-state') !== null`), 'main window placeholder')
    assert.equal((await notice(main, pane)).heading, null, 'the main window shows no notice for a popped-out session')
    await screenshot(main, '04-main-window-placeholder')
    await clickResume(popout, '.session-window')
    await until(async () => (await tab()).status === 'running', 'resumed from the session window')
    await until(async () => (await notice(popout, '.session-window')).heading === null, 'session window notice gone')

    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: source.lastSessionId, checks: ['bar under kept output after unload', 'Resume button focused', 'resume from the notice', 'terminal focused after resume', 'card in a session window', 'no notice in the main window for a popped-out session', 'resume from the session window'] }, null, 2))
    console.log('[stopped-notice] PASS: notice, resume and focus in the main and session windows')
  } catch (error) {
    for (const [index, window] of BrowserWindow.getAllWindows().entries()) await screenshot(window, `failure-${index}`).catch(() => {})
    throw error
  } finally { app.quit() }
}
