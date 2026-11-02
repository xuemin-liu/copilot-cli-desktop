import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DESKTOP_CONTROL_HELPER, desktopControlInstructions, prepareDesktopControlSessionEnvironment } from './desktop-control-session.js'

test('a session gets the helper, the instructions and the state path, keeping other instruction folders', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'desktop-session-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const env = await prepareDesktopControlSessionEnvironment(folder, 'Ctrl+Alt+Shift+X', { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: 'C:\\other,' + folder, KEEP: '1' })
  assert.equal(env.KEEP, '1')
  assert.equal(env.COPILOT_DESKTOP_CONTROL_STATE, join(folder, 'desktop-control.json'))
  assert.equal(env.COPILOT_DESKTOP_CONTROL_HELPER, join(folder, 'desktop.ps1'))
  assert.equal(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, `C:\\other,${folder}`)
  assert.equal(await readFile(join(folder, 'desktop.ps1'), 'utf8'), DESKTOP_CONTROL_HELPER)
  const instructions = await readFile(join(folder, '.github', 'instructions', 'desktop.instructions.md'), 'utf8')
  assert.match(instructions, /Ctrl\+Alt\+Shift\+X/)
})

test('the helper keeps the token out of command lines and URLs, and the instructions name the rules', () => {
  assert.match(DESKTOP_CONTROL_HELPER, /Authorization = 'Bearer ' \+ \$desktopControl\.token/)
  assert.doesNotMatch(DESKTOP_CONTROL_HELPER, /token=|\?token/)
  assert.match(DESKTOP_CONTROL_HELPER, /-File <absolute-text-file>/)
  const instructions = desktopControlInstructions('Ctrl+Alt+Shift+X')
  for (const rule of [/untrusted data/, /password fields/, /File Explorer/, /frameId/, /turn it on/]) assert.match(instructions, rule)
})
