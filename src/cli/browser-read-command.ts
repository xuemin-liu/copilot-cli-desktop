export const BROWSER_READ_COMMANDS = ['tabs', 'select', 'frames', 'snapshot', 'screenshot', 'scroll', 'activate', 'responses', 'response', 'test-targets'] as const
export function validateBrowserReadCommand(command: string, args: string[]): void {
  const count: Record<string, [number, number]> = { tabs: [0, 0], select: [1, 1], frames: [0, 1], snapshot: [0, 3],
    screenshot: [0, 1], scroll: [3, 5], activate: [4, 4], responses: [0, 1], response: [1, 1], 'test-targets': [0, 1] }
  const range = count[command]
  const fail = (): never => { throw new Error('Usage: browser tabs|select <page>|frames [page]|snapshot [page] [frame] [offset]|screenshot [page]|responses [page]|response <body-id>|scroll <page> <frame> <pixels> [snapshot-id node-id]|activate <page> <frame> <snapshot-id> <node-id>') }
  if (!range || args.length < range[0] || args.length > range[1] || args.some(arg => arg.length > 128)) fail()
  if (command === 'test-targets') { if (args[0] && !/^[a-zA-Z0-9_-]{1,128}$/.test(args[0])) fail(); return }
  if (command === 'response') { if (!/^b[1-9]\d*-\d+$/.test(args[0]!)) fail(); return }
  if (args[0] && !/^[1-9]\d*$/.test(args[0])) fail()
  if (['snapshot', 'scroll', 'activate'].includes(command) && args[1] && !/^[a-zA-Z0-9_-]{1,128}$/.test(args[1])) fail()
  if (command === 'snapshot' && args[2] && (!/^\d+$/.test(args[2]) || Number(args[2]) > 20000)) fail()
  if (command === 'scroll') {
    if (!/^-?\d+$/.test(args[2]!) || Math.abs(Number(args[2])) > 2000 || args.length === 4) fail()
    if (args.length === 5 && (!/^[a-f0-9]{32}$/.test(args[3]!) || !/^n\d+$/.test(args[4]!))) fail()
  }
  if (command === 'activate' && (!/^[a-f0-9]{32}$/.test(args[2]!) || !/^n\d+$/.test(args[3]!))) fail()
}

export function browserReadMethod(command: string): 'GET' | 'POST' {
  return ['select', 'scroll', 'activate'].includes(command) ? 'POST' : 'GET'
}
