import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOtherCliLaunchArgs } from './agent-cli-settings.js'
import { resolveReviewerEntries, validateReviewerEntries, validateReviewerModelOverrides, type ReviewerEntry } from './reviewer-settings.js'
import { buildSessionLaunchArgs, DEFAULT_SESSION_LAUNCH_CONFIG } from './session-launch.js'

test('reviewer model and effort resolve together against the reviewed workspace', async () => {
  const workspace = {
    launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG, model: 'copilot-team', reasoningEffort: 'high' as const, worktree: true },
    permissionPreset: 'default' as const,
    otherCli: { codex: { model: 'team', reasoningEffort: 'high', sandbox: 'workspace-write' } },
  }
  const catalog = async () => [
    { id: 'team', label: 'Team', efforts: ['low', 'high'] },
    { id: 'small', label: 'Small', efforts: ['low'] },
    { id: 'auto', label: 'Auto', efforts: [] },
  ]
  const entries: ReviewerEntry[] = [
    { id: 'one', cli: 'codex' },
    { id: 'two', cli: 'codex', model: 'small' },
    { id: 'three', cli: 'codex', reasoningEffort: 'default' },
    { id: 'four', cli: 'codex', model: 'custom', reasoningEffort: 'xhigh' },
    { id: 'five', cli: 'copilot', model: 'auto' },
  ]
  const seats = await resolveReviewerEntries(entries, workspace, catalog)
  workspace.otherCli.codex.model = 'new-default'
  workspace.otherCli.codex.sandbox = 'read-only'
  assert.deepEqual(seats.map((reviewer) => reviewer.id), entries.map((row) => row.id))
  assert.match(seats[1]!.label, /workspace effort unavailable/)
  assert.deepEqual(seats.map((reviewer) => reviewer.cli === 'copilot'
    ? buildSessionLaunchArgs(reviewer.launch, true)
    : buildOtherCliLaunchArgs(reviewer.cli, reviewer.config)), [
    ['--sandbox', 'workspace-write', '--model', 'team', '--config', 'model_reasoning_effort="high"'],
    ['--sandbox', 'workspace-write', '--model', 'small'],
    ['--sandbox', 'workspace-write', '--model', 'team'],
    ['--sandbox', 'workspace-write', '--model', 'custom', '--config', 'model_reasoning_effort="xhigh"'],
    ['--model', 'auto'],
  ])
  await assert.rejects(
    resolveReviewerEntries([{ id: 'one', cli: 'codex', reasoningEffort: 'high' }], {
      ...workspace, otherCli: { codex: { model: 'small' } },
    }, catalog),
    /Codex CLI: small does not support high/,
  )
})

test('reviewer settings validate both the entry and roster without collapsing a CLI', () => {
  const rows = [
    { id: 'one', cli: 'codex', model: 'first' },
    { id: 'two', cli: 'codex', model: 'second', reasoningEffort: 'default' },
  ]
  assert.deepEqual(validateReviewerEntries(rows), rows)
  assert.deepEqual(validateReviewerEntries([{ ...rows[0], model: ' first ' }]), [rows[0]])
  assert.throws(() => validateReviewerEntries([rows[0], rows[0]]), /reviewer 2/)
  assert.throws(() => validateReviewerEntries([{ id: 'one', cli: 'antigravity', reasoningEffort: 'high' }]), /reviewer 1/)
  assert.throws(() => validateReviewerEntries([{ id: 'one', cli: 'copilot', model: '--effort' }]), /reviewer 1/)
  assert.throws(() => validateReviewerEntries([]), /between 1 and 8/)
  assert.throws(() => validateReviewerEntries(Array.from({ length: 9 }, (_, i) => ({ id: String(i), cli: 'copilot' }))), /between 1 and 8/)
})

test('catalog validation reports the incompatible reviewer before saving', async () => {
  const catalog = async () => [{ id: 'small', label: 'Small', efforts: ['low'] }]
  const entries: ReviewerEntry[] = [
    { id: 'inherited', cli: 'codex', reasoningEffort: 'high' },
    { id: 'override', cli: 'codex', model: 'small', reasoningEffort: 'high' },
  ]
  await assert.rejects(validateReviewerModelOverrides(entries, catalog), /Reviewer 2: small does not support high/)
  await validateReviewerModelOverrides([entries[0]!, { ...entries[1]!, reasoningEffort: 'default' }], catalog)
  await validateReviewerModelOverrides(entries, async () => [])
})
