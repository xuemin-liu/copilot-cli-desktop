// A reviewer folder with an .asar file in it, removed by the real code in a real Electron main process.
//
// Electron's own fs treats a file named *.asar as a folder: one lstat of it opens the archive for the life of the
// process, and a recursive rm of a folder that contains one fails with EBUSY and leaves the file locked by the desktop
// itself. Every checkout where `pnpm install` ran has one (electron/dist/resources/default_app.asar), so reviewer
// folders were left behind and a stopped review stalled on them. Unit tests run under Node, where fs is not patched,
// so only this check sees it. Run with: npm run reviewer-removal:check
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

if (!process.versions.electron) {
  // The Node parent owns the temporary folder: the Electron child keeps the control's .asar locked until it exits, so
  // only here, after it has exited, can everything be removed, also after a failure or a timeout.
  // Electron is found first: its package can throw when its binary is missing, and nothing is made before that.
  const electron = require('electron')
  const base = mkdtempSync(join(tmpdir(), 'reviewer-removal-'))
  let timedOut = false
  let timer = null
  const finish = (code) => {
    if (timer) clearTimeout(timer)
    try { rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (error) { console.error(`reviewer-folder-removal-check: could not remove ${base}: ${String(error)}`); code = code || 1 }
    process.exit(timedOut ? 1 : code)
  }
  try {
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', REVIEWER_REMOVAL_BASE: base } })
    timer = setTimeout(() => { timedOut = true; console.error('reviewer-folder-removal-check: timed out'); child.kill() }, 120_000)
    child.on('error', (error) => { console.error(error); finish(1) })
    child.on('exit', (code) => finish(code ?? 1))
  } catch (error) {
    // A spawn that throws at once (a bad path, say) still leaves nothing behind.
    console.error(error)
    finish(1)
  }
} else {
  const { app } = require('electron')
  const original = require('original-fs')
  const electronFs = require('node:fs')
  const fail = (error) => { console.error(error); app.exit(1) }
  app.whenReady().then(async () => {
    const { makeReviewerArea, planReviewerArea, removeReviewerAreaDetailed, pruneReviewerAreas } = await import(pathToFileURL(resolve(here, '..', 'dist', 'src', 'main', 'pr-review-launch.js')).href)
    // The running Electron's own default app: the very file a checkout with installed dependencies holds.
    const asar = join(process.resourcesPath, 'default_app.asar')
    assert.ok(original.existsSync(asar), `no .asar to test with at ${asar}`)
    const base = process.env.REVIEWER_REMOVAL_BASE
    assert.ok(base && original.existsSync(base), 'the parent process gives the temporary folder')
    const withAsar = async () => {
      const area = await makeReviewerArea(planReviewerArea(base))
      const resources = join(area.checkout, 'node_modules', 'electron', 'dist', 'resources')
      original.mkdirSync(resources, { recursive: true })
      original.copyFileSync(asar, join(resources, 'default_app.asar'))
      original.writeFileSync(join(area.checkout, 'README.md'), 'a checkout')
      return area
    }
    const quick = async (label, removal) => {
      const started = Date.now()
      assert.deepEqual(await removal(), { outcome: 'removed' }, label)
      assert.ok(Date.now() - started < 10_000, `${label}: removal took ${Date.now() - started} ms`)
    }

    // Control: this Electron's own fs really does fail on such a folder, so the checks below mean something.
    const control = await withAsar()
    await assert.rejects(electronFs.promises.rm(control.root, { recursive: true, force: true, maxRetries: 0 }), 'Electron fs unexpectedly removed a folder with an .asar file; this check no longer shows the bug')

    // The reviewer folder goes, quickly, with nothing left.
    const area = await withAsar()
    await quick('a reviewer folder', () => removeReviewerAreaDetailed(area, null))
    assert.equal(original.existsSync(area.root), false)

    // A folder a clean removal left behind is walked for later files before it is deleted (savedAfter). That walk must
    // not touch the .asar with Electron's fs either, or the delete after it would fail. A project and a runner that
    // reports no worktrees take the removal down that path.
    const leftover = await withAsar()
    leftover.project = base
    const noWorktrees = { run: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: '', timedOut: false, cancelled: false }) }
    await new Promise((done) => setTimeout(done, 100))
    await quick('a detached leftover', () => removeReviewerAreaDetailed(leftover, noWorktrees, { detachedAt: Date.now() }))
    assert.equal(original.existsSync(leftover.root), false)
    // And a file saved there after the removal still keeps it: the walk did run.
    const noted = await withAsar()
    noted.project = base
    await new Promise((done) => setTimeout(done, 100))
    const removedAt = Date.now()
    await new Promise((done) => setTimeout(done, 100))
    original.writeFileSync(join(noted.checkout, 'note.txt'), 'saved later')
    const kept = await removeReviewerAreaDetailed(noted, noWorktrees, { detachedAt: removedAt })
    assert.equal(kept.outcome === 'kept' && kept.reason, 'dirty')
    original.rmSync(join(noted.checkout, 'note.txt'))
    await quick('the leftover once the note is gone', () => removeReviewerAreaDetailed(noted, noWorktrees, { detachedAt: removedAt }))

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
