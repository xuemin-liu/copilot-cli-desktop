import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, sep } from 'node:path'
import assert from 'node:assert/strict'

// Reverse the declared adapter patch and prove every imported file still matches
// the upstream snapshot. No network or source checkout is needed in CI.
const root = resolve('vendor/myterminal')
const manifest = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'))
const scratch = await mkdtemp(join(tmpdir(), 'myterminal-provenance-'))
try {
  for (const name of Object.keys(manifest.files)) {
    await mkdir(dirname(join(scratch, name)), { recursive: true })
    await writeFile(join(scratch, name), (await readFile(join(root, name), 'utf8')).replaceAll('\r\n', '\n'))
  }
  execFileSync('git', ['apply', '--reverse', join(root, 'desktop.patch')], { cwd: scratch, stdio: 'pipe' })
  for (const [name, hash] of Object.entries(manifest.files)) {
    const data = (await readFile(join(scratch, name), 'utf8')).replaceAll('\r\n', '\n')
    assert.equal(createHash('sha256').update(data).digest('hex'), hash, `Undocumented MyTerminal change: ${name}`)
  }
  console.log(`MyTerminal ${manifest.revision}: ${Object.keys(manifest.files).length} source/test files verified against the pinned snapshot.`)
} finally {
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + sep), 'Cleanup must remain inside the temporary directory')
  await rm(scratch, { recursive: true, force: true })
}
