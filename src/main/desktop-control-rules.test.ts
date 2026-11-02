import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceleratorChord, appDisplayName, blankRects, canStartPrograms, desktopBlockReason, desktopFrameSize, DesktopRateLimiter,
  framePointToScreen, identityKey, parseDesktopChord, patchesMatch, patchRect, screenRectToFrame, validateDesktopText,
} from './desktop-control-rules.js'

const OWN = 'C:\\Program Files\\Copilot CLI Desktop\\Copilot CLI Desktop.exe'
const program = (path: string, className = 'Window', elevated: boolean | null = false) => ({ identity: { kind: 'program' as const, path }, className, elevated })

test('the app itself, terminals, launchers, credential and system tools are always blocked', () => {
  assert.equal(desktopBlockReason(program(OWN), OWN), 'self')
  assert.equal(desktopBlockReason(program(OWN.toLowerCase()), OWN), 'self')
  for (const terminal of ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\Git\\usr\\bin\\mintty.exe']) {
    assert.equal(desktopBlockReason(program(terminal), OWN), 'terminal', terminal)
  }
  // Any console host, whatever program owns it.
  assert.equal(desktopBlockReason(program('C:\\Tools\\something.exe', 'ConsoleWindowClass'), OWN), 'terminal')
  assert.equal(desktopBlockReason(program('C:\\Tools\\something.exe', 'CASCADIA_HOSTING_WINDOW_CLASS'), OWN), 'terminal')
  for (const launcher of ['C:\\Windows\\explorer.exe', 'C:\\Windows\\SystemApps\\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\\StartMenuExperienceHost.exe', 'C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\SearchHost.exe']) {
    assert.equal(desktopBlockReason(program(launcher), OWN), 'launcher', launcher)
  }
  assert.equal(desktopBlockReason(program('C:\\Windows\\System32\\CredentialUIBroker.exe'), OWN), 'credentials')
  assert.equal(desktopBlockReason(program('C:\\Program Files\\KeePassXC\\KeePassXC.exe'), OWN), 'credentials')
  assert.equal(desktopBlockReason(program('C:\\Windows\\System32\\Taskmgr.exe'), OWN), 'system')
  assert.equal(desktopBlockReason(program('C:\\Windows\\regedit.exe'), OWN), 'system')
  assert.equal(desktopBlockReason(program('C:\\Windows\\System32\\mmc.exe'), OWN), 'system')
})

test('packaged apps are matched by AppUserModelID, and the frame host itself is never approved', () => {
  const settings = { identity: { kind: 'package' as const, aumid: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' }, className: 'ApplicationFrameWindow', elevated: false }
  assert.equal(desktopBlockReason(settings, OWN), 'system')
  const calculator = { identity: { kind: 'package' as const, aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }, className: 'ApplicationFrameWindow', elevated: false }
  assert.equal(desktopBlockReason(calculator, OWN), null)
  assert.equal(appDisplayName(calculator.identity), 'WindowsCalculator')
  assert.equal(desktopBlockReason(program('C:\\Windows\\System32\\ApplicationFrameHost.exe'), OWN), 'unidentified')
  assert.equal(desktopBlockReason({ identity: null, className: 'X', elevated: false }, OWN), 'unidentified')
  assert.notEqual(identityKey(calculator.identity), identityKey({ kind: 'package', aumid: 'Microsoft.WindowsStore_8wekyb3d8bbwe!App' }))
})

test('an elevated window, or one whose elevation is unknown, is blocked', () => {
  assert.equal(desktopBlockReason(program('C:\\Windows\\notepad.exe', 'Notepad', true), OWN), 'elevated')
  assert.equal(desktopBlockReason(program('C:\\Windows\\notepad.exe', 'Notepad', null), OWN), 'elevated')
  assert.equal(desktopBlockReason(program('C:\\Windows\\notepad.exe', 'Notepad', false), OWN), null)
})

test('apps that can start programs are flagged for a warning', () => {
  assert.equal(canStartPrograms({ kind: 'program', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }), true)
  assert.equal(canStartPrograms({ kind: 'program', path: 'C:\\Users\\a\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' }), true)
  assert.equal(canStartPrograms({ kind: 'program', path: 'C:\\Windows\\notepad.exe' }), false)
})

test('key chords come from a fixed list without Win-key, system or the app’s own shortcuts', () => {
  const reserved = ['CommandOrControl+Alt+H', 'Control+Alt+Shift+X']
  assert.deepEqual(parseDesktopChord('ctrl+s', reserved), { modifiers: ['ctrl'], key: 's', vks: [0x11, 0x53] })
  assert.deepEqual(parseDesktopChord('Shift+Ctrl+Tab', reserved).vks, [0x11, 0x10, 0x09])
  assert.equal(parseDesktopChord('enter', reserved).vks[0], 0x0d)
  assert.equal(parseDesktopChord('esc', reserved).key, 'escape')
  for (const refused of ['win+r', 'win+x', 'meta+e', 'win', 'ctrl+esc', 'ctrl+shift+escape', 'alt+tab', 'ctrl+alt+h', 'ctrl+alt+shift+x', 'ctrl+alt+delete']) {
    assert.throws(() => parseDesktopChord(refused, reserved), Error, refused)
  }
  assert.throws(() => parseDesktopChord('ctrl+nope', reserved), /Unknown key/)
  assert.throws(() => parseDesktopChord('hyper+a', reserved), /Unknown modifier/)
  assert.equal(acceleratorChord('CommandOrControl+Alt+H'), 'ctrl+alt+h')
})

test('typed text is bounded and has no control characters other than new lines and tabs', () => {
  assert.equal(validateDesktopText('a\r\nb\tc'), 'a\nb\tc')
  assert.equal(validateDesktopText('\uFEFFhé'), 'hé')
  assert.throws(() => validateDesktopText(''), /no text/)
  assert.throws(() => validateDesktopText('a\u0007'), /control characters/)
  assert.throws(() => validateDesktopText('é'.repeat(2049)), /4 KiB/)
  assert.throws(() => validateDesktopText(3), /no text/)
})

test('frames are scaled down to 1568 px and points map back to physical pixels', () => {
  assert.deepEqual(desktopFrameSize({ width: 3840, height: 2160 }), { width: 1568, height: 882 })
  assert.deepEqual(desktopFrameSize({ width: 800, height: 600 }), { width: 800, height: 600 })
  const frame = { bounds: { x: -710, y: -2160, width: 3840, height: 2160 }, width: 1568, height: 882 }
  assert.deepEqual(framePointToScreen(frame, 0, 0), { x: -709, y: -2159 })
  assert.deepEqual(framePointToScreen(frame, 784, 441), { x: -710 + 1921, y: -2160 + 1081 })
  assert.throws(() => framePointToScreen(frame, 1568, 0), /outside/)
  assert.throws(() => framePointToScreen(frame, -1, 0), /outside/)
  assert.throws(() => framePointToScreen(frame, '1', 0), /numbers/)
  assert.deepEqual(screenRectToFrame(frame, { x: -710, y: -2160, width: 3840, height: 2160 }), { x: 0, y: 0, width: 1568, height: 882 })
})

test('a caret-sized change in the patch still matches; a dialog does not', () => {
  const size = { width: 100, height: 100 }
  const before = Buffer.alloc(size.width * size.height * 4, 200)
  const caret = Buffer.from(before)
  for (let y = 40; y < 56; y++) caret.fill(0, (y * size.width + 50) * 4, (y * size.width + 51) * 4)
  const patch = patchRect(size, 50, 50)
  assert.deepEqual(patch, { x: 18, y: 18, width: 64, height: 64 })
  assert.equal(patchesMatch(before, caret, size, patch), true)
  const dialog = Buffer.from(before)
  blankRects(dialog, size, [{ x: 30, y: 30, width: 40, height: 40 }])
  assert.equal(patchesMatch(before, dialog, size, patch), false)
  // A change outside the patch is not seen (the documented limit).
  const elsewhere = Buffer.from(before)
  blankRects(elsewhere, size, [{ x: 0, y: 0, width: 10, height: 10 }])
  assert.equal(patchesMatch(before, elsewhere, size, patch), true)
  assert.equal(patchesMatch(before, Buffer.alloc(4), size, patch), false)
  assert.deepEqual(patchRect(size, 2, 98), { x: 0, y: 66, width: 64, height: 34 })
})

test('at most ten actions a second', () => {
  let now = 0
  const limiter = new DesktopRateLimiter(10, () => now)
  for (let index = 0; index < 10; index++) assert.equal(limiter.take(), true)
  assert.equal(limiter.take(), false)
  now = 999
  assert.equal(limiter.take(), false)
  now = 1000
  assert.equal(limiter.take(), true)
})
