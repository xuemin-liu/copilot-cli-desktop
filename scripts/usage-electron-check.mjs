// Exercises the production worker in the installed Electron runtime without starting a model or showing a window.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const electron = (await import('electron')).default
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { windowsHide: true, stdio: 'inherit' })
  child.on('error', (error) => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
} else { void runElectronCheck() }

async function runElectronCheck() {
  const { app } = await import('electron')
  const root = await mkdtemp(join(tmpdir(), 'usage-electron-check-'))
  app.setPath('userData', root)
  await app.whenReady()
  let service
  try {
    const { seedSourceStore } = await import('../dist/scripts/usage-source-fixture.js')
    const { UsageService } = await import('../dist/src/main/usage-service.js')
    const home = join(root, 'copilot'), path = join(root, 'usage.sqlite')
    seedSourceStore(home)
    service = new UsageService(path, home, console.error)
    await service.collect()
    assert.equal((await service.report('2026-09', 'all', 'UTC')).totals.input, 50)
    await service.stop(); service = null
    await rm(home, { recursive: true })
    service = new UsageService(path, home, console.error)
    await service.collect()
    const report = await service.report('2026-09', 'all', 'UTC')
    assert.equal(report.totals.input, 50)
    assert.ok(report.lastBackup)
    console.log(`Usage Electron check passed (Electron ${process.versions.electron}, Node ${process.versions.node}): worker, backup and restart after source deletion.`)
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally {
    await service?.stop()
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup path')
    await rm(root, { recursive: true, force: true })
    app.exit(process.exitCode ?? 0)
  }
}
