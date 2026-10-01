import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCopilotCommandArgs, discoverCopilotCapabilities, EMPTY_COPILOT_CAPABILITIES, parseCopilotCapabilities } from './copilot-command.js'
import { buildSessionLaunchArgs, DEFAULT_SESSION_LAUNCH_CONFIG } from './session-launch.js'
import type { CopilotResolution } from './types.js'

const RESOLUTION: CopilotResolution = {
  kind: 'direct',
  command: 'node.exe',
  prefixArgs: ['npm-loader.js'],
  resolvedPath: 'copilot.cmd',
  version: '1.0.60',
  error: null,
}

test('parseCopilotCapabilities detects supported integration surfaces', () => {
  assert.deepEqual(parseCopilotCapabilities(`
    --session-id ID --name NAME --available-tools TOOLS
    --model MODEL --mode MODE --effort LEVEL --remote --connect ID
    --plugin-dir DIRECTORY --acp
  `), {
    sessionIdentity: true,
    toolAllowlist: true,
    launchProfiles: true,
    remoteSessions: true,
    plugins: true,
    acp: true,
    supportedOptions: [
      '--acp', '--available-tools', '--connect', '--effort', '--mode', '--model', '--name', '--plugin-dir',
      '--remote', '--session-id',
    ],
    probeFailed: false,
  })
  assert.deepEqual(parseCopilotCapabilities('old copilot help'), EMPTY_COPILOT_CAPABILITIES)
})

test('parseCopilotCapabilities does not mistake --model for --mode', () => {
  assert.equal(parseCopilotCapabilities('--model MODEL --effort LEVEL').launchProfiles, false)
})

test('buildCopilotCommandArgs preserves the resolved executable prefix', () => {
  assert.deepEqual(buildCopilotCommandArgs(
    { prefixArgs: ['entry.js'] },
    ['plugins', 'install', 'source'],
  ), ['entry.js', 'plugins', 'install', 'source'])
})

test('capability discovery uses the top-level option reference to validate a configured model', async () => {
  const capabilities = await discoverCopilotCapabilities(RESOLUTION, async (resolution, args) => {
    assert.equal(resolution, RESOLUTION)
    assert.deepEqual(args, ['--help'])
    return {
      stdout: 'Options:\n  --model <model>  Set the AI model\n  --mode <mode>\n  --effort <level>',
      stderr: '',
    }
  })
  const launchArgs = buildSessionLaunchArgs({ ...DEFAULT_SESSION_LAUNCH_CONFIG, model: 'gpt-5.3-codex' }, true)
  assert.deepEqual(launchArgs, ['--model', 'gpt-5.3-codex'])
  assert.deepEqual(launchArgs.filter((arg) => arg.startsWith('--') && !capabilities.supportedOptions.includes(arg)), [])
  assert.equal(capabilities.launchProfiles, true)
})

test('capability discovery allows a cold Windows npm CLI load beyond five seconds', async () => {
  const capabilities = await discoverCopilotCapabilities(RESOLUTION, async (_resolution, args, options) => {
    assert.deepEqual(args, ['--help'])
    assert.equal(options?.timeout, 30_000)
    if ((options?.timeout ?? 0) < 12_000) throw new Error('startup timed out')
    return { stdout: '', stderr: '--model <model>' }
  }, async () => { assert.fail('a successful cold load must not retry') })
  assert.deepEqual(capabilities.supportedOptions, ['--model'])
})

test('capability discovery retries a transient probe failure once', async () => {
  let attempts = 0
  const delays: number[] = []
  const timeouts: number[] = []
  const capabilities = await discoverCopilotCapabilities(RESOLUTION, async (_resolution, args, options) => {
    assert.deepEqual(args, ['--help'])
    timeouts.push(options!.timeout!)
    attempts += 1
    if (attempts === 1) throw new Error('CLI update in progress')
    return { stdout: '--model <model>', stderr: '' }
  }, async (milliseconds) => { delays.push(milliseconds) })
  assert.equal(attempts, 2)
  assert.deepEqual(delays, [1_000])
  assert.deepEqual(timeouts, [30_000, 5_000])
  assert.deepEqual(capabilities.supportedOptions, ['--model'])
  assert.equal(capabilities.probeFailed, false)
})

test('capability discovery stays conservative after both probes fail', async () => {
  let attempts = 0
  const delays: number[] = []
  const timeouts: number[] = []
  const capabilities = await discoverCopilotCapabilities(RESOLUTION, async (_resolution, _args, options) => {
    timeouts.push(options!.timeout!)
    attempts += 1
    throw new Error('CLI unavailable')
  }, async (milliseconds) => { delays.push(milliseconds) })
  assert.equal(attempts, 2)
  assert.deepEqual(delays, [1_000])
  assert.deepEqual(timeouts, [30_000, 5_000])
  assert.equal(timeouts.reduce((sum, value) => sum + value, 0) + delays[0]!, 36_000)
  assert.deepEqual(capabilities, { ...EMPTY_COPILOT_CAPABILITIES, probeFailed: true })
})

test('capability discovery does not assume an older CLI supports --model', async () => {
  const capabilities = await discoverCopilotCapabilities(RESOLUTION, async () => ({
    stdout: 'Options:\n  --help  Display help\n  --version  Display version',
    stderr: '',
  }), async () => { assert.fail('a successful help probe must not retry') })
  assert.equal(capabilities.supportedOptions.includes('--model'), false)
  assert.equal(capabilities.launchProfiles, false)
  assert.equal(capabilities.probeFailed, false)
})
