import assert from 'node:assert/strict'
import { request } from 'node:http'
import test from 'node:test'
import { GUEST_QUIET_MS, guestQuiet, guestStalled } from './meeting-contact.js'
import { GuestMailbox, GUEST_WAKE_GRACE_MS, guestWakeKey, type GuestDeps } from './meeting-guests.js'
import { guestMcpInstructions, GuestMcpServer, GuestMcpSessions, GUEST_MCP_INSTRUCTIONS, handleMcpMessage } from './meeting-guest-mcp.js'
import { guestWakeCommand, guestWakeRequest, guestWakeText, guestWatchText, queueCodexWake, type CodexQueueDeps } from './meeting-guest-wake.js'
import { realMeetingTimers, type MeetingDelivery, type MeetingTimers } from './meeting.js'

const THREAD = '01a1b44d-0120-7672-998c-37e26f2afe93'

function clock(): { timers: MeetingTimers; advance(ms: number): void } {
  let now = 1_000_000
  return { timers: { now: () => now, set: () => () => {} }, advance: (ms) => { now += ms } }
}

const delivery = (round = 1, kind: MeetingDelivery['kind'] = 'post'): MeetingDelivery => ({ meetingId: 'K7QF', round, kind, text: `message ${round}` })

/** A seat in meeting K7QF that asked for something just now. */
function seated(thread: string | null = THREAD) {
  const time = clock()
  const mailbox = new GuestMailbox(time.timers)
  const { seat } = mailbox.invite('K7QF', 'Codex', null)
  mailbox.joined(seat)
  mailbox.seen(seat, 'mcp')
  if (thread) mailbox.setCodexThread(seat, thread)
  return { ...time, mailbox, seat, now: () => time.timers.now() }
}

test('a seat is woken only when it is owed a message, is not asking, and has been quiet for a while', () => {
  const { mailbox, seat, advance, now } = seated()
  advance(GUEST_WAKE_GRACE_MS + 1)
  assert.deepEqual(mailbox.wakeDue(now()), [], 'quiet, but nothing is owed: it costs the agent nothing to sleep')
  mailbox.enqueue(seat.id, delivery())
  assert.deepEqual(mailbox.wakeDue(now()), [seat], 'owed and quiet')
  mailbox.seen(seat, 'mcp')
  assert.deepEqual(mailbox.wakeDue(now()), [], 'it just asked for something: a polling agent is left alone')
  advance(GUEST_WAKE_GRACE_MS)
  assert.deepEqual(mailbox.wakeDue(now()), [], 'exactly at the limit is not yet quiet')
  advance(1)
  assert.deepEqual(mailbox.wakeDue(now(), now()), [], 'the desktop just started: agents get time to reconnect')
  assert.deepEqual(mailbox.wakeDue(now()), [seat])
})

test('a seat with an open next is not woken, and one that cannot be woken is never due', () => {
  const open = seated()
  void open.mailbox.wait(open.seat.id, 50_000)
  open.advance(GUEST_QUIET_MS + 1)
  assert.equal(open.mailbox.waiting(open.seat.id), true)
  assert.deepEqual(open.mailbox.wakeDue(open.now()), [])

  const unreachable = seated(null)
  unreachable.mailbox.enqueue(unreachable.seat.id, delivery())
  unreachable.advance(GUEST_WAKE_GRACE_MS + 1)
  assert.deepEqual(unreachable.mailbox.wakeDue(unreachable.now()), [], 'neither a thread nor a background command')
})

test('one wake-up per quiet spell, and hearing from the seat starts a new spell', () => {
  const { mailbox, seat, advance, now } = seated()
  mailbox.enqueue(seat.id, delivery())
  advance(GUEST_WAKE_GRACE_MS + 1)
  mailbox.woke(seat.id)
  advance(60 * 60_000)
  assert.deepEqual(mailbox.wakeDue(now()), [], 'it did not answer the first one; the person is told instead of waking it forever')
  mailbox.seen(seat, 'mcp')
  advance(GUEST_WAKE_GRACE_MS + 1)
  assert.deepEqual(mailbox.wakeDue(now()), [seat])
})

test('one holding a message gets longer: it may be working on it', () => {
  const { mailbox, seat, advance, now } = seated()
  mailbox.enqueue(seat.id, delivery())
  mailbox.take(seat.id)
  advance(GUEST_WAKE_GRACE_MS + 1)
  assert.deepEqual(mailbox.wakeDue(now()), [])
  advance(GUEST_QUIET_MS)
  assert.deepEqual(mailbox.wakeDue(now()), [seat])
})

test('after its meeting closed, only a host with a last message to read is woken', () => {
  const reviewer = seated()
  reviewer.mailbox.enqueue(reviewer.seat.id, delivery())
  reviewer.mailbox.close(reviewer.seat.id, 'The meeting is closed.')
  reviewer.advance(GUEST_WAKE_GRACE_MS + 1)
  assert.deepEqual(reviewer.mailbox.wakeDue(reviewer.now()), [])

  const time = clock()
  const mailbox = new GuestMailbox(time.timers)
  const { seat } = mailbox.invite('', 'Codex', null, { kind: 'host' })
  mailbox.started(seat, 'K7QF')
  mailbox.seen(seat, 'mcp')
  mailbox.setCodexThread(seat, THREAD)
  mailbox.enqueue(seat.id, delivery(1, 'agreed'))
  mailbox.close(seat.id, 'The meeting is closed.')
  time.advance(GUEST_WAKE_GRACE_MS + 1)
  assert.deepEqual(mailbox.wakeDue(time.timers.now()), [seat])
  assert.match(guestWakeText(seat, false), /is closed and has a last message/)
})

test('a seat that can be woken does not count as stopped, until a wake-up brought no answer', () => {
  const { mailbox, seat, advance, now } = seated()
  advance(GUEST_QUIET_MS + 1)
  const view = () => mailbox.views()[0]!
  assert.equal(view().waiting, true, 'it can be reached when it is needed')
  assert.equal(guestStalled(view(), now()), false, 'no false alarm for an agent that is owed nothing')
  mailbox.woke(seat.id)
  assert.equal(view().waiting, false)
  assert.equal(guestQuiet(view(), now()), false, 'the wake-up gets time to work')
  advance(GUEST_QUIET_MS + 1)
  assert.equal(guestStalled(view(), now()), true, 'it did not come back: now the person hears')
  mailbox.seen(seat, 'mcp')
  assert.equal(view().wokenAt, null)
})

test('a thread and a wake key survive a restart; a wake key is not the token and does not open the seat', () => {
  const { mailbox, seat } = seated()
  const key = guestWakeKey(seat)
  assert.equal(mailbox.seatOfWakeKey(key), seat)
  assert.equal(mailbox.seatOf(key), null)
  assert.equal(mailbox.seatOfWakeKey('0'.repeat(32)), null)
  const restored = new GuestMailbox(clock().timers)
  restored.restore(JSON.parse(mailbox.serialize()))
  const again = restored.seat(seat.id)!
  assert.equal(again.codexThread, THREAD)
  assert.equal(guestWakeKey(again), key)
  const old = JSON.parse(mailbox.serialize())
  delete old.seats[0].codexThread
  const older = new GuestMailbox(clock().timers)
  older.restore(old)
  assert.equal(older.seat(seat.id)!.codexThread, null, 'seats saved by an older version still load')
  old.seats[0].codexThread = '--thread & calc'
  const wrong = new GuestMailbox(clock().timers)
  wrong.restore(old)
  assert.equal(wrong.seat(seat.id)!.codexThread, null)
})

test('watchers end when the seat is woken or closed, and quietly when the desktop goes away', async () => {
  const { mailbox, seat } = seated(null)
  const woken = mailbox.watch(seat.id)
  assert.equal(mailbox.watching(seat.id), true)
  mailbox.woke(seat.id)
  assert.equal(await woken, 'wake')
  assert.equal(mailbox.watching(seat.id), false)
  const quitting = mailbox.watch(seat.id)
  mailbox.release()
  assert.equal(await quitting, null)
  const abort = new AbortController()
  const dropped = mailbox.watch(seat.id, abort.signal)
  abort.abort()
  assert.equal(await dropped, null)
  assert.equal(mailbox.watching(seat.id), false, 'the command was stopped: it can no longer wake the agent')
  const closing = mailbox.watch(seat.id)
  mailbox.close(seat.id, 'The meeting is closed.')
  assert.equal(await closing, 'closed')
  assert.equal(await mailbox.watch(seat.id), 'closed', 'already over')
  assert.match(guestWatchText(seat, 'closed', false), /nothing more to do/)
})

test('an agent cannot pile up watchers, each of which would cost it a turn', async () => {
  const { mailbox, seat } = seated(null)
  const first = mailbox.watch(seat.id)
  for (let index = 0; index < 3; index++) void mailbox.watch(seat.id)
  void mailbox.watch(seat.id)
  assert.equal(await first, 'replaced')
})

test('starting a watcher begins a new spell, so a message still owed wakes the agent again', () => {
  const { mailbox, seat, advance, now } = seated(null)
  void mailbox.watch(seat.id)
  mailbox.enqueue(seat.id, delivery())
  advance(GUEST_WAKE_GRACE_MS + 1)
  assert.deepEqual(mailbox.wakeDue(now()), [seat])
  mailbox.woke(seat.id)
  assert.deepEqual(mailbox.wakeDue(now()), [])
  void mailbox.watch(seat.id)
  assert.deepEqual(mailbox.wakeDue(now()), [seat])
})

test('a host holding replies is told to answer them, since another meeting_next would count as not answering', () => {
  const { mailbox } = seated()
  const { seat } = mailbox.invite('', 'Codex', null, { kind: 'host' })
  mailbox.started(seat, 'K7QF')
  assert.match(guestWakeText(seat, true), /Answer with meeting_round, meeting_propose_close or meeting_end/)
  assert.match(guestWakeText(seat, false), /has a message for you\. Call meeting_next/)
})

test('the wake-up request tells the agent to do what the command prints, not always to call meeting_next', () => {
  const text = guestWakeRequest('curl http://x/')
  assert.match(text, /When it exits, read what it printed and do that/)
  assert.doesNotMatch(text, /When it exits, call meeting_next/)
})

test('over HTTP: a host woken while holding the replies or a reminder is told to answer, and only then to call meeting_next', async () => {
  const mailbox = new GuestMailbox(clock().timers)
  const { seat } = mailbox.invite('', 'Claude Code', null, { kind: 'host' })
  mailbox.started(seat, 'K7QF')
  const server = new GuestMcpServer(mailbox, noDeps())
  const port = (await server.listen(0))!
  const woken = async (): Promise<string> => {
    const waiting = post(port, `/meeting-wake/${guestWakeKey(seat)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    mailbox.woke(seat.id)
    return (await waiting).text
  }
  try {
    mailbox.enqueue(seat.id, delivery(1, 'digest'))
    assert.match(await woken(), /has a message for you\. Call meeting_next/, 'not read yet: meeting_next is how it gets the replies')
    for (const kind of ['digest', 'reminder'] as const) {
      if (kind === 'reminder') { mailbox.answer(seat.id); mailbox.enqueue(seat.id, delivery(1, kind)) }
      assert.equal(mailbox.take(seat.id)?.kind, kind)
      const text = await woken()
      assert.match(text, /waiting for your answer to the reviewers' replies\. Answer with meeting_round, meeting_propose_close or meeting_end, then call meeting_next/, kind)
      assert.doesNotMatch(text, /Call meeting_next and answer/, kind)
    }
  } finally { await server.close() }
})

test('a reviewer holding a message is still told to call meeting_next: the host wording is only for a host', () => {
  const { seat } = seated()
  assert.match(guestWatchText(seat, 'wake', true), /has a message for you\. Call meeting_next/)
})

/** The Codex tools a computer has: what `where codex` and the app's package answer, and who fails. */
function codexDeps(where: string, app: string, failing: readonly string[] = []): CodexQueueDeps & { calls: Array<{ file: string; args: readonly string[]; verbatim: boolean }> } {
  const calls: Array<{ file: string; args: readonly string[]; verbatim: boolean }> = []
  return {
    calls,
    env: { SystemRoot: 'C:\\Windows' },
    platform: 'win32',
    run: async (file, args, options) => {
      if (/where\.exe$/i.test(file)) return where
      if (/powershell\.exe$/i.test(file)) return app
      calls.push({ file, args, verbatim: options?.windowsVerbatimArguments === true })
      if (failing.some((name) => file.includes(name) || args.join(' ').includes(name))) throw new Error('no queue command')
      return 'Queued message\n'
    },
  }
}

const TEXT = '[Copilot CLI Desktop] Meeting K7QF has a message for you. Call meeting_next.'

test('the Codex on the PATH goes first, then the one in the Codex app, which is not on the PATH', async () => {
  const both = codexDeps('C:\\tools\\codex.exe\r\n', 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\r\n')
  assert.equal(await queueCodexWake(THREAD, TEXT, both), true)
  assert.deepEqual(both.calls, [{ file: 'C:\\tools\\codex.exe', args: ['queue', '--thread', THREAD, '--message', TEXT], verbatim: false }])

  const appOnly = codexDeps('', 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\r\n')
  assert.equal(await queueCodexWake(THREAD, TEXT, appOnly), true)
  assert.equal(appOnly.calls[0]!.file, 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\resources\\codex.exe')

  const old = codexDeps('C:\\tools\\codex.exe\r\n', 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\r\n', ['tools'])
  assert.equal(await queueCodexWake(THREAD, TEXT, old), true, 'one too old for `queue`: the next one takes it')
  assert.equal(old.calls.length, 2)

  const none = codexDeps('', '')
  assert.equal(await queueCodexWake(THREAD, TEXT, none), false)
  assert.equal(none.calls.length, 0)
})

test('an npm shim starts through cmd.exe, with only the checked thread id and text', async () => {
  const shim = codexDeps('C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\n', '')
  assert.equal(await queueCodexWake(THREAD, TEXT, shim), true)
  assert.equal(shim.calls.length, 1, 'the extensionless script where.exe also lists is not started')
  assert.match(shim.calls[0]!.file, /cmd\.exe$/i)
  assert.equal(shim.calls[0]!.verbatim, true)
  assert.deepEqual(shim.calls[0]!.args, ['/d', '/s', '/c', `""C:\\npm\\codex.cmd" queue --thread ${THREAD} --message "${TEXT}""`])

  const unsafe = codexDeps('C:\\npm\\codex.cmd\r\n', '')
  assert.equal(await queueCodexWake(THREAD, 'a & calc', unsafe), false, 'text a shell could read as a command does not reach one')
  assert.equal(unsafe.calls.length, 0)
  const unsafePath = codexDeps('C:\\%USERNAME%\\codex.cmd\r\n', '')
  assert.equal(await queueCodexWake(THREAD, TEXT, unsafePath), false)
  const badThread = codexDeps('C:\\tools\\codex.exe\r\n', '')
  assert.equal(await queueCodexWake(`${THREAD} & calc`, TEXT, badThread), false, 'a thread id comes from a request, so it is checked')
  assert.equal(badThread.calls.length, 0)
})

test('every wake text passes the check for an npm shim', async () => {
  const { mailbox, seat } = seated()
  const { seat: host } = mailbox.invite('', 'Codex', null, { kind: 'host' })
  mailbox.started(host, 'K7QF')
  const closed = seated().seat
  closed.closed = 'The meeting is closed.'
  for (const text of [guestWakeText(seat, false), guestWakeText(host, true), guestWakeText(closed, false)]) {
    const shim = codexDeps('C:\\npm\\codex.cmd\r\n', '')
    assert.equal(await queueCodexWake(THREAD, text, shim), true, text)
  }
})

test('the wake-up command waits without a limit and retries while the desktop is away', () => {
  const command = guestWakeCommand('http://127.0.0.1:47391/meeting-wake/abc', true)
  assert.match(command, /^curl\.exe /, 'plain curl is an alias for something else in PowerShell')
  assert.match(command, /--retry-all-errors/)
  assert.doesNotMatch(command, /--max-time|-m /)
  assert.match(guestWakeCommand('http://x/', false), /^curl /)
})

test('the instructions tell each agent how it can be reached, and others stay as they were', () => {
  assert.equal(guestMcpInstructions('some-other-client'), GUEST_MCP_INSTRUCTIONS)
  assert.equal(guestMcpInstructions(null), GUEST_MCP_INSTRUCTIONS)
  assert.match(GUEST_MCP_INSTRUCTIONS, /Nothing can wake you/)
  assert.doesNotMatch(guestMcpInstructions('codex-mcp-client'), /Nothing can wake you/)
  assert.match(guestMcpInstructions('claude-code'), /a wake-up command the tools ask you to keep running/)
})

const noDeps = (over: Partial<GuestDeps> = {}): GuestDeps => ({
  ready: () => true, isOpen: () => true, join: () => null, leave: () => {}, turnCompleted: () => {}, material: async () => null,
  start: () => ({ meetingId: 'K7QF' }), post: () => ({ ok: true, message: 'posted' }), end: () => ({ ok: true, message: 'closed' }),
  status: () => 'status', waitingOn: () => null, changes: async () => '', checkFolder: async () => null, ...over,
})

async function mcpClient(sessions: GuestMcpSessions, mailbox: GuestMailbox, name: string) {
  const opened = await handleMcpMessage(sessions, mailbox, noDeps(), undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name } } })
  const sessionId = opened.sessionId!
  return (tool: string, args: Record<string, unknown> = {}, meta?: unknown) => handleMcpMessage(sessions, mailbox, noDeps(), sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) } })
    .then((answer) => ((answer.body as { result: { content: Array<{ text: string }> } }).result.content.map((block) => block.text)))
}

test('Codex names its thread on its calls, and the seat keeps the latest; a thread id that is not one is ignored', async () => {
  const mailbox = new GuestMailbox(clock().timers)
  const sessions = new GuestMcpSessions()
  const codex = await mcpClient(sessions, mailbox, 'codex-mcp-client')
  await codex('meeting_join', { meeting: 'K7QF' }, { threadId: THREAD })
  const seat = mailbox.seatsOf('K7QF')[0]!
  assert.equal(seat.codexThread, THREAD, 'from the very join')
  await codex('meeting_status', {}, { threadId: 'x" & calc' })
  assert.equal(seat.codexThread, THREAD)

  const other = await mcpClient(sessions, mailbox, 'some-other-client')
  await other('meeting_join', { meeting: 'K7QF', name: 'Other' }, { threadId: THREAD })
  assert.equal(mailbox.seatsOf('K7QF')[1]!.codexThread, null, 'only Codex says what a thread is')
})

test('Claude Code is asked to keep a wake-up running, in a block of its own, until it does or has been asked enough', async () => {
  const mailbox = new GuestMailbox(realMeetingTimers)
  const sessions = new GuestMcpSessions()
  sessions.wakeUrl = (key) => `http://127.0.0.1:1/meeting-wake/${key}`
  const claude = await mcpClient(sessions, mailbox, 'claude-code')
  const joined = await claude('meeting_join', { meeting: 'K7QF' })
  const seat = mailbox.seatsOf('K7QF')[0]!
  assert.equal(joined.length, 2)
  assert.match(joined[0]!, /^Joined meeting K7QF/)
  assert.match(joined[1]!, new RegExp(`run_in_background: true.*meeting-wake/${guestWakeKey(seat)}`))
  assert.ok(!joined[1]!.includes(mailbox.serialize().match(/"tokenHash":"([0-9a-f]+)"/)![1]!))
  assert.equal((await claude('meeting_status')).length, 1, 'not on calls that do not lead to waiting')

  void mailbox.watch(seat.id)
  assert.equal((await claude('meeting_next', { wait_seconds: 1 })).length, 1, 'it is running')
  mailbox.woke(seat.id)
  assert.equal((await claude('meeting_next', { wait_seconds: 1 })).length, 2, 'it exited: asked to start it again')
  assert.equal((await claude('meeting_next', { wait_seconds: 1 })).length, 2)
  assert.equal((await claude('meeting_next', { wait_seconds: 1 })).length, 2)
  assert.equal((await claude('meeting_next', { wait_seconds: 1 })).length, 1, 'refused, perhaps, with the person asked each time: it stops asking')

  const other = await mcpClient(sessions, mailbox, 'some-other-client')
  assert.equal((await other('meeting_join', { meeting: 'K7QF', name: 'Other' })).length, 1, 'another client could not act on it')
})

function post(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; dropped: boolean }> {
  return new Promise((resolve) => {
    const call = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (response) => {
      let text = ''
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode!, text, dropped: false }))
      response.on('error', () => resolve({ status: response.statusCode!, text, dropped: true }))
    })
    call.on('error', () => resolve({ status: 0, text: '', dropped: true }))
    call.end()
  })
}

test('over HTTP: the wake-up command waits until the seat is woken, and says what to do', async () => {
  const mailbox = new GuestMailbox(clock().timers)
  const { seat } = mailbox.invite('K7QF', 'Claude Code', null)
  const server = new GuestMcpServer(mailbox, noDeps())
  const port = (await server.listen(0))!
  try {
    const path = `/meeting-wake/${guestWakeKey(seat)}`
    const waiting = post(port, path)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(mailbox.watching(seat.id), true)
    mailbox.woke(seat.id)
    const answer = await waiting
    assert.equal(answer.status, 200)
    assert.match(answer.text, /Meeting K7QF has a message for you\. Call meeting_next/)

    assert.equal((await post(port, `/meeting-wake/${'0'.repeat(32)}`)).status, 404)
    assert.equal((await post(port, path, { origin: 'https://evil.example' })).status, 403, 'a web page cannot reach it')
    const notPost = await new Promise<number>((resolve) => { request({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => { response.resume(); resolve(response.statusCode!) }).end() })
    assert.equal(notPost, 405)

    // A desktop going away drops the connection without an answer, so the command connects again and the agent sleeps on.
    const dropped = post(port, path)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await server.close()
    const result = await dropped
    assert.equal(result.dropped, true)
    assert.equal(result.text, '')
  } finally { await server.close() }
})

test('over HTTP: a command the agent stopped no longer counts as a way to wake it', async () => {
  const mailbox = new GuestMailbox(clock().timers)
  const { seat } = mailbox.invite('K7QF', 'Claude Code', null)
  const server = new GuestMcpServer(mailbox, noDeps())
  const port = (await server.listen(0))!
  try {
    const call = request({ host: '127.0.0.1', port, path: `/meeting-wake/${guestWakeKey(seat)}`, method: 'POST' })
    call.on('error', () => {})
    call.end()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(mailbox.watching(seat.id), true)
    call.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(mailbox.watching(seat.id), false)
  } finally { await server.close() }
})
