import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SESSION_LAUNCH_CONFIG, buildSessionLaunchArgs, normalizeSessionLaunchConfig } from './session-launch.js'

test('normalizeSessionLaunchConfig returns safe defaults for missing data', () => {
  assert.deepEqual(normalizeSessionLaunchConfig(null), DEFAULT_SESSION_LAUNCH_CONFIG)
})

test('buildSessionLaunchArgs maps a complete launch profile to supported Copilot flags', () => {
  assert.deepEqual(buildSessionLaunchArgs({
    model: 'gpt-5.3-codex',
    reasoningEffort: 'high',
    contextTier: 'long_context',
    mode: 'plan-autopilot',
    maxAutopilotContinues: 12,
    maxAiCredits: 8,
    agent: 'code-review',
    worktree: true,
    screenReader: true,
    remoteControl: 'enable',
    remoteExport: 'disable',
  }, true), [
    '--model', 'gpt-5.3-codex',
    '--effort', 'high',
    '--context', 'long_context',
    '--agent', 'code-review',
    '--plan', '--mode', 'autopilot',
    '--max-autopilot-continues', '12',
    '--max-ai-credits', '8',
    '--worktree',
    '--screen-reader',
    '--remote',
    '--no-remote-export',
  ])
})

test('worktree launch is omitted for resume and remote-connect sessions', () => {
  assert.deepEqual(buildSessionLaunchArgs({ ...DEFAULT_SESSION_LAUNCH_CONFIG, worktree: true }, false), [])
})
