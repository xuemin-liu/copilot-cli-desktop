// Real CLI and production activity monitoring, using only the local mock model.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

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
    await until(() => ui(`document.querySelector('.sidebar-session-status')?.textContent === 'Working'`), 'working badge')
    await delay(2_000)
    assert.equal(await activity(), 'working', 'quiet model requests must stay working')
    await screenshot('01-working')
    await until(async () => await activity() === 'idle', 'task finished')
    await until(() => ui(`document.querySelector('.sidebar-session-status')?.textContent === 'Idle'`), 'idle badge')
    const finished = (await state()).tabs.find(tab => tab.id === source.id)
    assert.equal(finished.processId, source.processId)
    assert.equal(finished.status, 'running')
    await screenshot('02-idle')
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: source.lastSessionId, cli: (await state()).resolution.version, checks: ['resumed idle', 'typing stays idle', 'working during silent model call', 'final response idle', 'CLI stays alive', 'renderer badges'] }, null, 2))
    console.log('[activity] PASS: idle → working → idle with the same live CLI process')
  } catch (error) {
    await screenshot('failure')
    console.error('[activity] state', JSON.stringify(await state()))
    throw error
  } finally { app.quit() }
}
