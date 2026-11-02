import { parentPort, workerData } from 'node:worker_threads'
import koffi from 'koffi'

/**
 * Low-level mouse and keyboard hooks that count the user's own input, telling it from injected input by the
 * `LLMHF_INJECTED` and `LLKHF_INJECTED` flags. It runs in its own worker and only pumps messages, so the hooks always
 * answer quickly: Windows drops a low-level hook that keeps input waiting.
 *
 * Shared layout (Float64Array): [0] user input count, [1] time of the last user input (ms since the epoch).
 */

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const KBDLLHOOKSTRUCT = koffi.struct('DM_KBDLLHOOKSTRUCT', { vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', extra: 'uintptr' })
const MSLLHOOKSTRUCT = koffi.struct('DM_MSLLHOOKSTRUCT', { x: 'int32', y: 'int32', mouseData: 'uint32', flags: 'uint32', time: 'uint32', extra: 'uintptr' })
const HookProc = koffi.proto('intptr __stdcall DM_HookProc(int code, uintptr wParam, intptr lParam)')
const SetWindowsHookExW = user32.func('intptr __stdcall SetWindowsHookExW(int kind, DM_HookProc *proc, intptr module, uint32 thread)')
const UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(intptr hook)')
const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(intptr hook, int code, uintptr wParam, intptr lParam)')
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Out_ uint8_t *message, intptr hwnd, uint32 min, uint32 max, uint32 remove)')
const MsgWaitForMultipleObjects = user32.func('uint32 __stdcall MsgWaitForMultipleObjects(uint32 count, void *handles, bool all, uint32 milliseconds, uint32 mask)')
const GetModuleHandleW = kernel32.func('intptr __stdcall GetModuleHandleW(void *name)')

const LLKHF_INJECTED = 0x10
const LLMHF_INJECTED = 0x01
const shared = new Float64Array(workerData.shared as SharedArrayBuffer)

function userInput(): void {
  shared[0] = shared[0]! + 1
  shared[1] = Date.now()
}

const keyboard = koffi.register((code: number, wParam: number, lParam: unknown) => {
  if (code >= 0 && !(koffi.decode(lParam, KBDLLHOOKSTRUCT).flags & LLKHF_INJECTED)) userInput()
  return CallNextHookEx(0, code, wParam, lParam)
}, koffi.pointer(HookProc))
const mouse = koffi.register((code: number, wParam: number, lParam: unknown) => {
  if (code >= 0 && !(koffi.decode(lParam, MSLLHOOKSTRUCT).flags & LLMHF_INJECTED)) userInput()
  return CallNextHookEx(0, code, wParam, lParam)
}, koffi.pointer(HookProc))

const module = GetModuleHandleW(null)
const hooks = [SetWindowsHookExW(13, keyboard, module, 0), SetWindowsHookExW(14, mouse, module, 0)]
parentPort!.postMessage({ ready: hooks.every(Boolean) })

let running = true
parentPort!.on('message', (message: unknown) => {
  if (message !== 'stop') return
  running = false
  for (const hook of hooks) if (hook) UnhookWindowsHookEx(hook)
  koffi.unregister(keyboard)
  koffi.unregister(mouse)
  parentPort!.close()
})

const message = Buffer.alloc(64)
function pump(): void {
  if (!running) return
  // Wake for input (QS_ALLINPUT) or after 25 ms, so messages from the main process are read promptly too.
  MsgWaitForMultipleObjects(0, null, false, 25, 0x04ff)
  while (running && PeekMessageW(message, 0, 0, 0, 1)) { /* hooks run inside PeekMessage */ }
  setImmediate(pump)
}
pump()
