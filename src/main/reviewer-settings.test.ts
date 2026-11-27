import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOtherCliLaunchArgs } from './agent-cli-settings.js'
import { prefetchReviewerCatalogs, resolveReviewerEntries, reviewerWorkspaceModels, validateDesktopReviewerModels, validateReviewerEntries, validateReviewerModelOverrides, type ReviewerEntry } from './reviewer-settings.js'
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

test('model catalog prefetch reads each CLI with a model to check once', async () => {
  const calls: string[] = []
  const entries: ReviewerEntry[] = [
    { id: 'one', cli: 'codex', model: 'full', reasoningEffort: 'high' },
    { id: 'two', cli: 'codex', reasoningEffort: 'low' },
    { id: 'three', cli: 'claude', reasoningEffort: 'default' },
    { id: 'four', cli: 'copilot', reasoningEffort: 'high' },
  ]
  const resolve = async (cli: string) => {
    calls.push(cli)
    return [{ id: 'full', label: 'Full', efforts: ['low'] }]
  }
  const workspace = reviewerWorkspaceModels(DEFAULT_SESSION_LAUNCH_CONFIG, { codex: { model: 'full' } })
  const catalogs = await prefetchReviewerCatalogs(entries, resolve, [workspace])
  assert.deepEqual(calls, ['codex'], 'a second Codex row does not trigger a duplicate lookup and Copilot has no model')
  assert.throws(() => validateReviewerModelOverrides(entries, catalogs, workspace), /full does not support high/)
  const noModel = await prefetchReviewerCatalogs([entries[3]!], resolve, [workspace])
  assert.deepEqual(noModel, {})
  assert.deepEqual(calls, ['codex'], 'a model-less workspace never waits for a catalog probe')
})

test('catalog validation reports the incompatible reviewer before saving', () => {
  const catalogs = { codex: [{ id: 'small', label: 'Small', efforts: ['low'] }] }
  const entries: ReviewerEntry[] = [
    { id: 'inherited', cli: 'codex', reasoningEffort: 'high' },
    { id: 'override', cli: 'codex', model: 'small', reasoningEffort: 'high' },
  ]
  assert.throws(() => validateReviewerModelOverrides(entries, catalogs), /Reviewer 2: small does not support high/)
  validateReviewerModelOverrides([entries[0]!, { ...entries[1]!, reasoningEffort: 'default' }], catalogs)
  validateReviewerModelOverrides(entries, {})
})

test('workspace model edits are checked against reviewers with an effort-only override', () => {
  const entries: ReviewerEntry[] = [{ id: 'inherited', cli: 'codex', reasoningEffort: 'high' }]
  const catalogs = { codex: [
    { id: 'full', label: 'Full', efforts: ['high'] },
    { id: 'small', label: 'Small', efforts: ['low'] },
  ] }
  const withModel = (model: string) => reviewerWorkspaceModels(DEFAULT_SESSION_LAUNCH_CONFIG, { codex: { model } })
  validateReviewerModelOverrides(entries, catalogs, withModel('full'))
  assert.throws(() => validateReviewerModelOverrides(entries, catalogs, withModel('small')), /Reviewer 1: small does not support high/)
  validateReviewerModelOverrides([{ ...entries[0]!, model: 'full' }], catalogs, withModel('small'))
  validateReviewerModelOverrides(entries, catalogs)
  assert.throws(
    () => validateReviewerModelOverrides(entries, catalogs, withModel('small'), 'the Desktop list'),
    /Reviewer 1 in the Desktop list: small does not support high/,
  )
  const workspace = { name: 'Docs', launch: DEFAULT_SESSION_LAUNCH_CONFIG, otherCli: { codex: { model: 'small' } } }
  assert.throws(() => validateDesktopReviewerModels(entries, [workspace], catalogs), /Desktop list for workspace "Docs"/)
  validateDesktopReviewerModels(entries, [{ ...workspace, reviewerEntries: [{ id: 'local', cli: 'codex' }] }], catalogs)
})
