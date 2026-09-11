// Real Settings renderer, preload, IPC handlers and migration service. Native
// file dialogs select disposable fixture paths; no user data or model calls.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), 'migration-electron-'))
  const output = resolve('test-results/migration')
  await mkdir(output, { recursive: true })
  try {
    const electron = (await import('electron')).default
    const env = { ...process.env, MIGRATION_CHECK_ROOT: root, MIGRATION_CHECK_OUTPUT: output, COPILOT_HOME: join(root, 'copilot'), COPILOT_DESKTOP_CLI_HOME: join(root, 'controller'), COPILOT_OFFLINE: 'true' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [fileURLToPath(import.meta.url), '--disable-gpu'], { env, stdio: 'inherit', windowsHide: true })
    const code = await new Promise((ok, fail) => { child.on('error', fail); child.on('exit', ok) })
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(join(output, 'result.json'), 'utf8')).passed, true)
  } finally { await rm(root, { recursive: true, force: true }) }
} else { void runElectronCheck() }

async function runElectronCheck() {
  const { app, BrowserWindow, dialog, shell, ipcMain } = await import('electron')
  let statusRequests = 0
  let holdNextStatus = false, statusCaptured, releaseHeldStatus
  let releaseInitialStatus
  const initialStatusGate = new Promise((ok) => { releaseInitialStatus = ok })
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, channel === 'desktop-settings:migration-status' ? async (...args) => {
    const initial = ++statusRequests === 1
    const value = await listener(...args)
    if (initial) await initialStatusGate
    if (holdNextStatus) {
      holdNextStatus = false
      await new Promise((ok) => { releaseHeldStatus = ok; statusCaptured() })
    }
    return value
  } : listener)
  dialog.showErrorBox = (title, content) => { console.error(title, content); app.exit(1) }
  const root = process.env.MIGRATION_CHECK_ROOT, output = process.env.MIGRATION_CHECK_OUTPUT
  assert.ok(root && output)
  for (const path of ['desktop', 'home', 'copilot']) await mkdir(join(root, path), { recursive: true })
  app.setPath('userData', join(root, 'desktop')); app.setPath('home', join(root, 'home'))
  app.getAppPath = () => fileURLToPath(new URL('../', import.meta.url))
  app.on('browser-window-created', (_event, window) => { window.show = () => {} })
  const zip = join(root, 'migration.zip')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: zip })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [zip] })
  shell.showItemInFolder = () => {}
  await writeFile(join(root, 'copilot', 'settings.json'), '{"model":"migration-model","theme":"dim"}')
  await writeFile(join(root, 'copilot', 'copilot-instructions.md'), 'Migration UI fixture')
  const damagedJournal = join(root, 'desktop', 'migration-backups', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  await mkdir(damagedJournal, { recursive: true })
  const instructions = join(root, 'copilot', 'copilot-instructions.md')
  const hash = (text) => createHash('sha256').update(text).digest('hex')
  await writeFile(instructions, 'interrupted import')
  await writeFile(join(damagedJournal, '0.bak'), 'Migration UI fixture')
  await writeFile(join(damagedJournal, 'journal.json'), JSON.stringify({ version: 1, status: 'needs-attention', roots: [join(root, 'copilot')], writes: [{ target: instructions, before: hash('Migration UI fixture'), after: hash('interrupted import') }] }))
  const corruptJournal = join(root, 'desktop', 'migration-backups', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  await mkdir(corruptJournal)
  await writeFile(join(corruptJournal, 'journal.json'), '{damaged fixture')
  await import('../dist/src/main/main.js')
  console.log('[migration-check] Application loaded; waiting for Settings.')
  const timeout = setTimeout(() => { console.error('Migration UI check timed out'); app.exit(1) }, 90_000)
  async function waitFor(fn) {
    for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await new Promise((ok) => setTimeout(ok, 100)) }
    throw new Error('UI condition not reached')
  }
  try {
    const main = await waitFor(() => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html')))
    await waitFor(() => main.webContents.executeJavaScript('Boolean(window.copilotDesktop)'))
    await main.webContents.executeJavaScript('window.copilotDesktop.openSettings()')
    const settings = await waitFor(() => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/settings.html')))
    settings.webContents.setBackgroundThrottling(false)
    const evaluate = (code) => settings.webContents.executeJavaScript(code)
    await waitFor(() => evaluate('Boolean(document.querySelector("#migration-title"))'))
    await waitFor(() => statusRequests > 0)
    settings.webContents.send('desktop-settings:migration-progress', { phase: 'Progress while mounting', completed: 1, total: 2 })
    await waitFor(() => evaluate(`document.body.textContent.includes('Progress while mounting')`))
    releaseInitialStatus()
    const click = async (text) => {
      await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)}); if (!button || button.disabled) throw Error('Button unavailable'); button.click(); })()`)
    }
    await waitFor(() => evaluate(`document.body.textContent.includes('An interrupted import needs attention')`))
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Retry recovery' && !b.disabled)`))
    await click('Retry recovery')
    await waitFor(async () => JSON.parse(await readFile(join(damagedJournal, 'journal.json'), 'utf8')).status === 'rolled-back')
    assert.equal(await readFile(instructions, 'utf8'), 'Migration UI fixture')
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Retry recovery' && !b.disabled)`))
    await evaluate(`[...document.querySelectorAll('label')].find(l => l.textContent.includes('I inspected these recovery backups')).querySelector('input').click()`)
    const twinJournal = join(root, 'desktop', 'migration-backups', 'cccccccc-cccc-cccc-cccc-cccccccccccc')
    await mkdir(twinJournal)
    await writeFile(join(twinJournal, 'journal.json'), await readFile(join(corruptJournal, 'journal.json')))
    await click('Retry recovery')
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent === 'Keep current files and dismiss this recovery').length === 2 && [...document.querySelectorAll('button')].some(b => b.textContent === 'Retry recovery' && !b.disabled)`))
    assert.equal(await evaluate(`[...document.querySelectorAll('label')].find(l => l.textContent.includes('I inspected these recovery backups')).querySelector('input').checked`), false)
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent === 'Keep current files and dismiss this recovery').every(b => b.disabled)`), true)
    await evaluate(`[...document.querySelectorAll('label')].find(l => l.textContent.includes('I inspected these recovery backups')).querySelector('input').click()`)
    await click('Keep current files and dismiss this recovery')
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent === 'Keep current files and dismiss this recovery').length === 1 && [...document.querySelectorAll('button')].some(b => b.textContent === 'Retry recovery' && !b.disabled)`))
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Keep current files and dismiss this recovery').disabled`), true)
    await evaluate(`[...document.querySelectorAll('label')].find(l => l.textContent.includes('I inspected these recovery backups')).querySelector('input').click()`)
    await click('Keep current files and dismiss this recovery')
    await waitFor(() => evaluate(`!document.body.textContent.includes('An interrupted import needs attention')`))
    assert.ok((await (await import('node:fs/promises')).readdir(corruptJournal)).some((name) => name.startsWith('journal.dismissed-')))
    await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Delete backup…' && b.parentElement.textContent.includes(${JSON.stringify(corruptJournal)})); if (!button) throw Error('Dismissed backup not listed'); button.closest('details').open = true; button.click(); })()`)
    await click('Permanently delete this backup')
    await waitFor(async () => { try { await readFile(join(corruptJournal, 'journal.json')); return false } catch { return !(await (await import('node:fs/promises')).readdir(join(root, 'desktop', 'migration-backups'))).includes('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') } })
    // An idle refresh must publish new diagnostics and remove resolved ones.
    const foreignFile = join(damagedJournal, 'foreign-refresh-fixture.txt')
    await writeFile(foreignFile, 'preserve')
    await click('Refresh backup list')
    await waitFor(() => evaluate(`document.querySelector('.settings-warning[role="status"]')?.textContent.includes('foreign-refresh-fixture.txt') && [...document.querySelectorAll('button')].some(b => b.textContent === 'Refresh backup list' && !b.disabled)`))
    await rm(foreignFile)
    await click('Refresh backup list')
    await waitFor(() => evaluate(`!document.body.textContent.includes('foreign-refresh-fixture.txt') && [...document.querySelectorAll('button')].some(b => b.textContent === 'Refresh backup list' && !b.disabled)`))
    const baselineRequests = statusRequests
    for (let i = 1; i <= 5000; i++) settings.webContents.send('desktop-settings:migration-progress', { phase: 'Progress fixture', completed: i, total: 5000 })
    await waitFor(() => evaluate(`document.body.textContent.includes('Progress fixture 5000/5000')`))
    assert.ok(statusRequests - baselineRequests <= 2, 'progress events must not trigger per-file status invokes')
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Review export files' && !b.disabled)`))
    await evaluate(`(() => { const section=document.querySelector('#migration-title').closest('section'); for (const label of section.querySelectorAll('fieldset label')) { const input=label.querySelector('input'); if(input?.checked && !label.textContent.includes('CLI settings') && !label.textContent.includes('Personal instructions')) input.click(); } })()`)
    await click('Review export files')
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Export ZIP…' && !b.disabled)`))
    await click('Export ZIP…')
    await waitFor(() => evaluate(`document.body.textContent.includes('Archive exported and shown')`))
    await writeFile(join(root, 'copilot', 'settings.json'), '{"model":"local-model","theme":"dim"}')
    await click('Choose archive…')
    await waitFor(() => evaluate(`document.body.textContent.includes('Workspace folders')`))
    await click('Review import changes')
    await waitFor(() => evaluate(`document.body.textContent.includes('Conflict') && [...document.querySelectorAll('button')].some(b => b.textContent === 'Import selected' && !b.disabled)`))
    await evaluate(`document.querySelector('#migration-title').scrollIntoView({behavior:'instant'})`)
    await new Promise((ok) => setTimeout(ok, 350))
    await writeFile(join(output, 'migration-preview.png'), (await settings.webContents.capturePage()).toPNG())
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Review import changes').scrollIntoView({behavior:'instant'})`)
    await new Promise((ok) => setTimeout(ok, 350))
    await writeFile(join(output, 'migration-conflicts.png'), (await settings.webContents.capturePage()).toPNG())
    await evaluate(`(() => { const label=[...document.querySelectorAll('label')].find(l => l.textContent.includes('Use imported version')); label.querySelector('input').click(); })()`)
    await click('Review import changes')
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Import selected' && !b.disabled)`))
    await click('Import selected')
    await waitFor(() => evaluate(`document.body.textContent.includes('Import completed')`))
    assert.equal(JSON.parse(await readFile(join(root, 'copilot', 'settings.json'), 'utf8')).model, 'migration-model')
    const { UsageService } = await import('../dist/src/main/usage-service.js')
    const originalExport = UsageService.prototype.exportTo
    let releaseSnapshot, snapshotStarted
    const started = new Promise((ok) => { snapshotStarted = ok })
    const stalled = new Promise((ok) => { releaseSnapshot = ok })
    UsageService.prototype.exportTo = async function (path) { snapshotStarted(); await stalled; return originalExport.call(this, path) }
    await evaluate(`void window.copilotDesktopSettings.migrationExport({categories:['usage'],projectIds:[]}).catch(() => {})`)
    await started
    assert.equal((await evaluate('window.copilotDesktopSettings.migrationStatus()')).busy, true)
    const beforeRefresh = await evaluate('window.copilotDesktopSettings.migrationStatus()')
    const captured = new Promise((ok) => { statusCaptured = ok })
    holdNextStatus = true
    await captured // Hold an older poll reply until after the manual list refresh.
    const addedBackup = join(root, 'desktop', 'migration-backups', 'dddddddd-dddd-dddd-dddd-dddddddddddd')
    await mkdir(addedBackup)
    await writeFile(join(addedBackup, 'usage-before.sqlite'), 'concurrent refresh fixture')
    await click('Refresh backup list')
    await waitFor(() => evaluate(`document.body.textContent.includes(${JSON.stringify(addedBackup)}) && [...document.querySelectorAll('button')].some(b => b.textContent === 'Refresh backup list' && !b.disabled)`))
    assert.equal(await evaluate(`[...document.querySelectorAll('details')].find(d => d.textContent.includes('Refresh backup list')).querySelector('[role="status"]')?.textContent ?? ''`), '')
    releaseHeldStatus()
    await evaluate(`new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)))`)
    assert.equal(await evaluate(`document.body.textContent.includes(${JSON.stringify(addedBackup)})`), true, 'an older poll reply must not overwrite the refreshed backup list')
    assert.deepEqual((await evaluate('window.copilotDesktopSettings.migrationStatus()')).progress, beforeRefresh.progress)
    assert.equal((await evaluate('window.copilotDesktopSettings.migrationStatus()')).busy, true)
    const closed = new Promise((ok) => settings.once('closed', ok))
    settings.close()
    await closed
    await main.webContents.executeJavaScript('window.copilotDesktop.openSettings()')
    const reopened = await waitFor(() => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/settings.html')))
    await waitFor(() => reopened.webContents.executeJavaScript('Boolean(document.querySelector("#migration-title"))'))
    await waitFor(async () => !(await reopened.webContents.executeJavaScript('window.copilotDesktopSettings.migrationStatus()')).busy)
    await waitFor(() => reopened.webContents.executeJavaScript(`document.body.textContent.includes('Last import: completed')`))
    releaseSnapshot()
    UsageService.prototype.exportTo = originalExport
    await waitFor(async () => !(await (await import('node:fs/promises')).readdir(join(root, 'desktop'))).some((name) => name.startsWith('migration-staging-')))
    await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, checks: ['nonfatal startup recovery', 'mount status survives progress', 'real recovery retry', 'acknowledgement bound to all journal identities and hashes', 'inspected recovery dismissal', 'explicit retained-backup deletion', '5000 progress events with bounded polling', 'missed Idle reconciled automatically', 'real settings renderer', 'real writer check', 'export IPC', 'archive validation', 'conflict preview', 'selected replacement', 'import readback', 'backup refresh preserves active export progress', 'close cancels stalled snapshot', 'reopened Settings status and last import'] }, null, 2))
    console.log('[migration-check] Production Settings export, conflict preview and import passed.')
    clearTimeout(timeout); app.quit()
  } catch (error) {
    console.error(error)
    for (const window of BrowserWindow.getAllWindows()) console.error((await window.webContents.executeJavaScript('document.body.innerText')).slice(-6000))
    clearTimeout(timeout); app.exit(1)
  }
}
