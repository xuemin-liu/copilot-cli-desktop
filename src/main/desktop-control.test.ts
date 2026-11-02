import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DesktopControl, DesktopControlError, desktopControlStatePath, type DesktopApproval, type DesktopControlHost } from './desktop-control.js'
import type { DesktopInputMonitor, DesktopNativeLayer } from './desktop-native.js'
import type { DesktopNativeFocus, DesktopNativeWindow } from './desktop-native-types.js'
import type { DesktopRect } from './desktop-control-rules.js'

const OWN = 'C:\\Program Files\\Copilot CLI Desktop\\Copilot CLI Desktop.exe'
const NOTEPAD = 'C:\\Windows\\notepad.exe'

function window(id: string, programPath: string, bounds: DesktopRect, extra: Partial<DesktopNativeWindow> = {}): DesktopNativeWindow {
  return { id, pid: Number(id), title: `${id} title`, className: 'Window', bounds, minimized: false, clickThrough: false, toolWindow: false, owner: null, programPath, aumid: null, elevated: false, ...extra }
}

class FakeNative implements DesktopNativeLayer {
  list: DesktopNativeWindow[] = []
  front: string | null = null
  focus_: DesktopNativeFocus = { pid: null, password: false }
  actions: string[] = []
  onType: (() => void) | null = null
  async windows(): Promise<DesktopNativeWindow[]> { return this.list.map(entry => ({ ...entry })) }
  async foreground(): Promise<string | null> { return this.front }
  async focus(id: string): Promise<boolean> { this.actions.push(`focus ${id}`); this.front = id; return true }
  async cursor(): Promise<{ x: number; y: number }> { return { x: 0, y: 0 } }
  async move(x: number, y: number): Promise<void> { this.actions.push(`move ${x},${y}`) }
  async click(x: number, y: number, button: string, count: number): Promise<void> { this.actions.push(`click ${x},${y} ${button} ${count}`) }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> { this.actions.push(`drag ${from.x},${from.y} ${to.x},${to.y}`) }
  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> { this.actions.push(`scroll ${x},${y} ${dx},${dy}`) }
  async key(vks: number[]): Promise<void> { this.actions.push(`key ${vks.join(',')}`) }
  async type(text: string): Promise<void> { this.actions.push(`type ${text}`); this.onType?.() }
  async focused(): Promise<DesktopNativeFocus> { return this.focus_ }
  async desktopAvailable(): Promise<boolean> { return true }
  async dispose(): Promise<void> {}
}

class FakeMonitor implements DesktopInputMonitor {
  count = 0
  lastAt = 0
  running = false
  async start(): Promise<void> { this.running = true }
  async stop(): Promise<void> { this.running = false }
  read(): { count: number; lastAt: number } { return { count: this.count, lastAt: this.lastAt } }
  userInput(at = Date.now()): void { this.count++; this.lastAt = at }
}

interface Harness {
  control: DesktopControl
  native: FakeNative
  monitor: FakeMonitor
  folder: string
  answers: DesktopApproval[]
  asked: string[]
  /** Change what the next capture shows. */
  paint: (fill: number) => void
  overlay: Array<{ active: boolean; paused: boolean }>
  refusal: { value: string | null }
}

async function harness(t: test.TestContext): Promise<Harness> {
  const folder = await mkdtemp(join(tmpdir(), 'desktop-control-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const native = new FakeNative()
  const monitor = new FakeMonitor()
  const answers: DesktopApproval[] = []
  const asked: string[] = []
  const overlay: Array<{ active: boolean; paused: boolean }> = []
  let fill = 200
  const refusal = { value: null as string | null }
  const host: DesktopControlHost = {
    ownProgramPath: OWN,
    reservedAccelerators: () => ['CommandOrControl+Alt+H', 'Control+Alt+Shift+X'],
    stopKeyLabel: 'Ctrl+Alt+Shift+X',
    sessionFolder: () => folder,
    sessionRefusal: () => refusal.value,
    sessionTitle: () => 'Session',
    approve: async request => { asked.push(request.app); return answers.shift() ?? 'deny' },
    displays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1, primary: true }],
    capture: async (_bounds, size) => Buffer.alloc(size.width * size.height * 4, fill),
    encodePng: () => Buffer.from('png'),
    overlay: state => overlay.push(state),
    stopKey: () => true,
    changed: () => {},
    locked: () => false,
    log: () => {},
  }
  const control = new DesktopControl(host, native, monitor)
  t.after(() => control.dispose())
  return { control, native, monitor, folder, answers, asked, paint: value => { fill = value }, overlay, refusal }
}

/** Notepad at (100,100) 400×300, in front of everything, focused, with a session-approved grant. */
async function notepadReady(h: Harness): Promise<string> {
  h.native.list = [window('11', NOTEPAD, { x: 100, y: 100, width: 400, height: 300 }, { className: 'Notepad' })]
  h.native.front = '11'
  h.native.focus_ = { pid: 11, password: false }
  await h.control.enable('tab')
  h.answers.push('session')
  const shot = await h.control.handle('tab', 'screenshot', { target: '11' })
  // The approval prompt raised this app's window; the window that was in front is put back.
  assert.deepEqual(h.native.actions, ['focus 11'])
  h.native.actions.length = 0
  return shot.frameId as string
}

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof DesktopControlError && pattern.test(error.message))
}

test('requests are refused until the person turns control on, and the state file holds the token only while it is on', async t => {
  const h = await harness(t)
  await refused(h.control.handle('tab', 'status', {}), /off for this session/)
  h.refusal.value = 'Allow desktop control in Settings first.'
  await refused(h.control.enable('tab'), /Settings/)
  h.refusal.value = null
  await h.control.enable('tab')
  assert.equal(h.monitor.running, true)
  assert.deepEqual(h.overlay.at(-1), { active: true, paused: false })
  const state = JSON.parse(await readFile(desktopControlStatePath(h.folder), 'utf8')) as { token: string; port: number }
  assert.match(state.token, /^[a-f0-9]{64}$/)
  assert.equal((await h.control.handle('tab', 'status', {})).enabled, true)
  await h.control.disable('tab')
  assert.equal(existsSync(desktopControlStatePath(h.folder)), false)
  assert.equal(h.monitor.running, false)
  assert.deepEqual(h.overlay.at(-1), { active: false, paused: false })
  await refused(h.control.handle('tab', 'windows', {}), /off for this session/)
})

test('only one session controls the desktop at a time', async t => {
  const h = await harness(t)
  await h.control.enable('a')
  await h.control.enable('b')
  assert.deepEqual(h.control.enabledTabs(), ['b'])
  assert.match(h.control.view('a').log.at(-1)!.message, /another session/)
})

test('blocked windows are refused without asking; other apps need the person’s approval', async t => {
  const h = await harness(t)
  h.native.list = [
    window('1', OWN, { x: 0, y: 0, width: 300, height: 300 }),
    window('2', 'C:\\Windows\\System32\\cmd.exe', { x: 0, y: 0, width: 300, height: 300 }, { className: 'ConsoleWindowClass' }),
    window('3', 'C:\\Windows\\explorer.exe', { x: 0, y: 0, width: 300, height: 300 }, { className: 'CabinetWClass', title: 'Secret folder' }),
    window('4', NOTEPAD, { x: 0, y: 0, width: 300, height: 300 }),
  ]
  await h.control.enable('tab')
  for (const id of ['1', '2', '3']) await refused(h.control.handle('tab', 'screenshot', { target: id }), /never controlled|Terminals|File Explorer/)
  assert.deepEqual(h.asked, [])
  const listed = (await h.control.handle('tab', 'windows', {})).windows as Array<{ id: string; title: string; status: string }>
  assert.equal(listed.find(entry => entry.id === '3')!.title, '')
  assert.match(listed.find(entry => entry.id === '3')!.status, /^blocked/)
  assert.equal(listed.find(entry => entry.id === '4')!.status, 'needs approval')
  h.answers.push('deny')
  await refused(h.control.handle('tab', 'screenshot', { target: '4' }), /did not allow/)
  h.answers.push('once')
  await h.control.handle('tab', 'screenshot', { target: '4' })
  assert.deepEqual(h.control.view('tab').approvedApps, [])
  h.answers.push('session')
  const shot = await h.control.handle('tab', 'screenshot', { target: '4' })
  assert.deepEqual(h.control.view('tab').approvedApps.map(app => app.name), ['notepad'])
  assert.equal(await readFile(shot.path as string, 'utf8'), 'png')
  assert.deepEqual(h.asked, ['notepad', 'notepad', 'notepad'])
  // Approved for the session: no further prompt.
  await h.control.handle('tab', 'screenshot', { target: '4' })
  assert.equal(h.asked.length, 3)
})

test('a click lands on the mapped physical point of a fresh frame', async t => {
  const h = await harness(t)
  const frameId = await notepadReady(h)
  await h.control.handle('tab', 'click', { frameId, x: 10, y: 20 })
  await h.control.handle('tab', 'click', { frameId, x: 10, y: 20, button: 'right', double: true })
  assert.deepEqual(h.native.actions, ['click 110,120 left 1', 'click 110,120 right 2'])
  assert.equal(h.control.view('tab').log.at(-1)!.result, 'ok')
})

test('stale, unknown and changed frames are refused', async t => {
  const h = await harness(t)
  const frameId = await notepadReady(h)
  await refused(h.control.handle('tab', 'click', { frameId: 'f000000000000', x: 1, y: 1 }), /no longer kept/)
  await refused(h.control.handle('tab', 'click', { frameId: 'nope', x: 1, y: 1 }), /frameId/)
  // The pixels around the point changed (a dialog was drawn inside the window).
  h.paint(30)
  await refused(h.control.handle('tab', 'click', { frameId, x: 10, y: 20 }), /changed around that point/)
  h.paint(200)
  // The window moved.
  h.native.list[0]!.bounds = { x: 120, y: 100, width: 400, height: 300 }
  await refused(h.control.handle('tab', 'click', { frameId, x: 10, y: 20 }), /moved, resized or closed/)
  h.native.list[0]!.bounds = { x: 100, y: 100, width: 400, height: 300 }
  // The screen locked or changed: every frame from before is dropped.
  h.control.invalidateFrames()
  await refused(h.control.handle('tab', 'click', { frameId, x: 10, y: 20 }), /screen changed/)
  assert.deepEqual(h.native.actions, [])
})

test('a point covered by another app or a blocked window is refused', async t => {
  const h = await harness(t)
  const frameId = await notepadReady(h)
  h.native.list.unshift(window('9', 'C:\\Windows\\System32\\cmd.exe', { x: 100, y: 100, width: 50, height: 50 }, { className: 'ConsoleWindowClass' }))
  await refused(h.control.handle('tab', 'click', { frameId, x: 10, y: 10 }), /blocked window/)
  h.native.list[0] = window('8', 'C:\\Program Files\\Paint\\paint.exe', { x: 100, y: 100, width: 50, height: 50 })
  await refused(h.control.handle('tab', 'click', { frameId, x: 10, y: 10 }), /another app’s window/)
  // A click-through window (the on-screen banner) is not in the way.
  h.native.list[0] = window('7', OWN, { x: 0, y: 0, width: 1000, height: 800 }, { clickThrough: true })
  await h.control.handle('tab', 'click', { frameId, x: 10, y: 10 })
  assert.deepEqual(h.native.actions, ['click 110,110 left 1'])
})

test('typing needs the frame’s app to have the keyboard focus and never goes into a password field', async t => {
  const h = await harness(t)
  const frameId = await notepadReady(h)
  h.native.focus_ = { pid: 11, password: true }
  await refused(h.control.handle('tab', 'type', { frameId, text: 'secret' }), /password field/)
  h.native.focus_ = { pid: 11, password: null }
  await refused(h.control.handle('tab', 'type', { frameId, text: 'secret' }), /password field/)
  h.native.focus_ = { pid: 99, password: false }
  await refused(h.control.handle('tab', 'type', { frameId, text: 'hello' }), /could not tell/)
  h.native.focus_ = { pid: 11, password: false }
  const text = 'x'.repeat(40)
  await h.control.handle('tab', 'type', { frameId, text })
  assert.deepEqual(h.native.actions, [`type ${'x'.repeat(32)}`, `type ${'x'.repeat(8)}`])
  h.native.list.push(window('12', 'C:\\Program Files\\Paint\\paint.exe', { x: 600, y: 100, width: 100, height: 100 }))
  h.native.front = '12'
  await refused(h.control.handle('tab', 'type', { frameId, text: 'hi' }), /another app/)
})

test('key chords that open launchers or press the app’s own shortcuts are refused', async t => {
  const h = await harness(t)
  const frameId = await notepadReady(h)
  for (const chord of ['win+r', 'ctrl+alt+h', 'ctrl+alt+shift+x', 'ctrl+escape']) {
    await assert.rejects(h.control.handle('tab', 'key', { frameId, chord }))
  }
  await h.control.handle('tab', 'key', { frameId, chord: 'ctrl+s' })
  assert.deepEqual(h.native.actions, ['key 17,83'])
})

test('the person’s own input pauses control, and recent input defers an action', async t => {
  const h = await harness(t)
  const frameId = await notepadReady(h)
  h.monitor.userInput()
  await refused(h.control.handle('tab', 'click', { frameId, x: 10, y: 10 }), /using the mouse or keyboard/)
  h.monitor.lastAt = 0
  h.native.onType = () => h.monitor.userInput(0)
  await refused(h.control.handle('tab', 'type', { frameId, text: 'y'.repeat(70) }), /during the action/)
  assert.equal(h.control.view('tab').paused, true)
  assert.deepEqual(h.overlay.at(-1), { active: true, paused: true })
  assert.equal(h.native.actions.length, 1)
  await refused(h.control.handle('tab', 'click', { frameId, x: 10, y: 10 }), /paused/)
  h.control.resume('tab')
  h.native.onType = null
  assert.equal(h.control.view('tab').paused, false)
})

test('a full-screen capture needs its own grant and paints over blocked windows', async t => {
  const h = await harness(t)
  let blanked: DesktopRect[] = []
  ;(h.control as unknown as { host: DesktopControlHost }).host.capture = async (_bounds, size, blank) => { blanked = blank; return Buffer.alloc(size.width * size.height * 4) }
  h.native.list = [
    window('2', 'C:\\Windows\\System32\\cmd.exe', { x: 10, y: 10, width: 300, height: 200 }, { className: 'ConsoleWindowClass' }),
    window('4', NOTEPAD, { x: 0, y: 0, width: 500, height: 500 }),
  ]
  await h.control.enable('tab')
  await refused(h.control.handle('tab', 'screenshot', { target: 'screen' }), /full-screen/)
  h.answers.push('session')
  const shot = await h.control.handle('tab', 'screenshot', { target: 'screen' })
  assert.equal(shot.kind, 'screen')
  assert.deepEqual(blanked, [{ x: 10, y: 10, width: 300, height: 200 }])
  assert.equal(h.control.view('tab').fullScreen, true)
  await refused(h.control.handle('tab', 'screenshot', { target: 'screen:4' }), /no display 4/)
})

function post(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('the loopback endpoint needs the session’s token and refuses browser-originated requests', async t => {
  const h = await harness(t)
  await h.control.enable('tab')
  const { port, token } = JSON.parse(await readFile(desktopControlStatePath(h.folder), 'utf8')) as { port: number; token: string }
  assert.equal((await post(port, '/desktop/status', { authorization: `Bearer ${token}`, origin: 'https://example.com' }, '{}')).status, 403)
  assert.equal((await post(port, '/desktop/status', { authorization: `Bearer ${'0'.repeat(64)}` }, '{}')).status, 401)
  const ok = await post(port, '/desktop/status', { authorization: `Bearer ${token}` }, '{}')
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).enabled, true)
  assert.equal((await post(port, '/desktop/nope', { authorization: `Bearer ${token}` }, '{}')).status, 404)
  await h.control.disable('tab')
  assert.equal((await post(port, '/desktop/status', { authorization: `Bearer ${token}` }, '{}')).status, 401)
})
