import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Socket } from 'node:net'
import { CopilotRpc, supportsSessionFork, isForkSessionId } from './copilot-rpc.js'

const SOURCE = '11111111-1111-4111-8111-111111111111'
interface SessionControlEndpoint { port: number; token: string }
type Request = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> }

function frame(message: object): string {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

async function withServer(handler: (request: Request, socket: Socket) => void, action: (endpoint: SessionControlEndpoint) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())?.[1])
        if (buffer.length < end + 4 + length) return
        const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()) as Request
        buffer = buffer.subarray(end + 4 + length)
        handler(request, socket)
      }
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try { await action({ port: address.port, token: 'test-token' }) }
  finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

test('unsupported RPC returns actionable update guidance', async () => {
  await withServer((request, socket) => {
    socket.write(frame({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } }))
  }, async (endpoint) => {
    const rpc = new CopilotRpc(endpoint)
    try { await assert.rejects(rpc.request('sessions.fork'), /Update Copilot/) }
    finally { await rpc.stop() }
  })
})

test('RPC handles fragmented byte frames, unicode and multiple responses per chunk', async () => {
  const requests: Request[] = []
  await withServer((request, socket) => {
    requests.push(request)
    if (requests.length !== 2) return
    const payload = Buffer.from(frame({ jsonrpc: '2.0', id: requests[1]!.id, result: '第二' }) + frame({ jsonrpc: '2.0', method: 'notification' }) + frame({ jsonrpc: '2.0', id: requests[0]!.id, result: '第一' }))
    for (let index = 0; index < payload.length; index += 3) socket.write(payload.subarray(index, index + 3))
  }, async (endpoint) => {
    const rpc = new CopilotRpc(endpoint)
    try { assert.deepEqual(await Promise.all([rpc.request('first'), rpc.request('second')]), ['第一', '第二']) }
    finally { await rpc.stop() }
  })
})

test('RPC bounds invalid frames and releases pending requests on disconnect', async () => {
  for (const reply of ['Content-Length: 999999999\r\n\r\n', 'Content-Length: 4\r\n\r\nnope']) {
    await withServer((_request, socket) => { socket.write(reply) }, async (endpoint) => {
      const rpc = new CopilotRpc(endpoint)
      try { await assert.rejects(rpc.request('test'), /Invalid response/) }
      finally { await rpc.stop() }
    })
  }
  await withServer((_request, socket) => { socket.destroy() }, async (endpoint) => {
    const rpc = new CopilotRpc(endpoint)
    try { await assert.rejects(rpc.request('test'), /connection closed/) }
    finally { await rpc.stop() }
  })
})

test('RPC times out and rejects new work after stop', async () => {
  await withServer(() => {}, async (endpoint) => {
    const rpc = new CopilotRpc(endpoint)
    try { await assert.rejects(rpc.request('test', {}, 20), /timed out/) }
    finally { await rpc.stop() }
    await assert.rejects(rpc.request('test'), /closed/)
  })
})

test('session fork version and UUID validation are conservative', () => {
  for (const version of [null, 'unknown', '1.0.81', '1.0.82-preview', '0.9.999']) assert.equal(supportsSessionFork(version), false)
  for (const version of ['1.0.82', '1.0.83', '1.1.0', '2.0.0']) assert.equal(supportsSessionFork(version), true)
  assert.ok(isForkSessionId(SOURCE))
  for (const id of ['--flag', '../path', '', null, '123']) assert.equal(isForkSessionId(id), false)
})
