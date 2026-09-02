import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWatchdogEncodedCommand } from './windows-process-watchdog.js'

test('watchdog command is fixed PowerShell with only a validated numeric PID', () => {
  const encoded = buildWatchdogEncodedCommand(4242, { SystemRoot: 'C:\\Windows' })
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.match(script, /ReadToEnd/)
  assert.match(script, /C:\\Windows\\System32\\taskkill\.exe/)
  assert.match(script, /\/PID 4242 \/T \/F/)
  assert.throws(() => buildWatchdogEncodedCommand(Number.NaN))
})
