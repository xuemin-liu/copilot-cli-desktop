// A reviewer folder with an .asar file in it, removed by the real code in a real Electron main process.
//
// Electron's own fs treats a file named *.asar as a folder: one lstat of it opens the archive for the life of the
// process, and a recursive rm of a folder that contains one fails with EBUSY and leaves the file locked by the desktop
// itself. Every checkout where `pnpm install` ran has one (electron/dist/resources/default_app.asar), so reviewer
// folders were left behind and a stopped review stalled on them. Unit tests run under Node, where fs is not patched,
// so only this check sees it. Run with: npm run reviewer-removal:check
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

if (!process.versions.electron) {
  const electron = require('electron')
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } })
  const timer = setTimeout(() => { child.kill(); console.error('reviewer-folder-removal-check: timed out'); process.exit(1) }, 120_000)
  child.on('exit', (code) => { clearTimeout(timer); process.exit(code ?? 1) })
} else {
  const { app } = require('electron')
  const original = require('original-fs')
  const electronFs = require('node:fs')
  const fail = (error) => { console.error(error); app.exit(1) }
  app.whenReady().then(async () => {
    const { makeReviewerArea, planReviewerArea, removeReviewerAreaDetailed, pruneReviewerAreas } = await import(pathToFileURL(resolve(here, '..', 'dist', 'src', 'main', 'pr-review-launch.js')).href)
    // The running Electron's own default app: the very file a checkout with installed dependencies holds.
    const asar = join(dirname(process.execPath), 'resources', 'default_app.asar')
    assert.ok(original.existsSync(asar), `no .asar to test with at ${asar}`)
    const base = original.mkdtempSync(join(tmpdir(), 'reviewer-removal-'))
    const withAsar = async () => {
      const area = await makeReviewerArea(planReviewerArea(base))
      const resources = join(area.checkout, 'node_modules', 'electron', 'dist', 'resources')
      original.mkdirSync(resources, { recursive: true })
      original.copyFileSync(asar, join(resources, 'default_app.asar'))
      original.writeFileSync(join(area.checkout, 'README.md'), 'a checkout')
      return area
    }

    // Control: this Electron's own fs really does fail on such a folder, so the check below means something.
    const control = await withAsar()
    await assert.rejects(electronFs.promises.rm(control.root, { recursive: true, force: true, maxRetries: 0 }), 'Electron fs unexpectedly removed a folder with an .asar file; this check no longer shows the bug')

    // The reviewer folder goes, quickly, with nothing left.
    const area = await withAsar()
    const started = Date.now()
    assert.deepEqual(await removeReviewerAreaDetailed(area, null), { outcome: 'removed' })
    assert.ok(Date.now() - started < 10_000, `removal took ${Date.now() - started} ms`)
    assert.equal(original.existsSync(area.root), false)

    // So does an old folder the start-up prune finds.
    const old = await withAsar()
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000)
    original.utimesSync(old.root, longAgo, longAgo)
    const pruned = await pruneReviewerAreas(base, new Set([resolve(control.root)]), Date.now())
    assert.deepEqual(pruned, [resolve(old.root)])
    assert.equal(original.existsSync(old.root), false)

    console.log('reviewer-folder-removal-check: passed')
    app.exit(0)
  }).catch(fail)
}
