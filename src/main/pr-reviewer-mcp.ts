import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isJsonType, readBody } from './form-body.js'

/**
 * Dedicated loopback MCP endpoint for non-Copilot temporary PR reviewers (`/pr-reviewer-mcp`).
 * Every HTTP request authenticates with `Authorization: Bearer <64-hex-seat-token>` (validated in constant time by
 * `deps.authorize`); no secret ever appears in a URL or process command line. `tools/list` exposes only the 6 scoped
 * PR review tools — never meeting or general desktop tools.
 */

export const PR_REVIEWER_MCP_PATH = '/pr-reviewer-mcp'
export const PR_REVIEWER_MCP_SERVER_NAME = 'copilot-pr-reviewer'
export const PR_REVIEWER_TOKEN_ENV = 'COPILOT_DESKTOP_REVIEWER_TOKEN'
export const PR_REVIEWER_MCP_WAIT_MAX_SECONDS = 50
const MAX_MCP_REQUEST_BYTES = 512 * 1024
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

export interface PrReviewerToolResult {
  ok: boolean
  text: string
}

export interface PrReviewerReviewInput {
  body: string
  approve: boolean
  comments?: Array<{ path: string; line: number; body: string }>
  checks?: { ran: string[]; missing: string[] }
}

export interface PrReviewerMcpDeps<TSeat> {
  authorize(bearerToken: string): TSeat | null
  prRead(seat: TSeat, page?: string): Promise<PrReviewerToolResult>
  prDiff(seat: TSeat, path?: string, offset?: number): Promise<PrReviewerToolResult>
  prFile(seat: TSeat, path: string, offset?: number): Promise<PrReviewerToolResult>
  prWait(seat: TSeat, waitSeconds: number, signal: AbortSignal): Promise<PrReviewerToolResult>
  prReview(seat: TSeat, input: PrReviewerReviewInput): Promise<PrReviewerToolResult>
  prReply(seat: TSeat, to: string, text: string): Promise<PrReviewerToolResult>
}

export const PR_REVIEWER_MCP_TOOLS = [
  {
    name: 'pr_read',
    description: 'Read pull request metadata, head and base SHAs, and paginated reviews, inline comments, and conversation comments. Pass nextPage verbatim until nextPage is null.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Optional nextPage cursor returned by the previous pr_read call.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pr_diff',
    description: 'Read the unified git diff between the pull request base SHA and checked-out head SHA in pages of up to 20,000 characters.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional repository-relative file path to diff.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset for pagination (0 by default).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pr_file',
    description: 'Read a file from the checked-out pull request worktree with 1-based line numbers, in pages of up to 20,000 characters.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path inside the pull request checkout.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset for pagination (0 by default).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'pr_wait',
    description: `Wait up to wait_seconds (${PR_REVIEWER_MCP_WAIT_MAX_SECONDS} by default and at most) for a pull request update (new head, new base, marked author reply, or review closure). Desktop refreshes the detached checkout before waking you.`,
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'integer', minimum: 1, maximum: PR_REVIEWER_MCP_WAIT_MAX_SECONDS },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pr_review',
    description: 'Submit one pull request review with inline comments, or an approval with checks ran and missing. Never approve when comments are non-empty.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Review summary body, or "Approved at <full-head-sha>..." when approve is true.' },
        approve: { type: 'boolean', description: 'True only when approving the exact checked-out head with zero findings.' },
        comments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'integer', minimum: 1 },
              body: { type: 'string' },
            },
            required: ['path', 'line', 'body'],
            additionalProperties: false,
          },
        },
        checks: {
          type: 'object',
          properties: {
            ran: { type: 'array', items: { type: 'string' } },
            missing: { type: 'array', items: { type: 'string' } },
          },
          required: ['ran', 'missing'],
          additionalProperties: false,
        },
      },
      required: ['body', 'approve'],
      additionalProperties: false,
    },
  },
  {
    name: 'pr_reply',
    description: 'Post an unmarked reviewer reply on an existing inline comment thread on this pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Numeric inline comment ID to reply to.' },
        text: { type: 'string', description: 'Reply Markdown body (never starting with the author marker).' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
] as const

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function toolReply(outcome: PrReviewerToolResult): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: outcome.text }],
    ...(outcome.ok ? {} : { isError: true }),
  }
}

export async function handlePrReviewerMcpMessage<TSeat>(
  seat: TSeat,
  deps: PrReviewerMcpDeps<TSeat>,
  message: unknown,
  signal: AbortSignal,
): Promise<{ status: number; body?: unknown; sessionId?: string }> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid JSON-RPC message') }
  }
  const rpc = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return { status: 400, body: rpcError(rpc.id ?? null, -32600, 'Invalid JSON-RPC request') }
  }
  if (rpc.id === undefined) {
    return { status: 202 }
  }
  const params = rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
    ? rpc.params as Record<string, unknown>
    : {}

  switch (rpc.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-03-26'
      return {
        status: 200,
        sessionId: randomUUID(),
        body: rpcResult(rpc.id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: PR_REVIEWER_MCP_SERVER_NAME, version: '1.0.0' },
          instructions: 'Scoped pull request reviewer tools for Copilot CLI Desktop. Use pr_read, pr_diff, and pr_file to inspect the PR, pr_review and pr_reply to post findings or approval, and pr_wait to wait for new commits or author replies until the review closes.',
        }),
      }
    }
    case 'ping':
      return { status: 200, body: rpcResult(rpc.id, {}) }
    case 'tools/list':
      return { status: 200, body: rpcResult(rpc.id, { tools: PR_REVIEWER_MCP_TOOLS }) }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {}
      switch (name) {
        case 'pr_read': {
          if (args.page !== undefined && typeof args.page !== 'string') {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'page must be a string cursor.' })) }
          }
          return { status: 200, body: rpcResult(rpc.id, toolReply(await deps.prRead(seat, args.page))) }
        }
        case 'pr_diff': {
          if (args.path !== undefined && typeof args.path !== 'string') {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'path must be a string.' })) }
          }
          const offset = args.offset === undefined ? 0 : Number(args.offset)
          if (!Number.isSafeInteger(offset) || offset < 0) {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'offset must be a non-negative integer.' })) }
          }
          return { status: 200, body: rpcResult(rpc.id, toolReply(await deps.prDiff(seat, args.path, offset))) }
        }
        case 'pr_file': {
          if (typeof args.path !== 'string' || !args.path.trim()) {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'path is required.' })) }
          }
          const offset = args.offset === undefined ? 0 : Number(args.offset)
          if (!Number.isSafeInteger(offset) || offset < 0) {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'offset must be a non-negative integer.' })) }
          }
          return { status: 200, body: rpcResult(rpc.id, toolReply(await deps.prFile(seat, args.path, offset))) }
        }
        case 'pr_wait': {
          const rawWait = args.wait_seconds === undefined ? PR_REVIEWER_MCP_WAIT_MAX_SECONDS : Number(args.wait_seconds)
          if (!Number.isSafeInteger(rawWait) || rawWait < 1) {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'wait_seconds must be a positive integer.' })) }
          }
          const clamped = Math.min(PR_REVIEWER_MCP_WAIT_MAX_SECONDS, rawWait)
          return { status: 200, body: rpcResult(rpc.id, toolReply(await deps.prWait(seat, clamped, signal))) }
        }
        case 'pr_review': {
          if (typeof args.body !== 'string' || typeof args.approve !== 'boolean') {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'body (string) and approve (boolean) are required.' })) }
          }
          const comments = args.comments === undefined ? [] : Array.isArray(args.comments) ? args.comments as Array<{ path: string; line: number; body: string }> : null
          if (!comments) {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'comments must be an array.' })) }
          }
          let checks: { ran: string[]; missing: string[] } | undefined
          if (args.checks !== undefined) {
            const raw = args.checks && typeof args.checks === 'object' && !Array.isArray(args.checks) ? args.checks as Record<string, unknown> : null
            if (!raw || !Array.isArray(raw.ran) || !Array.isArray(raw.missing)
              || !raw.ran.every((v) => typeof v === 'string') || !raw.missing.every((v) => typeof v === 'string')) {
              return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'checks must be {"ran": [...], "missing": [...]}.' })) }
            }
            checks = { ran: raw.ran as string[], missing: raw.missing as string[] }
          }
          return {
            status: 200,
            body: rpcResult(rpc.id, toolReply(await deps.prReview(seat, {
              body: args.body,
              approve: args.approve,
              comments,
              ...(checks ? { checks } : {}),
            }))),
          }
        }
        case 'pr_reply': {
          if (typeof args.to !== 'string' || typeof args.text !== 'string') {
            return { status: 200, body: rpcResult(rpc.id, toolReply({ ok: false, text: 'to and text are required strings.' })) }
          }
          return { status: 200, body: rpcResult(rpc.id, toolReply(await deps.prReply(seat, args.to, args.text))) }
        }
        default:
          return { status: 200, body: rpcError(rpc.id, -32601, `Unknown reviewer tool: ${name}`) }
      }
    }
    default:
      return { status: 200, body: rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`) }
  }
}

export async function handlePrReviewerMcpHttp<TSeat>(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  deps: PrReviewerMcpDeps<TSeat>,
): Promise<void> {
  const send = (status: number, body?: unknown, extraHeaders: Record<string, string> = {}): void => {
    if (response.headersSent || response.destroyed) return
    response.writeHead(status, {
      'cache-control': 'no-store',
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      ...extraHeaders,
    })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const host = request.headers.host
  if (request.headers.origin || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
    send(403, rpcError(null, -32000, 'Forbidden'))
    return
  }
  const auth = request.headers.authorization ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  const seat = bearer ? deps.authorize(bearer) : null
  if (!seat) {
    send(401, rpcError(null, -32001, 'This reviewer seat token is invalid or has been revoked.'))
    return
  }
  if (request.method === 'DELETE') {
    send(200)
    return
  }
  if (request.method !== 'POST') {
    send(405, rpcError(null, -32000, 'Method not allowed'), { allow: 'POST, DELETE' })
    return
  }
  if (!isJsonType(request.headers['content-type'])) {
    send(415, rpcError(null, -32700, 'Expected application/json'))
    return
  }
  const gone = new AbortController()
  response.once('close', () => {
    if (!response.writableFinished) gone.abort()
  })
  try {
    const raw = await readBody(request, MAX_MCP_REQUEST_BYTES)
    if (raw === null) {
      send(413, rpcError(null, -32700, 'Request too large'))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      send(400, rpcError(null, -32700, 'Invalid JSON'))
      return
    }
    const answer = await handlePrReviewerMcpMessage(seat, deps, parsed, gone.signal)
    if (!request.socket.destroyed) {
      send(answer.status, answer.body, answer.sessionId ? { 'mcp-session-id': answer.sessionId } : {})
    }
  } catch {
    if (!request.socket.destroyed) send(500, rpcError(null, -32603, 'Internal reviewer MCP error'))
  }
}
