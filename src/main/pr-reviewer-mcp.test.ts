import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { handlePrReviewerMcpHttp, PR_REVIEWER_MCP_PATH, PR_REVIEWER_MCP_TOOLS, type PrReviewerMcpDeps } from './pr-reviewer-mcp.js'

test('reviewer MCP endpoint enforces bearer token, origin/host checks, and exposes only PR reviewer tools', async () => {
  let validToken = 'a'.repeat(64)
  const calls: string[] = []
  const deps: PrReviewerMcpDeps<{ cli: string }> = {
    authorize: (token) => (token === validToken ? { cli: 'claude' } : null),
    prRead: async (_seat, page) => { calls.push(`read:${page ?? '1'}`); return { ok: true, text: '{"head":"abc"}' } },
    prDiff: async (_seat, path, offset) => { calls.push(`diff:${path ?? '*'}:${offset}`); return { ok: true, text: 'diff --git' } },
    prFile: async (_seat, path, offset) => { calls.push(`file:${path}:${offset}`); return { ok: true, text: '1: code' } },
    prWait: async (_seat, waitSeconds) => { calls.push(`wait:${waitSeconds}`); return { ok: true, text: '{"status":"timeout"}' } },
    prReview: async (_seat, input) => { calls.push(`review:${input.approve}:${input.body}`); return { ok: true, text: 'posted' } },
    prReply: async (_seat, to, text) => { calls.push(`reply:${to}:${text}`); return { ok: true, text: 'replied' } },
  }

  let port = 0
  const server = createServer((req, res) => {
    void handlePrReviewerMcpHttp(req, res, port, deps)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  port = (server.address() as { port: number }).port
  const url = `http://127.0.0.1:${port}${PR_REVIEWER_MCP_PATH}`

  try {
    // Reject missing or wrong token
    const noAuth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(noAuth.status, 401)
    const wrongAuth = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${'b'.repeat(64)}` },
      body: '{}',
    })
    assert.equal(wrongAuth.status, 401)

    // Reject browser Origin header
    const browserOrigin = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validToken}`, origin: 'https://evil.example' },
      body: '{}',
    })
    assert.equal(browserOrigin.status, 403)

    // GET returns 405
    const getResp = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${validToken}` } })
    assert.equal(getResp.status, 405)

    const postRpc = async (body: Record<string, unknown>) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${validToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      })
      return { status: resp.status, json: resp.status === 202 ? null : await resp.json() as Record<string, any> }
    }

    const init = await postRpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    assert.equal(init.status, 200)
    assert.equal(init.json?.result?.protocolVersion, '2025-06-18')

    const listed = await postRpc({ id: 2, method: 'tools/list' })
    const toolNames = (listed.json?.result?.tools as Array<{ name: string }>).map((t) => t.name)
    assert.deepEqual(toolNames, PR_REVIEWER_MCP_TOOLS.map((t) => t.name))
    assert.equal(toolNames.some((name) => name.startsWith('meeting_')), false, 'no meeting tools exposed')

    await postRpc({ id: 3, method: 'tools/call', params: { name: 'pr_read', arguments: { page: '2' } } })
    await postRpc({ id: 4, method: 'tools/call', params: { name: 'pr_diff', arguments: { path: 'src/a.ts', offset: 10 } } })
    await postRpc({ id: 5, method: 'tools/call', params: { name: 'pr_file', arguments: { path: 'src/a.ts', offset: 0 } } })
    await postRpc({ id: 6, method: 'tools/call', params: { name: 'pr_review', arguments: { body: 'Nit: rename', approve: false, comments: [] } } })
    await postRpc({ id: 7, method: 'tools/call', params: { name: 'pr_reply', arguments: { to: '42', text: 'Confirmed' } } })
    await postRpc({ id: 8, method: 'tools/call', params: { name: 'pr_wait', arguments: { wait_seconds: 99 } } })
    assert.deepEqual(calls, [
      'read:2',
      'diff:src/a.ts:10',
      'file:src/a.ts:0',
      'review:false:Nit: rename',
      'reply:42:Confirmed',
      'wait:50',
    ])

    // Revoking the seat token immediately blocks subsequent calls
    validToken = ''
    const revoked = await postRpc({ id: 9, method: 'tools/list' })
    assert.equal(revoked.status, 401)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
