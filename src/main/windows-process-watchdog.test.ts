import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'
import { buildWatchdogEncodedCommand, startWindowsProcessWatchdog } from './windows-process-watchdog.js'

test('watchdog command tracks validated PID messages in one shared process', () => {
  const encoded = buildWatchdogEncodedCommand({ SystemRoot: 'C:\\Windows' })
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.match(script, /ReadLine/)
  assert.match(script, /track \(\[1-9\]\[0-9\]\*\)/)
  assert.match(script, /release \(\[1-9\]\[0-9\]\*\)/)
  assert.match(script, /C:\\Windows\\System32\\taskkill\.exe/)
  assert.match(script, /\/PID \$processId \/T \/F/)
})

test('all process leases share one watcher and release independently', () => {
  const stdin = new PassThrough()
  const writes: string[] = []
  stdin.on('data', (chunk: Buffer) => writes.push(chunk.toString('utf8')))
  const child = Object.assign(new EventEmitter(), { stdin, unref() {} }) as unknown as ChildProcess
  let spawnCount = 0
  const spawnWatchdog = () => {
    spawnCount += 1
    return child
  }
  const environment = { SystemRoot: 'C:\\Windows' }
  const first = startWindowsProcessWatchdog(111, environment, spawnWatchdog)
  const second = startWindowsProcessWatchdog(222, environment, spawnWatchdog)
  first.release()
  second.release()
  first.release()
  assert.equal(spawnCount, 1)
  assert.equal(writes.join(''), 'track 111\ntrack 222\nrelease 111\nrelease 222\n')
})
