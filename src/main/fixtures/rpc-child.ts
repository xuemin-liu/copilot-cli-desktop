// Inert test process for the real stdio spawn/stop path. It intentionally
// remains alive after stdin closes, and never calls Copilot or any model.
import { spawn } from 'node:child_process'

const descendant = process.platform === 'win32' && process.env.RPC_TEST_DESCENDANT === '1'
  ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' }) : null
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const header = buffer.indexOf('\r\n\r\n')
    if (header < 0) return
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, header).toString())?.[1])
    if (buffer.length < header + 4 + length) return
    const request = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString())
    buffer = buffer.subarray(header + 4 + length)
    if (request.method !== 'ready') continue
    const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { pid: process.pid, descendantPid: descendant?.pid ?? null } })
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
})
setInterval(() => {}, 1000)
