// Real Settings renderer, preload, IPC handlers and migration service. Native
// file dialogs select disposable fixture paths; no user data or model calls.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
  const { app, BrowserWindow, dialog, shell } = await import('electron')
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
  // Other tasks may have live Copilot processes. Stub only that OS boundary in
  // a disposable main-module copy; all session checks, IPC and file logic remain.
  const mainSource = new URL('../dist/src/main/main.js', import.meta.url)
  const mainFixture = new URL(`../dist/src/main/migration-ui-${randomUUID()}.js`, import.meta.url)
  const source = await readFile(mainSource, 'utf8')
  const writerImport = "import { assertMigrationWritersStopped } from './migration-writers.js';"
  assert.ok(source.includes(writerImport))
  await writeFile(mainFixture, source.replace(writerImport, 'const assertMigrationWritersStopped = async () => {};'))
  try { await import(mainFixture.href) } finally { await rm(mainFixture, { force: true }) }
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
    const click = async (text) => {
      await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)}); if (!button || button.disabled) throw Error('Button unavailable'); button.click(); })()`)
    }
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
    await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, checks: ['real settings renderer', 'export IPC', 'archive validation', 'conflict preview', 'selected replacement', 'import readback'] }, null, 2))
    console.log('[migration-check] Production Settings export, conflict preview and import passed.')
    clearTimeout(timeout); app.quit()
  } catch (error) {
    console.error(error)
    for (const window of BrowserWindow.getAllWindows()) console.error((await window.webContents.executeJavaScript('document.body.innerText')).slice(-6000))
    clearTimeout(timeout); app.exit(1)
  }
}
