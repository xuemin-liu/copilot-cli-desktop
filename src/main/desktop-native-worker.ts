import { parentPort } from 'node:worker_threads'
import koffi from 'koffi'
import type { DesktopNativeRequest, DesktopNativeWindow, DesktopNativeFocus } from './desktop-native-types.js'

/**
 * Win32 and UI Automation calls for desktop control, in a worker so a slow app or a UI Automation call never blocks the
 * app's UI. Every call here is one the main process asked for after applying its rules; this file decides nothing.
 */

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')
const dwmapi = koffi.load('dwmapi.dll')
const ole32 = koffi.load('ole32.dll')

const RECT = koffi.struct('DC_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
const POINT = koffi.struct('DC_POINT', { x: 'int32', y: 'int32' })
const INPUT_MOUSE = koffi.struct('DC_INPUT_MOUSE', {
  type: 'uint32', pad0: 'uint32', dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', pad1: 'uint32', extra: 'uintptr',
})
const INPUT_KEY = koffi.struct('DC_INPUT_KEY', {
  type: 'uint32', pad0: 'uint32', wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', pad1: 'uint32', extra: 'uintptr', pad2: koffi.array('uint8', 8),
})
const GUID = koffi.struct('DC_GUID', { a: 'uint32', b: 'uint16', c: 'uint16', d: koffi.array('uint8', 8) })

const EnumProc = koffi.proto('bool __stdcall DC_EnumProc(intptr hwnd, intptr lParam)')
const EnumWindows = user32.func('bool __stdcall EnumWindows(DC_EnumProc *proc, intptr lParam)')
const EnumChildWindows = user32.func('bool __stdcall EnumChildWindows(intptr parent, DC_EnumProc *proc, intptr lParam)')
const IsWindow = user32.func('bool __stdcall IsWindow(intptr hwnd)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr hwnd)')
const IsIconic = user32.func('bool __stdcall IsIconic(intptr hwnd)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16_t *text, int max)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr hwnd, _Out_ uint16_t *text, int max)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32_t *pid)')
const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)')
const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 command)')
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr hwnd)')
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr hwnd)')
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr hwnd, int command)')
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 from, uint32 to, bool attach)')
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ DC_POINT *point)')
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)')
const SendMouse = user32.func('uint32 __stdcall SendInput(uint32 count, DC_INPUT_MOUSE *inputs, int size)')
const SendKeys = user32.func('uint32 __stdcall SendInput(uint32 count, DC_INPUT_KEY *inputs, int size)')
const OpenInputDesktop = user32.func('intptr __stdcall OpenInputDesktop(uint32 flags, bool inherit, uint32 access)')
const CloseDesktop = user32.func('bool __stdcall CloseDesktop(intptr desktop)')
const GetUserObjectInformationW = user32.func('bool __stdcall GetUserObjectInformationW(intptr object, int index, _Out_ uint16_t *info, uint32 length, _Out_ uint32_t *needed)')
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')
const OpenProcess = kernel32.func('intptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr handle)')
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr process, uint32 flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)')
const GetApplicationUserModelId = kernel32.func('int32 __stdcall GetApplicationUserModelId(intptr process, _Inout_ uint32_t *length, _Out_ uint16_t *id)')
const OpenProcessToken = advapi32.func('bool __stdcall OpenProcessToken(intptr process, uint32 access, _Out_ intptr *token)')
const GetTokenInformation = advapi32.func('bool __stdcall GetTokenInformation(intptr token, int kind, _Out_ uint32_t *info, uint32 length, _Out_ uint32_t *returned)')
const DwmGetWindowRect = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attribute, _Out_ DC_RECT *value, uint32 size)')
const DwmGetWindowFlag = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attribute, _Out_ uint32_t *value, uint32 size)')
const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 flags)')
const CoCreateInstance = ole32.func('int32 __stdcall CoCreateInstance(DC_GUID *clsid, void *outer, uint32 context, DC_GUID *iid, _Out_ void **object)')

const GetFocusedElement = koffi.proto('int32 __stdcall DC_GetFocusedElement(void *self, _Out_ void **element)')
const GetIntProperty = koffi.proto('int32 __stdcall DC_GetIntProperty(void *self, _Out_ int *value)')
const Release = koffi.proto('uint32 __stdcall DC_Release(void *self)')

const GWL_EXSTYLE = -20
const WS_EX_TRANSPARENT = 0x20
const WS_EX_LAYERED = 0x80000
const WS_EX_TOOLWINDOW = 0x80
const GW_OWNER = 4
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TOKEN_ELEVATION = 20
/** Marks the app's own input in `dwExtraInfo` ('CPLD'). */
const INPUT_TAG = 0x43504c44
const MOUSEEVENTF = { move: 0x1, leftDown: 0x2, leftUp: 0x4, rightDown: 0x8, rightUp: 0x10, middleDown: 0x20, middleUp: 0x40, wheel: 0x800, hwheel: 0x1000, virtualDesk: 0x4000, absolute: 0x8000 }
const KEYEVENTF = { extended: 0x1, up: 0x2, unicode: 0x4 }
const EXTENDED_KEYS = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5d])

function text16(read: (buffer: Uint16Array, length: number) => number, length = 512): string {
  const buffer = new Uint16Array(length)
  const count = read(buffer, length)
  return count > 0 ? String.fromCharCode(...buffer.subarray(0, Math.min(count, length))) : ''
}

function rectOf(hwnd: number): { x: number; y: number; width: number; height: number } | null {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (DwmGetWindowRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, koffi.sizeof(RECT)) !== 0) return null
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
}

function cloaked(hwnd: number): boolean {
  const value = [0]
  return DwmGetWindowFlag(hwnd, DWMWA_CLOAKED, value, 4) === 0 && value[0] !== 0
}

interface ProcessFacts { path: string | null; aumid: string | null; elevated: boolean | null }

function processFacts(pid: number): ProcessFacts {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return { path: null, aumid: null, elevated: null }
  try {
    const nameBuffer = new Uint16Array(1024)
    const size = [1024]
    const path = QueryFullProcessImageNameW(handle, 0, nameBuffer, size) ? String.fromCharCode(...nameBuffer.subarray(0, size[0])) : null
    const idBuffer = new Uint16Array(256)
    const idLength = [256]
    const aumid = GetApplicationUserModelId(handle, idLength, idBuffer) === 0
      ? String.fromCharCode(...idBuffer.subarray(0, Math.max(0, idLength[0]! - 1)))
      : null
    let elevated: boolean | null = null
    const token = [0]
    if (OpenProcessToken(handle, TOKEN_QUERY, token)) {
      const value = [0]
      const returned = [0]
      if (GetTokenInformation(token[0]!, TOKEN_ELEVATION, value, 4, returned)) elevated = value[0] !== 0
      CloseHandle(token[0]!)
    }
    return { path, aumid, elevated }
  } finally { CloseHandle(handle) }
}

/** A packaged app's window belongs to ApplicationFrameHost; its app is the process behind the hosted CoreWindow. */
function hostedAppPid(hwnd: number, framePid: number): number | null {
  let found: number | null = null
  EnumChildWindows(hwnd, (child: number) => {
    if (text16((buffer, length) => GetClassNameW(child, buffer, length), 128) !== 'Windows.UI.Core.CoreWindow') return true
    const pid = [0]
    GetWindowThreadProcessId(child, pid)
    if (pid[0] && pid[0] !== framePid) { found = pid[0]; return false }
    return true
  }, 0)
  return found
}

function listWindows(): DesktopNativeWindow[] {
  const handles: number[] = []
  EnumWindows((hwnd: number) => { handles.push(hwnd); return true }, 0)
  const facts = new Map<number, ProcessFacts>()
  const factsOf = (pid: number): ProcessFacts => {
    let value = facts.get(pid)
    if (!value) { value = processFacts(pid); facts.set(pid, value) }
    return value
  }
  const windows: DesktopNativeWindow[] = []
  for (const hwnd of handles) {
    if (!IsWindowVisible(hwnd) || cloaked(hwnd)) continue
    const bounds = rectOf(hwnd)
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue
    const pidOut = [0]
    GetWindowThreadProcessId(hwnd, pidOut)
    const pid = pidOut[0]!
    const className = text16((buffer, length) => GetClassNameW(hwnd, buffer, length), 256)
    const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
    let process = factsOf(pid)
    let appPid = pid
    let packaged = false
    if (className === 'ApplicationFrameWindow') {
      const hosted = hostedAppPid(hwnd, pid)
      if (hosted) { appPid = hosted; process = factsOf(hosted); packaged = true } else process = { path: null, aumid: null, elevated: process.elevated }
    }
    windows.push({
      id: String(hwnd),
      pid: appPid,
      title: text16((buffer, length) => GetWindowTextW(hwnd, buffer, length), 512),
      className,
      bounds,
      minimized: IsIconic(hwnd),
      clickThrough: (exStyle & WS_EX_TRANSPARENT) !== 0 && (exStyle & WS_EX_LAYERED) !== 0,
      toolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0,
      owner: String(Number(GetWindow(hwnd, GW_OWNER)) || '') || null,
      programPath: packaged ? null : process.path,
      aumid: packaged ? process.aumid : null,
      elevated: process.elevated,
    })
  }
  return windows
}

function foreground(): string | null {
  const hwnd = Number(GetForegroundWindow())
  return hwnd ? String(hwnd) : null
}

function focusWindow(id: string): boolean {
  const hwnd = Number(id)
  if (!IsWindow(hwnd)) throw new Error('The window is gone.')
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9)
  const current = GetCurrentThreadId()
  const foregroundHwnd = Number(GetForegroundWindow())
  const foregroundThread = foregroundHwnd ? GetWindowThreadProcessId(foregroundHwnd, [0]) : 0
  const attached = foregroundThread && foregroundThread !== current ? AttachThreadInput(current, foregroundThread, true) : false
  try {
    SetForegroundWindow(hwnd)
    BringWindowToTop(hwnd)
  } finally { if (attached) AttachThreadInput(current, foregroundThread, false) }
  return Number(GetForegroundWindow()) === hwnd
}

function virtualScreen(): { x: number; y: number; width: number; height: number } {
  return { x: GetSystemMetrics(76), y: GetSystemMetrics(77), width: GetSystemMetrics(78), height: GetSystemMetrics(79) }
}

function mouseInput(dwFlags: number, dx = 0, dy = 0, mouseData = 0): Record<string, number> {
  return { type: 0, pad0: 0, dx, dy, mouseData: mouseData >>> 0, dwFlags, time: 0, pad1: 0, extra: INPUT_TAG }
}

function keyInput(vk: number, up: boolean, unicode = 0): Record<string, number | number[]> {
  const flags = (up ? KEYEVENTF.up : 0) | (unicode ? KEYEVENTF.unicode : 0) | (!unicode && EXTENDED_KEYS.has(vk) ? KEYEVENTF.extended : 0)
  return { type: 1, pad0: 0, wVk: unicode ? 0 : vk, wScan: unicode, dwFlags: flags, time: 0, pad1: 0, extra: INPUT_TAG, pad2: [0, 0, 0, 0, 0, 0, 0, 0] }
}

function sendMouse(inputs: Array<Record<string, number>>): void {
  if (SendMouse(inputs.length, inputs, koffi.sizeof(INPUT_MOUSE)) !== inputs.length) throw new Error('Windows did not accept the mouse input (another window may be blocking it).')
}

function sendKeys(inputs: Array<Record<string, number | number[]>>): void {
  if (SendKeys(inputs.length, inputs, koffi.sizeof(INPUT_KEY)) !== inputs.length) throw new Error('Windows did not accept the keyboard input (another window may be blocking it).')
}

/** Move along the input stream (so apps see mouse moves while dragging), then land exactly on the pixel. */
function moveTo(x: number, y: number): void {
  const screen = virtualScreen()
  const dx = Math.round((x - screen.x) * 65535 / Math.max(1, screen.width - 1))
  const dy = Math.round((y - screen.y) * 65535 / Math.max(1, screen.height - 1))
  sendMouse([mouseInput(MOUSEEVENTF.move | MOUSEEVENTF.absolute | MOUSEEVENTF.virtualDesk, dx, dy)])
  SetCursorPos(x, y)
}

const BUTTONS = {
  left: [MOUSEEVENTF.leftDown, MOUSEEVENTF.leftUp],
  right: [MOUSEEVENTF.rightDown, MOUSEEVENTF.rightUp],
  middle: [MOUSEEVENTF.middleDown, MOUSEEVENTF.middleUp],
} as const

function click(x: number, y: number, button: keyof typeof BUTTONS, count: number): void {
  moveTo(x, y)
  const [down, up] = BUTTONS[button]
  const inputs: Array<Record<string, number>> = []
  for (let index = 0; index < count; index++) inputs.push(mouseInput(down), mouseInput(up))
  sendMouse(inputs)
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  moveTo(from.x, from.y)
  sendMouse([mouseInput(MOUSEEVENTF.leftDown)])
  try {
    const steps = 12
    for (let step = 1; step <= steps; step++) {
      moveTo(Math.round(from.x + (to.x - from.x) * step / steps), Math.round(from.y + (to.y - from.y) * step / steps))
      await new Promise(resolve => setTimeout(resolve, 15))
    }
  } finally { sendMouse([mouseInput(MOUSEEVENTF.leftUp)]) }
}

function scroll(x: number, y: number, dx: number, dy: number): void {
  moveTo(x, y)
  const inputs: Array<Record<string, number>> = []
  if (dy) inputs.push(mouseInput(MOUSEEVENTF.wheel, 0, 0, -dy * 120))
  if (dx) inputs.push(mouseInput(MOUSEEVENTF.hwheel, 0, 0, dx * 120))
  if (inputs.length) sendMouse(inputs)
}

function pressChord(vks: number[]): void {
  const inputs = [...vks.map(vk => keyInput(vk, false)), ...[...vks].reverse().map(vk => keyInput(vk, true))]
  sendKeys(inputs)
}

function typeText(text: string): void {
  const inputs: Array<Record<string, number | number[]>> = []
  for (const unit of text) {
    if (unit === '\n') inputs.push(keyInput(0x0d, false), keyInput(0x0d, true))
    else if (unit === '\t') inputs.push(keyInput(0x09, false), keyInput(0x09, true))
    else for (let index = 0; index < unit.length; index++) {
      const code = unit.charCodeAt(index)
      inputs.push(keyInput(0, false, code), keyInput(0, true, code))
    }
  }
  if (inputs.length) sendKeys(inputs)
}

function cursor(): { x: number; y: number } {
  const point = { x: 0, y: 0 }
  GetCursorPos(point)
  return point
}

/** Whether the input desktop is the user's (not the lock screen, a UAC prompt or a sign-in screen). */
function inputDesktopIsDefault(): boolean {
  const desktop = OpenInputDesktop(0, false, 0x0001)
  if (!desktop) return false
  try {
    const name = text16((buffer, length) => GetUserObjectInformationW(desktop, 2, buffer, length * 2, [0]) ? buffer.indexOf(0) : 0, 64)
    return name.toLowerCase() === 'default'
  } finally { CloseDesktop(desktop) }
}

function guid(text: string): Record<string, number | number[]> {
  const hex = text.replace(/[{}-]/g, '')
  return { a: parseInt(hex.slice(0, 8), 16), b: parseInt(hex.slice(8, 12), 16), c: parseInt(hex.slice(12, 16), 16), d: Array.from({ length: 8 }, (_, index) => parseInt(hex.slice(16 + index * 2, 18 + index * 2), 16)) }
}

let automation: unknown = null
function uiAutomation(): unknown {
  if (automation) return automation
  CoInitializeEx(null, 0)
  const out: unknown[] = [null]
  // CLSID_CUIAutomation, IID_IUIAutomation
  const result = CoCreateInstance(guid('ff48dba4-60ef-4201-aa87-54103eef594e'), null, 1, guid('30cbe57d-d9d0-452a-ab13-7ac5ac4825ee'), out)
  if (result !== 0 || !out[0]) throw new Error('UI Automation is unavailable.')
  automation = out[0]
  return automation
}

function method(object: unknown, index: number): unknown {
  return koffi.decode(koffi.decode(object, 'void *'), koffi.array('void *', index + 1))[index]
}

/** The focused control's process and whether it is a password field (IUIAutomationElement::get_CurrentIsPassword). */
function focusedControl(): DesktopNativeFocus {
  const root = uiAutomation()
  const element: unknown[] = [null]
  if (koffi.call(method(root, 8), GetFocusedElement, root, element) !== 0 || !element[0]) return { pid: null, password: null }
  try {
    const pid = [0]
    const password = [0]
    const pidOk = koffi.call(method(element[0], 20), GetIntProperty, element[0], pid) === 0
    const passwordOk = koffi.call(method(element[0], 35), GetIntProperty, element[0], password) === 0
    return { pid: pidOk ? pid[0]! : null, password: passwordOk ? password[0] !== 0 : null }
  } finally { koffi.call(method(element[0], 2), Release, element[0]) }
}

async function run(request: DesktopNativeRequest): Promise<unknown> {
  switch (request.op) {
    case 'windows': return listWindows()
    case 'foreground': return foreground()
    case 'focus': return focusWindow(request.id)
    case 'cursor': return cursor()
    case 'move': moveTo(request.x, request.y); return null
    case 'click': click(request.x, request.y, request.button, request.count); return null
    case 'drag': await drag(request.from, request.to); return null
    case 'scroll': scroll(request.x, request.y, request.dx, request.dy); return null
    case 'key': pressChord(request.vks); return null
    case 'type': typeText(request.text); return null
    case 'focused': return focusedControl()
    case 'desktop': return inputDesktopIsDefault()
  }
}

parentPort!.on('message', (message: { id: number; request: DesktopNativeRequest }) => {
  void run(message.request).then(
    value => parentPort!.postMessage({ id: message.id, ok: true, value }),
    (error: unknown) => parentPort!.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  )
})
