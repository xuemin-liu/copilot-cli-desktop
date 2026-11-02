// Phase 0 evidence runner. Uses only disposable profiles and a loopback model.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveCopilotBinary } from '../dist/src/main/resolve-copilot.js'

const root = resolve(import.meta.dirname, '..')
const directory = resolve(root, 'test-results/workflow-capabilities')
await mkdir(directory, { recursive: true })
const resolution = await resolveCopilotBinary()
const result = {
  schemaVersion: 1, platform: process.platform, cliVersion: resolution.version ?? null,
  startedAt: new Date().toISOString(), completedAt: null, checks: [],
  crashSafeAutomaticResubmission: false,
  limitation: 'PTY write success does not establish consumption. An uncertain submission requires reconciliation; never automatically resend it.',
}
const save = () => writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n')
await save()
async function check(name, args, expectedTest) {
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const collect = chunk => { output = (output + chunk.toString()).slice(-128_000) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  // Child checks own their cleanup; no arbitrary watchdog kills or shared profile writes.
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  const expectedTests=expectedTest?(Array.isArray(expectedTest)?expectedTest:[expectedTest]):[]
  const selected = expectedTests.every(name=>output.split(/\r?\n/).some(line => /^ok \d+ - /.test(line) && line.endsWith(` - ${name}`)))
  const passed = code === 0 && selected
  result.checks.push({ name, passed, exitCode: code, ...(expectedTest ? { expectedTest, selected } : {}) })
  await save()
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}`)
  if (!passed) {
    // Existing diagnostics sanitizer also masks CLI/environment credentials in failures.
    const { redactDiagnosticText } = await import('../dist/src/main/desktop-diagnostics.js')
    await writeFile(resolve(directory, 'failure.txt'), redactDiagnosticText(output))
    throw new Error(`${name} failed; inspect the redacted failure.txt in ${directory}`)
  }
}
try {
  if (!resolution.version) throw new Error('A locally installed Copilot CLI is required; this probe cannot pass by skipping it.')
  await check('binding, live-turn provenance, draft gate, lifecycle and replay fixtures', ['--test',
    'dist/src/main/session-binding.test.js', 'dist/src/main/meeting-turns.test.js',
    'dist/src/main/session-task.test.js', 'dist/src/main/pty-session.test.js',
    'dist/src/main/session-permission-monitor.test.js'])
  const restartTest = 'a process restart during a Git context paste cannot submit or replay input into the replacement process'
  await check('successful restart invalidates pending Enter and held input', ['--test', '--test-reporter=tap',
    '--test-name-pattern=^a process restart during a Git context paste', 'dist/src/main/main-lifecycle.test.js'], restartTest)
  await check('failed restart restoration and eager lifecycle cancellation', ['--test','--test-reporter=tap',
    '--test-name-pattern=^failed restart setup|^slow unload and close|^close requested during failed', 'dist/src/main/main-lifecycle.test.js'], [
    'failed restart setup restores pending input only to the original live process',
    'slow unload and close cancel pending Enter before stopping the process',
    'close requested during failed restart setup wins over restoring pending input',
    'failed restart setup never restores held input after a native conversation switch',
  ])
  await check('real CLI helper and A/B/B/A session switching in one PTY', ['scripts/session-meeting-binding-check.mjs'])
  result.completedAt = new Date().toISOString()
  await save()
  console.log(`Evidence written to ${resolve(directory, 'result.json')}`)
} catch (error) {
  result.completedAt = new Date().toISOString()
  result.failed = true
  await save()
  console.error(error instanceof Error ? error.message : 'Capability probe failed')
  process.exitCode = 1
}
