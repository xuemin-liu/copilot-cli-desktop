import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_CLI_SETTINGS,
  buildOtherCliLaunchArgs,
  normalizeOtherCliConfig,
  normalizePerCliConfig,
} from './agent-cli-settings.js'

test('buildOtherCliLaunchArgs emits Claude approval and model as separate tokens', () => {
  assert.deepEqual(
    buildOtherCliLaunchArgs('claude', { approval: 'plan', model: 'claude-sonnet-5' }),
    ['--permission-mode', 'plan', '--model', 'claude-sonnet-5'],
  )
})

test('buildOtherCliLaunchArgs emits Codex approval and sandbox independently', () => {
  assert.deepEqual(
    buildOtherCliLaunchArgs('codex', { approval: 'never', sandbox: 'read-only', model: 'gpt-5-codex' }),
    ['--ask-for-approval', 'never', '--sandbox', 'read-only', '--model', 'gpt-5-codex'],
  )
  // Approval without sandbox leaves sandbox untouched.
  assert.deepEqual(buildOtherCliLaunchArgs('codex', { approval: 'on-request' }), ['--ask-for-approval', 'on-request'])
})

test('buildOtherCliLaunchArgs ships Antigravity model but no permission flags', () => {
  assert.deepEqual(buildOtherCliLaunchArgs('antigravity', { model: 'some-model' }), ['--model', 'some-model'])
})

test('an unset config inherits: no flags at all', () => {
  assert.deepEqual(buildOtherCliLaunchArgs('claude', undefined), [])
  assert.deepEqual(buildOtherCliLaunchArgs('claude', {}), [])
  assert.deepEqual(buildOtherCliLaunchArgs('codex', { model: 'x' }), ['--model', 'x'])
})

test('a model string with spaces stays a single token (no shell quoting needed)', () => {
  assert.deepEqual(buildOtherCliLaunchArgs('claude', { model: 'my model v2' }), ['--model', 'my model v2'])
})

test('buildOtherCliLaunchArgs throws on an unsupported saved level rather than launching bare', () => {
  assert.throws(() => buildOtherCliLaunchArgs('claude', { approval: 'bypassPermissions' }), /does not support approval/)
})

test('a model that looks like a flag is refused, so it can never inject an argument', () => {
  assert.deepEqual(buildOtherCliLaunchArgs('claude', { model: '--dangerously-skip-permissions' }), [])
  assert.deepEqual(normalizePerCliConfig('claude', { model: '--evil' }), {})
})

test('normalizePerCliConfig keeps known values and drops malformed ones', () => {
  assert.deepEqual(
    normalizePerCliConfig('codex', { approval: 'on-request', sandbox: 'nonsense', model: '  gpt-5  ', extra: 'x' }),
    { approval: 'on-request', model: 'gpt-5' },
  )
  assert.deepEqual(normalizePerCliConfig('antigravity', { approval: 'plan' }), {})
})

test('normalizeOtherCliConfig drops CLIs with no usable settings', () => {
  assert.deepEqual(
    normalizeOtherCliConfig({ claude: { approval: 'plan' }, codex: { approval: 'bogus' }, junk: { model: 'x' } }),
    { claude: { approval: 'plan' } },
  )
  assert.deepEqual(normalizeOtherCliConfig(null), {})
  assert.deepEqual(normalizeOtherCliConfig('nope'), {})
})

test('every descriptor level maps to a non-empty flag list', () => {
  for (const descriptor of Object.values(AGENT_CLI_SETTINGS)) {
    for (const selector of descriptor.selectors) {
      for (const level of selector.levels) assert.ok(level.args.length > 0, `${descriptor.cli}/${level.value}`)
    }
  }
})
