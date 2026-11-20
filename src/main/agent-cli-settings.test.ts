import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_CLI_SETTINGS,
  buildOtherCliLaunchArgs,
  helpListsFlag,
  incompatibleOtherCliFields,
  normalizeOtherCliConfig,
  normalizePerCliConfig,
  validateOtherCliConfig,
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

test('reading a saved config keeps a well-formed level this build does not know, and drops malformed input', () => {
  assert.deepEqual(
    normalizePerCliConfig('codex', { approval: 'on-request', sandbox: 'danger-full-access', model: '  gpt-5  ', extra: 'x' }),
    { approval: 'on-request', sandbox: 'danger-full-access', model: 'gpt-5' },
  )
  assert.deepEqual(normalizePerCliConfig('codex', { approval: 'not a level!', sandbox: 7, model: '--x' }), {})
  assert.deepEqual(normalizePerCliConfig('antigravity', { approval: 'plan' }), {})
})

test('normalizeOtherCliConfig drops CLIs with no usable settings', () => {
  assert.deepEqual(
    normalizeOtherCliConfig({ claude: { approval: 'plan' }, codex: { approval: '--bogus' }, junk: { model: 'x' } }),
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

test('a saved approval this build no longer knows survives restore and blocks launch instead of being dropped', () => {
  // The reviewer's case: a saved Claude dontAsk approval next to a valid model.
  const saved = normalizePerCliConfig('claude', { approval: 'dontAsk', model: 'claude-sonnet-5' })
  assert.deepEqual(saved, { approval: 'dontAsk', model: 'claude-sonnet-5' })
  assert.throws(() => buildOtherCliLaunchArgs('claude', saved), /does not support approval "dontAsk"/)
  const blocked = incompatibleOtherCliFields('claude', saved, '--permission-mode <mode>\n--model <model>')
  assert.deepEqual(blocked.map((field) => [field.key, field.value]), [['approval', 'dontAsk']])
})

test('incompatibleOtherCliFields checks each configured flag against the installed CLI help', () => {
  const help = 'Options:\n  --permission-mode <mode>  Permission mode\n  --model <model>  Model'
  assert.deepEqual(incompatibleOtherCliFields('claude', { approval: 'plan', model: 'm' }, help), [])
  assert.deepEqual(incompatibleOtherCliFields('claude', {}, null), [], 'nothing configured needs no check')
  assert.deepEqual(incompatibleOtherCliFields('claude', undefined, null), [])
  // A build whose help has no --model: the model field is named, the supported approval is not.
  const noModel = incompatibleOtherCliFields('claude', { approval: 'plan', model: 'm' }, 'Options:\n  --permission-mode <mode>')
  assert.deepEqual(noModel.map((field) => field.key), ['model'])
  assert.match(noModel[0]!.reason, /does not list --model/)
  // Help that could not be read: every configured field is unverified and blocked.
  assert.deepEqual(incompatibleOtherCliFields('codex', { approval: 'never', sandbox: 'read-only' }, null).map((field) => field.key), ['approval', 'sandbox'])
})

test('Antigravity model is blocked when the resolved agy does not list --model', () => {
  const nodeLikeHelp = 'Usage: node [options] [ script.js ]\n  --version\n  --eval'
  assert.deepEqual(incompatibleOtherCliFields('antigravity', { model: 'model-x' }, nodeLikeHelp).map((field) => field.key), ['model'])
})

test('helpListsFlag matches a whole option name only', () => {
  assert.equal(helpListsFlag('  --model <model>', '--model'), true)
  assert.equal(helpListsFlag('  -m, --model=MODEL', '--model'), true)
  assert.equal(helpListsFlag('  --model-provider <id>', '--model'), false)
  assert.equal(helpListsFlag('  --no-model', '--model'), false)
})

test('validateOtherCliConfig rejects malformed new values instead of dropping them', () => {
  assert.throws(() => validateOtherCliConfig({ claude: { model: '--bad' } }, undefined), /not a usable model name/)
  assert.throws(() => validateOtherCliConfig({ claude: { approval: 'bypassPermissions' } }, undefined), /does not support approval mode/)
  assert.throws(() => validateOtherCliConfig({ bash: { model: 'x' } }, undefined), /Unknown CLI/)
  assert.throws(() => validateOtherCliConfig({ antigravity: { approval: 'plan' } }, undefined), /has no setting "approval"/)
  assert.throws(() => validateOtherCliConfig({ codex: { approval: 5 } }, undefined), /Invalid codex approval/)
  assert.throws(() => validateOtherCliConfig([], undefined), /Invalid settings/)
})

test('validateOtherCliConfig treats an empty value as an intentional clear', () => {
  assert.deepEqual(validateOtherCliConfig({ claude: { approval: '', model: 'claude-sonnet-5' }, codex: { model: '' } }, undefined),
    { claude: { model: 'claude-sonnet-5' } })
  assert.deepEqual(validateOtherCliConfig(undefined, { claude: { model: 'x' } }), {})
})

test('validateOtherCliConfig keeps an unsupported saved level only when it is unchanged', () => {
  const previous = { claude: { approval: 'dontAsk' } }
  assert.deepEqual(validateOtherCliConfig({ claude: { approval: 'dontAsk', model: 'm' } }, previous), { claude: { approval: 'dontAsk', model: 'm' } })
  assert.throws(() => validateOtherCliConfig({ codex: { approval: 'dontAsk' } }, previous), /does not support approval/)
})
