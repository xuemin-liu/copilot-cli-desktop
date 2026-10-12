// Real CLI and production activity monitoring, using only the local mock model.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { SessionActivityTracker } from '../dist/src/main/session-activity.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
export async function runActivityCheck() {
  await app.whenReady()
  const window = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), 'renderer')
  const ui = code => window.webContents.executeJavaScript(code)
  const state = () => ui('window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async name => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const source = await until(async () => (await state()).tabs.find(tab => tab.status === 'running' && tab.activity === 'idle'), 'resumed session idle')
    await until(async () => (await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(source.id)})`)).includes('open sidebar'), 'prompt')
    const activity = () => state().then(value => value.tabs.find(tab => tab.id === source.id)?.activity)
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(source.id)}, "Reply with the saved marker.")`)
    await delay(200)
    assert.equal(await activity(), 'idle', 'typing is not task execution')
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(source.id)}, "\\r")`)
    await until(async () => await activity() === 'working', 'task working')
    // While the delayed model call runs, the row shows what the session does (Thinking) and for how long.
    await until(() => ui(`document.querySelector('.sidebar-session-activity')?.textContent === 'Thinking'`), 'thinking line')
    const elapsedText = () => ui(`document.querySelector('.sidebar-session-status')?.textContent ?? ''`)
    const firstElapsed = await until(async () => { const text = await elapsedText(); return /^\d+s$/.test(text) ? text : null }, 'elapsed clock')
    await until(async () => { const text = await elapsedText(); return /^\d+s$/.test(text) && text !== firstElapsed }, 'elapsed clock ticks')
    await delay(1_000)
    assert.equal(await activity(), 'working', 'quiet model requests must stay working')
    await screenshot('01-working')
    await until(async () => await activity() === 'idle', 'task finished')
    await until(() => ui(`document.querySelector('.sidebar-session-status')?.textContent === 'Idle'`), 'idle badge')
    assert.equal(await ui(`document.querySelector('.sidebar-session-activity')`), null, 'an idle row has no activity line')
    const finished = (await state()).tabs.find(tab => tab.id === source.id)
    assert.equal(finished.processId, source.processId)
    assert.equal(finished.status, 'running')
    assert.equal(finished.activityDetail, null)
    await screenshot('02-idle')
    // Contract with the installed CLI: its real tool record for the mock model's `view` call maps to the sidebar label.
    const records = (await readFile(join(process.env.COPILOT_HOME, 'session-state', source.lastSessionId, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean)
    const toolStart = records.findIndex(line => { try { const record = JSON.parse(line); return record.type === 'tool.execution_start' && record.data?.toolName === 'view' } catch { return false } })
    assert.ok(toolStart >= 0, 'the CLI recorded the view tool call requested by the mock model')
    const replay = new SessionActivityTracker()
    for (const line of records.slice(0, toolStart + 1)) replay.consume(line)
    assert.deepEqual(replay.detail?.kind === 'tools' ? replay.detail.tools : null, [{ title: 'Viewing', detail: 'marker.txt' }], 'the real tool record yields the sidebar label')
    assert.ok(replay.detail.since <= Date.now() && replay.detail.since > Date.now() - 300_000, 'the record timestamp is used as the start time')
    assert.ok(records.slice(toolStart + 1).some(line => line.includes('"tool.execution_complete"')), 'the CLI recorded the tool completion')
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: source.lastSessionId, cli: (await state()).resolution.version, checks: ['resumed idle', 'typing stays idle', 'thinking line and elapsed clock during silent model call', 'final response idle', 'CLI stays alive', 'renderer badges', 'real view tool record maps to the sidebar label'] }, null, 2))
    console.log('[activity] PASS: idle → working → idle with the same live CLI process')
  } catch (error) {
    await screenshot('failure')
    console.error('[activity] state', JSON.stringify(await state()))
    throw error
  } finally { app.quit() }
}
