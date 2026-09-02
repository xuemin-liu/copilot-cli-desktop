import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCopilotCommandArgs, EMPTY_COPILOT_CAPABILITIES, parseCopilotCapabilities } from './copilot-command.js'

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
  })
  assert.deepEqual(parseCopilotCapabilities('old copilot help'), EMPTY_COPILOT_CAPABILITIES)
})

test('parseCopilotCapabilities does not mistake --model for --mode', () => {
  assert.equal(parseCopilotCapabilities('--model MODEL --effort LEVEL').launchProfiles, false)
})

test('buildCopilotCommandArgs inserts secret masking before resource subcommands', () => {
  assert.deepEqual(buildCopilotCommandArgs(
    { prefixArgs: ['entry.js'] },
    ['plugins', 'install', 'source'],
    { GH_TOKEN: 'secret' },
    true,
  ), ['entry.js', '--secret-env-vars=GH_TOKEN', 'plugins', 'install', 'source'])
})
