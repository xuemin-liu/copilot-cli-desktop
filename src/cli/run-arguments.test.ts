import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProgrammaticCopilotArgs, parseProgrammaticRunArguments } from './run-arguments.js'

test('programmatic run arguments parse a complete request', () => {
  const parsed = parseProgrammaticRunArguments([
    'D:\\work\\project', '--prompt', 'Review this repo', '--preset', 'read-only', '--model', 'gpt-5.3-codex',
    '--agent', 'code-review', '--output-format', 'json', '--share', 'review.md', '--autopilot', '--max-ai-credits', '5',
  ])
  assert.equal(parsed.workspace, 'D:\\work\\project')
  assert.equal(parsed.prompt, 'Review this repo')
  assert.equal(parsed.outputFormat, 'json')
  assert.equal(parsed.maxAiCredits, 5)
  assert.deepEqual(buildProgrammaticCopilotArgs(parsed, 'D:\\work\\project'), [
    '--prompt', 'Review this repo', '--output-format', 'json', '--model', 'gpt-5.3-codex',
    '--agent', 'code-review', '--share', 'review.md', '--autopilot', '--max-ai-credits', '5',
    '--available-tools=view,glob,grep,ask_user',
  ])
})

test('programmatic run requires a prompt and rejects unknown options', () => {
  assert.throws(() => parseProgrammaticRunArguments([]), /requires --prompt/)
  assert.throws(() => parseProgrammaticRunArguments(['--wat']), /Unknown run option/)
})
