import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { DesktopUpdateController, formatUpdateError, type UpdateAdapter } from './update-controller.js'

class FakeUpdateAdapter extends EventEmitter implements UpdateAdapter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkCalls = 0
  downloadCalls = 0
  installCalls: Array<[boolean | undefined, boolean | undefined]> = []
  checkImpl: () => Promise<unknown> = async () => undefined
  downloadImpl: () => Promise<unknown> = async () => undefined

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1
    return this.checkImpl()
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1
    return this.downloadImpl()
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installCalls.push([isSilent, isForceRunAfter])
  }
}

test('with no adapter, the controller reports unavailable and cannot check', () => {
  const controller = new DesktopUpdateController(null, '0.1.0')
  assert.equal(controller.snapshot.status, 'unavailable')
  assert.equal(controller.snapshot.canCheck, false)
})

test('constructing with an adapter disables autoDownload/autoInstallOnAppQuit', () => {
  const adapter = new FakeUpdateAdapter()
  // eslint-disable-next-line no-new
  new DesktopUpdateController(adapter, '0.1.0')
  assert.equal(adapter.autoDownload, false)
  assert.equal(adapter.autoInstallOnAppQuit, false)
})

test('check() transitions through checking to up-to-date when no update is found', async () => {
  const adapter = new FakeUpdateAdapter()
  const controller = new DesktopUpdateController(adapter, '0.1.0')
  const states: string[] = []
  controller.on('state-changed', (state: { status: string }) => states.push(state.status))
  adapter.checkImpl = async () => {
    adapter.emit('update-not-available')
  }
  await controller.check()
  assert.deepEqual(states, ['checking', 'up-to-date'])
  assert.equal(controller.snapshot.canCheck, true)
})

test('an available update can be downloaded and then installed', async () => {
  const adapter = new FakeUpdateAdapter()
  const controller = new DesktopUpdateController(adapter, '0.1.0')
  adapter.emit('update-available', { version: '0.2.0' })
  assert.equal(controller.snapshot.status, 'available')
  assert.equal(controller.snapshot.availableVersion, '0.2.0')

  adapter.downloadImpl = async () => {
    adapter.emit('update-downloaded', { version: '0.2.0' })
  }
  await controller.download()
  assert.equal(controller.snapshot.status, 'downloaded')
  assert.equal(controller.snapshot.canInstall, true)

  controller.install()
  assert.equal(controller.snapshot.status, 'installing')
  assert.deepEqual(adapter.installCalls, [[false, true]])
})

test('install() throws when nothing has been downloaded', () => {
  const adapter = new FakeUpdateAdapter()
  const controller = new DesktopUpdateController(adapter, '0.1.0')
  assert.throws(() => controller.install(), /No downloaded update/)
})

test('formatUpdateError redacts query strings and maps common network errors', () => {
  assert.match(formatUpdateError(new Error('Request failed: 404')), /No published desktop release/)
  assert.match(formatUpdateError(new Error('getaddrinfo ENOTFOUND example.com')), /could not be reached/)
  assert.doesNotMatch(
    formatUpdateError(new Error('https://example.com/download?token=secret123')),
    /secret123/,
  )
})
