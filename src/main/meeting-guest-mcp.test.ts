import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { MeetingHub, realMeetingTimers } from './meeting.js'
import { meetingWaitingOn } from './meeting-contact.js'
import { GuestMailbox, GUEST_PAGE_CHARS, GUEST_STAY_IN_TURN, guestDeliveryText, type GuestDeps } from './meeting-guests.js'
import { agentName, GUEST_MCP_TOOLS, GuestMcpServer, GuestMcpSessions, handleMcpMessage, type McpAnswer } from './meeting-guest-mcp.js'
import { roundPaths } from './meeting-messages.js'

const MEETINGS = join('C:', 'meetings')
const realTimers = realMeetingTimers
const STAY = GUEST_STAY_IN_TURN
const FIRST_MESSAGE = `Call meeting_next for your first message. Answer each message with meeting_reply, then call meeting_next again; ${STAY}.`
const REJOINED_HOST = `Rejoined meeting K7QF as host. Call meeting_next for the reviewers' replies. Answer each round first, then call meeting_next again; ${STAY}.`
const REPLY_SENT = `Reply sent. Call meeting_next for the next message; ${STAY}.`
const JOIN_FIRST = 'Call meeting_join first, with the meeting id or invitation the person gave you, or meeting_start to host a meeting. After a restart, pass the seat key you were given as the invitation.'

/** A hub with a host, guests wired to it as main wires them, and an MCP client talking to `handleMcpMessage`. */
function meeting(): {
  hub: MeetingHub; mailbox: GuestMailbox; deps: GuestDeps; sessions: GuestMcpSessions; files: Map<string, string>; toHost: string[]
  rpc(sessionId: string | undefined, method: string, params?: unknown, id?: number | null): Promise<McpAnswer>
  tool(sessionId: string, name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
} {
  const files = new Map<string, string>()
  const toHost: string[] = []
  const mailbox: GuestMailbox = new GuestMailbox(realTimers, () => {}, (seat, item) => guestDeliveryText(seat, item, hub.folderOf(item.meetingId), join('C:', 'guests')))
  const hub: MeetingHub = new MeetingHub(() => MEETINGS, {
    deliver: (tabId, item) => {
      if (tabId === 'tab-host') { if (item.kind !== 'add-dir') toHost.push(item.text); return }
      if (item.kind === 'add-dir') return
      mailbox.enqueue(tabId, item)
    },
    cancel: (meetingId, tabId) => mailbox.cancel(meetingId, tabId),
    write: (_meetingId, path, text) => files.set(path, text),
    changed: () => mailbox.closeEnded((id) => hub.isOpen(id)),
    notify: () => {},
    sessionIdOf: (tabId) => tabId,
  }, () => ({ maxRounds: 6, roundTimeoutMinutes: 10 }), realTimers, () => 'K7QF')
  const deps: GuestDeps = {
    ready: () => true,
    isOpen: (id) => hub.isOpen(id),
    join: (seat) => { try { hub.join({ tabId: seat.id, title: `${seat.name} (guest)`, folder: null }, seat.meetingId, { role: seat.role }); return null } catch (error) { return (error as Error).message } },
    leave: (seat) => hub.leave(seat.id),
    turnCompleted: (seat, item, reply) => hub.turnCompleted(seat.id, item, reply),
    material: async (id, name, round) => {
      const paths = roundPaths(hub.folderOf(id)!, round)
      return files.get(name === 'transcript' ? paths.transcript : paths[name]) ?? null
    },
    start: (seat, topic, post, changes) => {
      try { return { meetingId: hub.start({ tabId: seat.id, title: `${seat.name} (guest)`, folder: seat.folder }, { topic, post, changes }).id } }
      catch (error) { return { error: (error as Error).message } }
    },
    post: (seat, kind, text, changes) => {
      try { return { ok: true, message: hub.post(seat.id, kind, text, changes) } } catch (error) { return { ok: false, message: (error as Error).message } }
    },
    end: (seat) => { hub.end(seat.id); return { ok: true, message: 'The meeting is closed.' } },
    status: (seat) => `status of ${seat.meetingId}`,
    waitingOn: (seat) => {
      const view = hub.views().find((candidate) => candidate.id === seat.meetingId)
      return view ? meetingWaitingOn(view, seat.id) : null
    },
    changes: async () => 'diff --git a/login.cfg b/login.cfg\n+retry = 3\n',
    checkFolder: async (folder) => folder.startsWith('D:\\') ? null : `${folder} is not a folder.`,
  }
  const sessions = new GuestMcpSessions()
  let nextId = 1
  const rpc = (sessionId: string | undefined, method: string, params: unknown = {}, id: number | null = nextId++): Promise<McpAnswer> =>
    handleMcpMessage(sessions, mailbox, deps, sessionId, { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params })
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const answer = await rpc(sessionId, 'tools/call', { name, arguments: args })
    const result = (answer.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result
    return { text: result.content[0]!.text, isError: result.isError === true }
  }
  return { hub, mailbox, deps, sessions, files, toHost, rpc, tool }
}

test('initialize opens a session and agrees a protocol version; everything else needs that session', async () => {
  const { rpc } = meeting()
  const init = await rpc(undefined, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } })
  assert.equal(init.status, 200)
  assert.match(init.sessionId ?? '', /^[0-9a-f-]{36}$/)
  const result = (init.body as { result: Record<string, unknown> }).result
  assert.equal(result.protocolVersion, '2025-03-26')
  assert.deepEqual(result.serverInfo, { name: 'copilot-meeting', version: '1' })
  assert.match(String(result.instructions), /When the person asks you to join meeting K7QF, call meeting_join with meeting: "K7QF"/)
  const newer = await rpc(undefined, 'initialize', { protocolVersion: '2099-01-01' })
  assert.equal((newer.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18', 'an unknown version gets the newest one')

  assert.equal((await rpc(undefined, 'tools/list')).status, 404, 'no session')
  assert.equal((await rpc('not-a-session', 'tools/list')).status, 404, 'an unknown session starts over')
  assert.equal((await rpc(init.sessionId, 'notifications/initialized', {}, null)).status, 202)
  const tools = ((await rpc(init.sessionId, 'tools/list')).body as { result: { tools: Array<{ name: string }> } }).result.tools
  assert.deepEqual(tools.map((entry) => entry.name), ['meeting_join', 'meeting_next', 'meeting_reply', 'meeting_show', 'meeting_leave', 'meeting_start', 'meeting_round', 'meeting_propose_close', 'meeting_end', 'meeting_status'])
  assert.deepEqual(((await rpc(init.sessionId, 'ping')).body as { result: unknown }).result, {})
  assert.equal(((await rpc(init.sessionId, 'resources/list')).body as { error: { code: number } }).error.code, -32601)
})

test('an agent joins with its invitation, reviews with the tools, pages the patch, votes and hears the meeting closed', async () => {
  const { hub, mailbox, rpc, tool, toHost } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const { seat, token } = mailbox.invite('K7QF', 'Claude Code', 'security reviewer')
  const session = (await rpc(undefined, 'initialize', {})).sessionId!

  assert.deepEqual(await tool(session, 'meeting_next'), { text: JOIN_FIRST, isError: true })
  assert.deepEqual(await tool(session, 'meeting_join', { invitation: 'f'.repeat(64) }), { text: 'This invitation is not known to the desktop. Ask the person for a new one.', isError: true })
  assert.deepEqual(await tool(session, 'meeting_join', { invitation: ` ${token} ` }), { text: `Joined meeting K7QF as security reviewer. ${FIRST_MESSAGE}`, isError: false })
  assert.equal(mailbox.seat(seat.id)?.via, 'mcp')

  const post = await tool(session, 'meeting_next', { wait_seconds: 5 })
  assert.match(post.text, /^\[meeting K7QF · round 1 · from the desktop\]/)
  assert.ok(post.text.endsWith('To answer, call meeting_reply with your whole reply.'), 'no reply file for an agent with the tools')
  assert.match(post.text, /the result of meeting_show\(name: "post", round: 1\)/)
  assert.deepEqual(await tool(session, 'meeting_reply', { text: ' ' }), { text: 'The reply is empty. Call meeting_reply with your whole answer.', isError: true })
  assert.deepEqual(await tool(session, 'meeting_reply', { text: 'Review: keyed by user, not session.' }), { text: REPLY_SENT, isError: false })
  assert.match(toHost.at(-1)!, /Review: keyed by user, not session\./)
  assert.deepEqual(await tool(session, 'meeting_next', { wait_seconds: 1 }), { text: `Nothing yet. Waiting for the host, fix login race. Call meeting_next again; ${STAY}.`, isError: false })

  hub.post('tab-host', 'round', 'Plan v2', 'x'.repeat(GUEST_PAGE_CHARS + 3))
  const round2 = await tool(session, 'meeting_next', { wait_seconds: 5 })
  assert.match(round2.text, /the result of meeting_show\(name: "changes", round: 2\)/)
  const page = await tool(session, 'meeting_show', { name: 'changes', round: 2 })
  assert.ok(page.text.endsWith(`[3 more characters: meeting_show(name: "changes", round: 2, offset: ${GUEST_PAGE_CHARS})]`))
  assert.equal((await tool(session, 'meeting_show', { name: 'changes', round: 2, offset: GUEST_PAGE_CHARS })).text, 'xxx\n[end]')
  assert.deepEqual(await tool(session, 'meeting_show', { name: '../secrets' }), { text: 'The name takes one of: post, changes, replies, transcript.', isError: true })
  await tool(session, 'meeting_reply', { text: 'Fine now.' })

  hub.post('tab-host', 'propose-close', 'Agreed.', null)
  assert.match((await tool(session, 'meeting_next', { wait_seconds: 5 })).text, /· vote · from the desktop\]/)
  await tool(session, 'meeting_reply', { text: 'AGREE' })
  assert.equal(hub.views()[0]!.outcome, 'agreed')
  assert.deepEqual(await tool(session, 'meeting_next', { wait_seconds: 1 }), { text: 'The meeting is closed.', isError: false })
})

test('a new session after a restart joins again with the same invitation and gets what it had not answered', async () => {
  const { hub, mailbox, rpc, tool } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const { token } = mailbox.invite('K7QF', 'Claude Code', null)
  const first = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(first, 'meeting_join', { invitation: token })
  const post = await tool(first, 'meeting_next', { wait_seconds: 5 })
  const second = (await rpc(undefined, 'initialize', {})).sessionId!
  assert.deepEqual(await tool(second, 'meeting_next'), { text: JOIN_FIRST, isError: true })
  await tool(second, 'meeting_join', { invitation: token })
  assert.equal((await tool(second, 'meeting_next', { wait_seconds: 5 })).text, post.text, 'the message handed out stays given')
})

test('sessions are bounded: the least recently used one goes first', () => {
  let now = 0
  const sessions = new GuestMcpSessions(() => now++)
  const first = sessions.open()
  const second = sessions.open()
  for (let index = 0; index < 62; index++) sessions.open()
  assert.ok(sessions.get(first), 'used just now')
  sessions.open()
  assert.equal(sessions.get(second), null, 'the oldest unused session was dropped')
  assert.ok(sessions.get(first))
})

test('every tool has a closed input schema', () => {
  for (const tool of GUEST_MCP_TOOLS) assert.equal(tool.inputSchema.additionalProperties, false, tool.name)
})

interface HttpAnswer { status: number; body: string; headers: Record<string, string | string[] | undefined> }

function http(port: number, method: string, headers: Record<string, string>, body?: string, path = '/mcp'): Promise<HttpAnswer> {
  return new Promise((resolveCall, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolveCall({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }))
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

test('the HTTP endpoint answers JSON on POST, refuses what a web page could send, and frees a wait when its client leaves', async () => {
  const { mailbox, deps } = meeting()
  const { seat, token } = mailbox.invite('K7QF', 'Claude Code', null)
  const ready: GuestDeps = { ...deps, isOpen: () => true, join: () => null }
  const server = new GuestMcpServer(mailbox, ready)
  const port = (await server.listen(0))!
  const json = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  try {
    assert.equal(server.url(), `http://127.0.0.1:${port}/mcp`)
    assert.equal((await http(port, 'POST', { ...json, origin: 'http://evil.example' }, '{}')).status, 403)
    assert.equal((await http(port, 'POST', { ...json, host: `evil.example:${port}` }, '{}')).status, 403, 'DNS rebinding')
    assert.equal((await http(port, 'GET', {})).status, 405)
    assert.equal((await http(port, 'POST', json, '{}', '/other')).status, 404)
    assert.equal((await http(port, 'POST', { 'content-type': 'text/plain' }, '{}')).status, 415)
    assert.equal((await http(port, 'POST', json, 'not json')).status, 400)
    assert.equal((await http(port, 'POST', json, '[]')).status, 400, 'no batches')

    const init = await http(port, 'POST', json, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
    assert.equal(init.status, 200)
    const session = String(init.headers['mcp-session-id'])
    assert.match(session, /^[0-9a-f-]{36}$/)
    const call = (id: number, name: string, args: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    const joined = await http(port, 'POST', { ...json, 'mcp-session-id': session }, call(2, 'meeting_join', { invitation: token }))
    assert.match(JSON.parse(joined.body).result.content[0].text, /^Joined meeting K7QF/)

    const abandoned = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { ...json, 'mcp-session-id': session } })
    abandoned.on('error', () => {})
    abandoned.end(call(3, 'meeting_next', { wait_seconds: 540 }))
    await until(() => mailbox.waiting(seat.id), 'meeting_next is waiting')
    abandoned.destroy()
    await until(() => !mailbox.waiting(seat.id), 'the abandoned wait ended')

    assert.equal((await http(port, 'DELETE', { 'mcp-session-id': session })).status, 200)
    assert.equal((await http(port, 'POST', { ...json, 'mcp-session-id': session }, call(4, 'meeting_next', {}))).status, 404, 'an ended session is gone')
  } finally {
    await server.close()
  }
})

test('every request over HTTP refreshes the state, so a quiet agent that asks for its status clears from the bar at once', async () => {
  const { hub, mailbox, deps } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const { seat, token } = mailbox.invite('K7QF', 'Claude Code', null)
  let refreshed = 0
  const server = new GuestMcpServer(mailbox, deps, () => { refreshed++ })
  const port = (await server.listen(0))!
  const json = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const call = (id: number, name: string, args: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  try {
    const init = await http(port, 'POST', json, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    const headers = { ...json, 'mcp-session-id': String(init.headers['mcp-session-id']) }
    await http(port, 'POST', headers, call(2, 'meeting_join', { invitation: token }))
    seat.lastSeenAt = 1
    const before = refreshed
    const status = await http(port, 'POST', headers, call(3, 'meeting_status', {}))
    assert.equal(JSON.parse(status.body).result.content[0].text, 'status of K7QF')
    await until(() => refreshed > before, 'the state was refreshed')
    assert.ok(seat.lastSeenAt > 1, 'its contact moved on before that refresh')
  } finally {
    await server.close()
  }
})

test('a taken port leaves the tools off instead of failing', async () => {
  const blocker = createServer()
  await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', () => resolveListen()))
  const taken = (blocker.address() as { port: number }).port
  const server = new GuestMcpServer(new GuestMailbox(realTimers), meeting().deps)
  try {
    assert.equal(await server.listen(taken), null)
    assert.equal(server.url(), null)
  } finally {
    await server.close()
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()))
  }
})

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise((resolveSoon) => setTimeout(resolveSoon, 20)) }
  throw new Error(`Timed out: ${label}`)
}

test('an outside host uses the tools: start with its invitation, answer the rounds, and hear the agreement', async () => {
  const { hub, mailbox, rpc, tool } = meeting()
  const host = mailbox.invite('', 'Claude Code', null, { kind: 'host', folder: 'D:\\api' })
  const reviewer = mailbox.invite('K7QF', 'Codex', null)
  const session = (await rpc(undefined, 'initialize', {})).sessionId!
  assert.deepEqual(await tool(session, 'meeting_join', { invitation: host.token }), { text: 'This is a host invitation: call meeting_start with it.', isError: true })
  assert.deepEqual(await tool(session, 'meeting_start', { invitation: reviewer.token, topic: 't', post: 'p' }), { text: 'This invitation is for reviewing: call meeting_join with it.', isError: true })
  const started = await tool(session, 'meeting_start', { invitation: host.token, topic: 'login race', post: 'Plan v1', changes: true })
  assert.match(started.text, /^Meeting K7QF is open\. .* Call meeting_next to wait for their replies/)
  assert.equal(hub.views()[0]!.hostTabId, host.seat.id)

  // The host's MCP session starts over (the desktop restarted): meeting_start with the same invitation binds the new
  // session to its open meeting, and says so, instead of an error the agent might stop at.
  const again = (await rpc(undefined, 'initialize', {})).sessionId!
  assert.deepEqual(await tool(again, 'meeting_start', { invitation: host.token, topic: 'again', post: 'again' }),
    { text: REJOINED_HOST, isError: false })
  assert.equal((await tool(again, 'meeting_status')).text, 'status of K7QF')
  assert.equal(hub.views().length, 1, 'no second meeting')

  const other = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(other, 'meeting_join', { invitation: reviewer.token })
  assert.match((await tool(other, 'meeting_next', { wait_seconds: 5 })).text, /the result of meeting_show\(name: "changes", round: 1\)/)
  await tool(other, 'meeting_reply', { text: 'Fine.' })

  const digest = await tool(session, 'meeting_next', { wait_seconds: 5 })
  assert.match(digest.text, /round 1 · replies · from the desktop\]/)
  assert.match(digest.text, /meeting_round\(post: "<your answer>", changes: true if you changed code\)/)
  assert.match(digest.text, /meeting_propose_close\(items: "<the agreed items>"\)/)
  assert.match(digest.text, /Then call meeting_next: the next replies arrive there\./)
  assert.ok(!digest.text.includes('To answer, call meeting_reply'), 'a host gets no reviewer footer')
  assert.deepEqual(await tool(session, 'meeting_reply', { text: 'x' }), { text: 'As the host, answer with meeting_round, meeting_propose_close or meeting_end.', isError: true })
  assert.equal((await tool(session, 'meeting_propose_close', { items: 'Lock on logout.' })).text, `Sent round 2 to 1 reviewer. Call meeting_next to wait for their replies; ${STAY}.`)
  await tool(other, 'meeting_next', { wait_seconds: 5 })
  await tool(other, 'meeting_reply', { text: 'AGREE' })
  assert.match((await tool(session, 'meeting_next', { wait_seconds: 5 })).text, /^\[meeting K7QF · closed · from the desktop\]/)
  assert.equal((await tool(session, 'meeting_next', { wait_seconds: 1 })).text, 'The meeting is closed.')
  assert.equal((await tool(session, 'meeting_status')).text, 'The meeting is closed.')
  assert.equal((await tool(again, 'meeting_start', { invitation: host.token, topic: 'x', post: 'y' })).text, 'The meeting is closed.', 'no rejoining a closed meeting')
})

/** The desktop restarted: its MCP sessions are gone, its seats are kept. A client for the new sessions. */
function restarted(mailbox: GuestMailbox, deps: GuestDeps, now?: () => number): {
  open(client: string): Promise<string>
  tool(sessionId: string, name: string, args?: Record<string, unknown>): Promise<string>
} {
  const sessions = new GuestMcpSessions(now)
  return {
    open: async (client) => (await handleMcpMessage(sessions, mailbox, deps, undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: client } } })).sessionId!,
    tool: async (sessionId, name, args = {}) => {
      const answer = await handleMcpMessage(sessions, mailbox, deps, sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
      return (answer.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text
    },
  }
}

/** The seat key a join or start without an invitation answers. */
function keyOf(text: string): string {
  const key = /call meeting_join with invitation: "([0-9a-f]{64})" to get your seat back\.$/.exec(text)?.[1]
  assert.ok(key, `no seat key in: ${text}`)
  return key
}

test('an agent joins by meeting id alone, named after its client, and a second one of the same kind gets a seat of its own', async () => {
  const { hub, mailbox, rpc, tool, toHost } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const claude = (await rpc(undefined, 'initialize', { clientInfo: { name: 'claude-code', version: '2' } })).sessionId!
  assert.deepEqual(await tool(claude, 'meeting_join', {}), { text: 'Pass the meeting id the person gave you, such as meeting: "K7QF", or the invitation they pasted.', isError: true })
  assert.deepEqual(await tool(claude, 'meeting_join', { meeting: 'ZZZZ' }), { text: 'There is no open meeting ZZZZ.', isError: true })
  const joined = await tool(claude, 'meeting_join', { meeting: ' k7qf ', role: 'security reviewer' })
  assert.match(joined.text, /^Joined meeting K7QF as security reviewer\. Call meeting_next for your first message\. .* Keep this seat key: /)
  assert.equal(mailbox.seatOf(keyOf(joined.text))?.name, 'Claude Code', 'the key is the seat\'s own token')
  assert.deepEqual(hub.views()[0]!.participants.map((party) => party.title), ['Claude Code (guest)'], 'joined at once: the meeting bar shows it')
  assert.deepEqual(await tool(claude, 'meeting_join', { meeting: 'K7QF' }), { text: `Joined meeting K7QF as security reviewer. ${FIRST_MESSAGE}`, isError: false }, 'joining again changes nothing')

  const second = (await rpc(undefined, 'initialize', { clientInfo: { name: 'claude-code' } })).sessionId!
  assert.match((await tool(second, 'meeting_join', { meeting: 'K7QF' })).text, /^Joined meeting K7QF\./)
  const codex = (await rpc(undefined, 'initialize', { clientInfo: { name: 'codex-mcp-client' } })).sessionId!
  await tool(codex, 'meeting_join', { meeting: 'K7QF' })
  const named = (await rpc(undefined, 'initialize', { clientInfo: { name: 'claude-code' } })).sessionId!
  await tool(named, 'meeting_join', { meeting: 'K7QF', name: 'Opus reviewer' })
  assert.deepEqual(hub.views()[0]!.participants.map((party) => party.title), ['Claude Code (guest)', 'Claude Code 2 (guest)', 'Codex (guest)', 'Opus reviewer (guest)'])

  const post = await tool(claude, 'meeting_next', { wait_seconds: 5 })
  assert.match(post.text, /^\[meeting K7QF · round 1 · from the desktop\]/)
  assert.ok(post.text.endsWith('To answer, call meeting_reply with your whole reply.'))
  assert.deepEqual(await tool(claude, 'meeting_reply', { text: 'Keyed by user.' }), { text: REPLY_SENT, isError: false })
  for (const other of [second, codex, named]) { await tool(other, 'meeting_next', { wait_seconds: 5 }); await tool(other, 'meeting_reply', { text: 'Fine.' }) }
  assert.match(toHost.at(-1)!, /Keyed by user\./)

  // A meeting holds 8 reviewers: the ninth hears why, and no seat is left behind.
  for (let index = 0; index < 4; index++) await tool((await rpc(undefined, 'initialize', {})).sessionId!, 'meeting_join', { meeting: 'K7QF' })
  const ninth = (await rpc(undefined, 'initialize', {})).sessionId!
  assert.deepEqual(await tool(ninth, 'meeting_join', { meeting: 'K7QF' }), { text: 'Meeting K7QF already has 8 participants.', isError: true })
  assert.equal(mailbox.seatsOf('K7QF').length, 8)
  assert.deepEqual(await tool(ninth, 'meeting_next'), { text: JOIN_FIRST, isError: true })
})

test('after a restart only the seat key gets a seat back: the same name gets a new seat, and the message handed out stays given', async () => {
  const { hub, mailbox, deps, rpc, tool } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const first = (await rpc(undefined, 'initialize', { clientInfo: { name: 'claude-code' } })).sessionId!
  const key = keyOf((await tool(first, 'meeting_join', { meeting: 'K7QF' })).text)
  const post = await tool(first, 'meeting_next', { wait_seconds: 5 })

  const desktop = restarted(mailbox, deps)
  const again = await desktop.open('claude-code')
  assert.equal(await desktop.tool(again, 'meeting_next'), JOIN_FIRST)
  assert.equal(await desktop.tool(again, 'meeting_join', { invitation: key }), `Joined meeting K7QF. ${FIRST_MESSAGE}`)
  assert.equal(mailbox.seatsOf('K7QF').length, 1, 'the same seat, not a second one')
  assert.equal(await desktop.tool(again, 'meeting_next', { wait_seconds: 5 }), post.text, 'the message handed out stays given')

  // Another agent of the same client, by id alone: a seat of its own, never the first one's.
  const other = await desktop.open('claude-code')
  assert.match(await desktop.tool(other, 'meeting_join', { meeting: 'K7QF' }), /^Joined meeting K7QF\. Call meeting_next for your first message\. .* Keep this seat key: /)
  assert.deepEqual(mailbox.seatsOf('K7QF').map((entry) => entry.name), ['Claude Code', 'Claude Code 2'])
})

test('an outside agent starts a meeting with its own folder, another of the same client reviews, and neither takes the other seat after a restart', async () => {
  const { hub, mailbox, deps, rpc, tool } = meeting()
  const host = (await rpc(undefined, 'initialize', { clientInfo: { name: 'claude-code' } })).sessionId!
  assert.deepEqual(await tool(host, 'meeting_start', { topic: 't', post: 'p', folder: 'Z:\\nowhere' }), { text: 'Z:\\nowhere is not a folder.', isError: true })
  assert.deepEqual(await tool(host, 'meeting_start', { topic: 't', post: ' ' }), { text: 'The post is empty. Send your whole plan, answer or agreed items.', isError: true })
  assert.equal(hub.views().length, 0)
  assert.equal(mailbox.views().length, 0, 'a start that failed leaves no open seat')
  const started = await tool(host, 'meeting_start', { topic: 'login race', post: 'Plan v1', folder: 'D:\\api', changes: true })
  assert.match(started.text, /^Meeting K7QF is open\. Tell the person its id now, in a message that does not end your turn: they add reviewers by telling another agent "join meeting K7QF", or from the desktop\. Call meeting_next .* Keep this seat key: /)
  const hostKey = keyOf(started.text)
  const seat = mailbox.seat(hub.views()[0]!.hostTabId)!
  assert.equal(seat.name, 'Claude Code')
  assert.equal(seat.folder, 'D:\\api')
  assert.equal(mailbox.seatOf(hostKey), seat)
  assert.deepEqual(await tool(host, 'meeting_start', { topic: 'again', post: 'again' }), { text: 'You are already in meeting K7QF. Close it with meeting_end first.', isError: true })
  assert.deepEqual(await tool(host, 'meeting_join', { meeting: 'K7QF' }), { text: REJOINED_HOST, isError: false })

  const reviewer = (await rpc(undefined, 'initialize', { clientInfo: { name: 'claude-code' } })).sessionId!
  const reviewerKey = keyOf((await tool(reviewer, 'meeting_join', { meeting: 'K7QF' })).text)
  assert.match((await tool(reviewer, 'meeting_next', { wait_seconds: 5 })).text, /the result of meeting_show\(name: "changes", round: 1\)/)
  await tool(reviewer, 'meeting_reply', { text: 'Fine.' })
  assert.match((await tool(host, 'meeting_next', { wait_seconds: 5 })).text, /round 1 · replies · from the desktop\]/)

  // The desktop restarts, and the reviewer happens to call first, by id alone: it does not get the host's seat.
  const desktop = restarted(mailbox, deps)
  const reviewerAgain = await desktop.open('claude-code')
  assert.match(await desktop.tool(reviewerAgain, 'meeting_join', { meeting: 'K7QF' }), /^Joined meeting K7QF\. /)
  assert.equal(await desktop.tool(reviewerAgain, 'meeting_end'), 'This invitation is for reviewing. Hosting a meeting needs a host invitation from the person.')
  const hostAgain = await desktop.open('claude-code')
  assert.equal(await desktop.tool(hostAgain, 'meeting_join', { invitation: hostKey }), REJOINED_HOST)
  assert.equal(await desktop.tool(hostAgain, 'meeting_status'), 'status of K7QF')
  assert.equal(await desktop.tool(await desktop.open('claude-code'), 'meeting_join', { invitation: reviewerKey }), `Joined meeting K7QF. ${FIRST_MESSAGE}`)
  assert.equal(hub.views().length, 1, 'no second meeting')
  assert.equal(hub.views()[0]!.hostTabId, seat.id, 'the host is still the host')
})

test('wrong meeting ids are throttled across sessions: a few typos pass, guessing does not', async () => {
  const { hub, mailbox, deps } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  let now = 0
  const desktop = restarted(mailbox, deps, () => now)
  for (const id of ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE']) assert.equal(await desktop.tool(await desktop.open('x'), 'meeting_join', { meeting: id }), `There is no open meeting ${id}.`)
  const tooMany = 'Too many wrong meeting ids in the last minute. Check the id with the person, then try again in a minute.'
  assert.equal(await desktop.tool(await desktop.open('x'), 'meeting_join', { meeting: 'FFFF' }), tooMany, 'a new session does not reset the count')
  assert.equal(await desktop.tool(await desktop.open('x'), 'meeting_join', { meeting: 'K7QF' }), tooMany, 'not even the right id, while guessing')
  now = 60_000
  assert.match(await desktop.tool(await desktop.open('x'), 'meeting_join', { meeting: 'K7QF' }), /^Joined meeting K7QF\./, 'a minute later it passes')
})

test('a start waiting on its folder check holds the session: an overlapping start or join is refused, and the session stays tied to its meeting', async () => {
  const { hub, mailbox, deps } = meeting()
  let release = (): void => {}
  const held = new Promise<null>((resolveCheck) => { release = () => resolveCheck(null) })
  const desktop = restarted(mailbox, { ...deps, checkFolder: () => held })
  const session = await desktop.open('claude-code')
  const first = desktop.tool(session, 'meeting_start', { topic: 'login race', post: 'Plan v1', folder: 'D:\\api' })
  const underWay = 'Your meeting_start is still under way: wait for its answer.'
  assert.equal(await desktop.tool(session, 'meeting_start', { topic: 'other', post: 'Plan B' }), underWay)
  assert.equal(await desktop.tool(session, 'meeting_join', { meeting: 'K7QF' }), underWay)
  assert.equal(hub.views().length, 0, 'nothing started meanwhile')
  release()
  assert.match(await first, /^Meeting K7QF is open\./)
  assert.equal(hub.views().length, 1, 'one meeting')
  assert.equal(await desktop.tool(session, 'meeting_status'), 'status of K7QF', 'the session holds the meeting it started')
  assert.equal(await desktop.tool(session, 'meeting_start', { topic: 'other', post: 'Plan B' }), 'You are already in meeting K7QF. Close it with meeting_end first.')
})

test('a seat is named by what the agent passed, else by its client', () => {
  assert.equal(agentName('  Opus "reviewer" ', null), 'Opus reviewer')
  assert.equal(agentName(undefined, 'claude-code'), 'Claude Code')
  assert.equal(agentName(undefined, 'codex-mcp-client'), 'Codex')
  assert.equal(agentName(undefined, 'gemini-cli-mcp-client'), 'Gemini CLI')
  assert.equal(agentName('', null), 'Outside agent')
})

test('every answer on the way says to stay in the turn, since a meeting joined by id has no invitation to say it', async () => {
  const { rpc, tool } = meeting()
  const init = await rpc(undefined, 'initialize', {})
  assert.ok(String((init.body as { result: { instructions: string } }).result.instructions).includes(STAY))
  assert.match(GUEST_MCP_TOOLS.find((entry) => entry.name === 'meeting_next')!.description, /Keep calling it until the meeting is closed, answering each message first/)
  const host = init.sessionId!
  const started = await tool(host, 'meeting_start', { topic: 'login race', post: 'Plan v1' })
  assert.match(started.text, /Tell the person its id now, in a message that does not end your turn/)
  assert.ok(started.text.includes(STAY))
  assert.deepEqual(await tool(host, 'meeting_next', { wait_seconds: 1 }), { text: `Nothing yet. Nobody has joined yet. Call meeting_next again; ${STAY}.`, isError: false })

  const reviewer = (await rpc(undefined, 'initialize', {})).sessionId!
  assert.ok((await tool(reviewer, 'meeting_join', { meeting: 'K7QF' })).text.includes(STAY))
  assert.deepEqual(await tool(host, 'meeting_next', { wait_seconds: 1 }), { text: `Nothing yet. Waiting for Outside agent 2 (guest). Call meeting_next again; ${STAY}.`, isError: false })
})

test('a round sent too early tells an outside host to wait with meeting_next, not to end its turn', async () => {
  const { rpc, tool } = meeting()
  const host = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(host, 'meeting_start', { topic: 'login race', post: 'Plan v1' })
  const reviewer = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(reviewer, 'meeting_join', { meeting: 'K7QF' })
  const answer = `The reviewers have not all answered yet. Call meeting_next to wait for their replies; ${STAY}.`
  assert.deepEqual(await tool(host, 'meeting_round', { post: 'Plan v2' }), { text: answer, isError: true })
  assert.deepEqual(await tool(host, 'meeting_propose_close', { items: 'Agreed.' }), { text: answer, isError: true })
})

test('a reviewer can ask where the meeting stands, but still cannot act as the host', async () => {
  const { hub, rpc, tool } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const reviewer = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(reviewer, 'meeting_join', { meeting: 'K7QF' })
  assert.deepEqual(await tool(reviewer, 'meeting_status'), { text: 'status of K7QF', isError: false })
  assert.match((await tool(reviewer, 'meeting_end')).text, /This invitation is for reviewing/)
  assert.equal(hub.views()[0]!.stage, 'reviewing')
})

test('a wait over the tools is capped under what clients allow; a bad value is still refused', async () => {
  const { hub, mailbox, rpc, tool } = meeting()
  hub.start({ tabId: 'tab-host', title: 'fix login race', folder: 'D:\\api' }, { topic: 'login', post: 'Plan v1', changes: null })
  const session = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(session, 'meeting_join', { meeting: 'K7QF' })
  assert.equal(GUEST_MCP_TOOLS.find((entry) => entry.name === 'meeting_next')!.inputSchema.properties.wait_seconds.maximum, 50)
  const asked: number[] = []
  mailbox.wait = async (_seatId, ms) => { asked.push(ms); return false }
  for (const wait_seconds of [540, 120, 50, 5]) await tool(session, 'meeting_next', { wait_seconds })
  await tool(session, 'meeting_next')
  assert.deepEqual(asked, [50_000, 50_000, 50_000, 5_000, 50_000])
  for (const wait_seconds of [0, 'soon']) assert.deepEqual(await tool(session, 'meeting_next', { wait_seconds }), { text: 'The wait takes 1 to 50 seconds.', isError: true })
  assert.equal(asked.length, 5, 'refused before waiting')
})

test('a retry after the answer with the replies was lost gets a reminder that says where they are, and the host can still answer', async () => {
  const { hub, rpc, tool } = meeting()
  const host = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(host, 'meeting_start', { topic: 'login race', post: 'Plan v1' })
  const reviewer = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(reviewer, 'meeting_join', { meeting: 'K7QF' })
  await tool(reviewer, 'meeting_next', { wait_seconds: 1 })
  await tool(reviewer, 'meeting_reply', { text: 'Keyed by user.' })
  assert.match((await tool(host, 'meeting_next', { wait_seconds: 1 })).text, /round 1 · replies · from the desktop\]/)

  // The client never saw that answer and asks again: to the desktop that is a host passing over the replies.
  const reminder = await tool(host, 'meeting_next', { wait_seconds: 1 })
  assert.match(reminder.text, /^\[meeting K7QF · reminder · from the desktop\]/)
  assert.ok(reminder.text.includes('The reviewers\' replies are in the result of meeting_show(name: "replies", round: 1).'), reminder.text)
  assert.match((await tool(host, 'meeting_show', { name: 'replies', round: 1 })).text, /Keyed by user\./)
  assert.equal(hub.views()[0]!.stage, 'host', 'one retry does not pause the meeting')
  assert.match((await tool(host, 'meeting_round', { post: 'Plan v2' })).text, /^Sent round 2 to 1 reviewer\./)
})

test('a closed meeting stays readable by those who took part to the end, not by a seat taken out earlier', async () => {
  const { hub, mailbox, rpc, tool } = meeting()
  const host = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(host, 'meeting_start', { topic: 'login race', post: 'Plan v1' })
  const reviewer = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(reviewer, 'meeting_join', { meeting: 'K7QF' })
  const removed = (await rpc(undefined, 'initialize', {})).sessionId!
  await tool(removed, 'meeting_join', { meeting: 'K7QF', name: 'Removed' })
  const removedSeat = mailbox.seatsOf('K7QF').find((seat) => seat.name === 'Removed')!
  hub.leave(removedSeat.id)
  mailbox.close(removedSeat.id, 'The person removed you from the meeting.')
  await tool(reviewer, 'meeting_next', { wait_seconds: 1 })
  await tool(reviewer, 'meeting_reply', { text: 'Fine.' })
  await tool(host, 'meeting_next', { wait_seconds: 1 })
  await tool(host, 'meeting_propose_close', { items: 'Lock on logout.' })
  await tool(reviewer, 'meeting_next', { wait_seconds: 1 })
  await tool(reviewer, 'meeting_reply', { text: 'AGREE' })
  assert.equal(hub.views()[0]!.outcome, 'agreed')

  const closing = await tool(host, 'meeting_next', { wait_seconds: 1 })
  assert.match(closing.text, /the agreed items are in the result of meeting_show\(name: "post", round: 2\)/)
  assert.match((await tool(host, 'meeting_show', { name: 'post', round: 2 })).text, /Lock on logout\./)
  assert.match((await tool(reviewer, 'meeting_show', { name: 'transcript' })).text, /AGREE/)
  assert.equal((await tool(removed, 'meeting_show', { name: 'transcript' })).text, 'The person removed you from the meeting.')
  assert.equal((await tool(host, 'meeting_next', { wait_seconds: 1 })).text, 'The meeting is closed.')
})
