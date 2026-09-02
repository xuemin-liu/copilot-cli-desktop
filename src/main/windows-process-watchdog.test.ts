import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'
import {
  buildWatchdogEncodedCommand,
  configureWindowsProcessWatchdogReporter,
  startWindowsProcessWatchdog,
} from './windows-process-watchdog.js'

test('watchdog command tracks validated PID messages in one shared process', () => {
  const encoded = buildWatchdogEncodedCommand({ SystemRoot: 'C:\\Windows' })
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.match(script, /ReadLine/)
  assert.match(script, /track \(\[1-9\]\[0-9\]\*\)/)
  assert.match(script, /release \(\[1-9\]\[0-9\]\*\)/)
  assert.match(script, /C:\\Windows\\System32\\taskkill\.exe/)
  assert.match(script, /\/PID \$processId \/T \/F/)
})

test('all leases share one watcher and live PIDs are replayed after recreation', () => {
  const children: Array<{ process: ChildProcess; writes: string[] }> = []
  const failures: string[] = []
  configureWindowsProcessWatchdogReporter((message) => failures.push(message))
  let spawnCount = 0
  const spawnWatchdog = () => {
    spawnCount += 1
    const stdin = new PassThrough()
    const writes: string[] = []
    stdin.on('data', (chunk: Buffer) => writes.push(chunk.toString('utf8')))
    const process = Object.assign(new EventEmitter(), { stdin, unref() {} }) as unknown as ChildProcess
    children.push({ process, writes })
    return process
  }
  const environment = { SystemRoot: 'C:\\Windows' }
  const first = startWindowsProcessWatchdog(111, environment, spawnWatchdog)
  const second = startWindowsProcessWatchdog(222, environment, spawnWatchdog)
  assert.equal(spawnCount, 1)
  assert.equal(children[0]?.writes.join(''), 'track 111\ntrack 222\n')

  children[0]?.process.emit('exit', 1, null)
  const third = startWindowsProcessWatchdog(333, environment, spawnWatchdog)
  assert.equal(spawnCount, 2)
  assert.equal(children[1]?.writes.join(''), 'track 111\ntrack 222\ntrack 333\n')
  assert.equal(failures.length, 1)

  first.release()
  second.release()
  third.release()
  first.release()
  assert.equal(
    children[1]?.writes.join(''),
    'track 111\ntrack 222\ntrack 333\nrelease 111\nrelease 222\nrelease 333\n',
  )
})
