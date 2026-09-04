// Real Electron/renderer/IPC/PTY/CLI check, using the existing isolated harness.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(action, label) {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const result = await action()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

export async function runPermissionCheck() {
  await app.whenReady()
  const window = await until(() => BrowserWindow.getAllWindows().find((candidate) =>
    candidate.webContents.getURL().endsWith('/index.html')), 'renderer')
  const ui = (code) => window.webContents.executeJavaScript(code)
  const state = () => ui('window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  await mkdir(artifacts, { recursive: true })
  const screenshot = async (name) => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  const badge = () => ui('document.querySelector(".sidebar-access")?.textContent')
  const ready = (id) => until(async () => {
    const text = await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(id)})`)
    return typeof text === 'string' && text.includes('open sidebar')
  }, 'CLI prompt ready')
  const command = async (id, text) => {
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(id)}, ${JSON.stringify(text)})`)
    await delay(200)
    await ui(`window.copilotDesktop.writeTab(${JSON.stringify(id)}, "\\r")`)
  }
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const source = await until(async () => (await state()).tabs.find((tab) => tab.status === 'running'), 'running session')
    await ready(source.id)
    await command(source.id, '/permissions assisted')
    await until(async () => (await state()).tabs[0].sessionPermissionMode === 'assisted', 'assisted event')
    await until(async () => (await badge()).includes('Restricted tools · Assisted approval'), 'assisted badge')
    await screenshot('01-assisted')
    await command(source.id, '/permissions manual')
    await until(async () => (await state()).tabs[0].sessionPermissionMode === 'manual', 'manual event')
    await ui(`window.copilotDesktop.restartTab(${JSON.stringify(source.id)})`)
    await ready(source.id)
    const resumed = (await state()).tabs[0]
    assert.equal(resumed.lastSessionId, source.lastSessionId)
    assert.equal(resumed.sessionPermissionMode, 'manual')
    await until(async () => (await badge()).includes('Restricted tools · Manual approval'), 'restored badge')
    await screenshot('02-restarted')
    await ui('window.copilotDesktop.createTab()')
    const fresh = await until(async () => (await state()).tabs.find((tab) => tab.id !== source.id && tab.status === 'running'), 'new tab')
    assert.notEqual(fresh.lastSessionId, source.lastSessionId)
    assert.equal(fresh.sessionPermissionPreset, 'read-only')
    assert.equal(fresh.sessionPermissionMode, null)
    assert.equal((await state()).profiles[0].permissionPreset, 'read-only')
    await screenshot('03-new-session')
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true,
      sourceSessionId: source.lastSessionId, cli: (await state()).resolution.version,
      checks: ['native assisted/manual commands', 'renderer badge', 'restart identity and mode', 'new tab profile default'] }, null, 2))
    console.log('[permissions] PASS: native changes, badge, restart, and new tab')
  } catch (error) {
    await screenshot('failure')
    console.error('[permissions] state', JSON.stringify(await state()))
    throw error
  } finally {
    app.quit()
  }
}
