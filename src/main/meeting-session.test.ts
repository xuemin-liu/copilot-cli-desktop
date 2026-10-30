import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MeetingControlServer, prepareMeetingSessionEnvironment, pruneMeetingFolders, writeMeetingFile, type MeetingCommand, type MeetingRequest } from './meeting-session.js'
import { shareablePatch } from './meeting-messages.js'

function post(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePost, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolvePost({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

test('the meeting endpoint knows each session by its own token and turns away everything else', async () => {
  const calls: Array<{ tabId: string; command: MeetingCommand; request: MeetingRequest }> = []
  const server = new MeetingControlServer((tabId, command, request) => { calls.push({ tabId, command, request }); return { ok: true, message: `${command} by ${tabId}` } })
  try {
    const a = await server.register('tab-a')
    const b = await server.register('tab-b')
    assert.equal(a.port, b.port, 'one server for every session')
    const ok = await post(a.port, '/round', { authorization: `Bearer ${b.token}` }, JSON.stringify({ text: 'v2', changes: 'patch' }))
    assert.deepEqual(JSON.parse(ok.body), { ok: true, message: 'round by tab-b' })
    assert.deepEqual(calls[0]!.request, { topic: '', text: 'v2', changes: 'patch' })
    assert.equal((await post(a.port, '/round', { authorization: 'Bearer nope' }, '{}')).status, 401)
    assert.equal((await post(a.port, '/round', { authorization: `Bearer ${a.token}`, origin: 'http://evil.test' }, '{}')).status, 403)
    assert.equal((await post(a.port, '/delete', { authorization: `Bearer ${a.token}` }, '{}')).status, 404)
    server.forget('tab-a')
    assert.equal((await post(a.port, '/status', { authorization: `Bearer ${a.token}` }, '{}')).status, 401, 'a closed session\'s token stops working')
    assert.equal(calls.length, 1)
  } finally { await server.close() }
})

test('the meeting endpoint awaits the event-log refresh before answering a host command', async () => {
  let release!: () => void
  const refreshed = new Promise<void>(resolve => { release = resolve })
  const server = new MeetingControlServer(async () => { await refreshed; return { ok: false, message: 'no active user turn observed' } })
  try {
    const session = await server.register('tab-a')
    const answer = post(session.port, '/start', { authorization: `Bearer ${session.token}` }, '{}')
    release()
    assert.deepEqual(JSON.parse((await answer).body), { ok: false, message: 'no active user turn observed' })
  } finally { release(); await server.close() }
})

test('meeting files stay inside their meeting folder and never under .github', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-files-'))
  try {
    await writeMeetingFile(root, 'K7QF', join(root, 'K7QF', 'round-1', 'post.md'), 'plan')
    assert.equal(await readFile(join(root, 'K7QF', 'round-1', 'post.md'), 'utf8'), 'plan')
    await assert.rejects(writeMeetingFile(root, 'K7QF', join(root, 'M2NB', 'post.md'), 'x'), /stay in the meeting folder/)
    await assert.rejects(writeMeetingFile(root, 'K7QF', join(root, 'K7QF', '.github', 'agents', 'a.md'), 'x'), /stay in the meeting folder/)
    await assert.rejects(writeMeetingFile(root, '..', join(root, 'x.md'), 'x'), /Invalid meeting id/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('meeting folders older than a week are removed at startup; anything else in the folder is left alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-prune-'))
  try {
    await mkdir(join(root, 'K7QF'))
    await mkdir(join(root, 'M2NB'))
    await mkdir(join(root, 'not-a-meeting'))
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000)
    await utimes(join(root, 'K7QF'), old, old)
    await utimes(join(root, 'not-a-meeting'), old, old)
    await pruneMeetingFolders(root, Date.now())
    await assert.rejects(stat(join(root, 'K7QF')))
    await stat(join(root, 'M2NB'))
    await stat(join(root, 'not-a-meeting'))
    await pruneMeetingFolders(join(root, 'missing'), Date.now())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the helper sends the file and the uncommitted changes, and prints the desktop\'s answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-helper-'))
  const repo = join(directory, 'repo')
  const calls: Array<{ tabId: string; command: MeetingCommand; request: MeetingRequest }> = []
  const server = new MeetingControlServer((tabId, command, request) => {
    calls.push({ tabId, command, request })
    return command === 'end' ? { ok: false, message: 'This session does not host an open meeting.' } : { ok: true, message: `Meeting K7QF is open (${command}).` }
  })
  try {
    await mkdir(repo)
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'gitconfig') }
    await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' })
    git('init', '-q')
    // A repository may print paths without prefixes or with other ones; the helper must still give the desktop a/ and b/.
    git('config', 'diff.noprefix', 'true')
    git('config', 'diff.mnemonicPrefix', 'true')
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await writeFile(join(repo, 'credentials.json'), '{ "endpoint": "none" }\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    await writeFile(join(repo, 'a.txt'), 'one\ntwo ✓\n')
    await writeFile(join(repo, 'credentials.json'), '{ "endpoint": "opaque-tracked-value-94" }\n')
    await writeFile(join(repo, 'new file.txt'), 'brand new\n')
    // Values no credential pattern recognises: only withholding the whole file keeps them out.
    await writeFile(join(repo, '.env'), 'PASSWORD=hunter2-very-secret\nDATABASE_CONNECTION_STRING=Server=db;opaque-untracked-value-93\n')
    await writeFile(join(repo, 'config.txt'), 'API_KEY=sk-live-0123456789abcdef0123456789\n')
    await writeFile(join(directory, 'plan.md'), '# Plan ✓\n\n1. lock\n')
    const env = await prepareMeetingSessionEnvironment(join(directory, 'helper'), await server.register('tab-host'), { ...gitEnv, COPILOT_AGENT_SESSION_ID: '11111111-1111-4111-8111-111111111111' })
    assert.match(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS!, /helper/)
    assert.match(await readFile(join(directory, 'helper', '.github', 'instructions', 'meeting.instructions.md'), 'utf8'), /join meeting/)
    const run = (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolveRun) => {
      // Windows PowerShell runs meeting.ps1; sh runs meeting.sh on macOS and Linux.
      const [shell, ...shellArgs] = process.platform === 'win32' ? ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] : ['sh']
      execFile(shell!, [...shellArgs, env.COPILOT_DESKTOP_MEETING_HELPER!, ...args],
        { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
        (error, stdout, stderr) => resolveRun({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }))
    })
    const started = await run('start', '-Topic', 'login plan', '-File', join(directory, 'plan.md'), '-Changes')
    assert.equal(started.code, 0, started.stderr)
    assert.match(started.stdout, /Meeting K7QF is open \(start\)/)
    const { request: sent } = calls[0]!
    assert.equal(calls[0]!.tabId, 'tab-host')
    assert.equal(sent.topic, 'login plan')
    assert.equal(sent.text.replace(/\r\n/g, '\n'), '# Plan ✓\n\n1. lock\n')
    assert.equal(sent.sessionId, env.COPILOT_AGENT_SESSION_ID, 'the helper carries CLI-provided routing metadata')
    assert.match(sent.changes!, /\+two ✓/, 'tracked changes, UTF-8 intact')
    assert.match(sent.changes!, /new file\.txt/)
    assert.match(sent.changes!, /\+brand new/, 'untracked files are included as new files')
    // The helper sends what Git shows; the desktop filters it before any reviewer can read it.
    const shared = shareablePatch(sent.changes!)
    assert.match(sent.changes!, /^diff --git a\/a\.txt b\/a\.txt$/m, 'canonical prefixes despite diff.noprefix')
    assert.match(sent.changes!, /^diff --git a\/\.env b\/\.env$/m, 'untracked files too')
    assert.doesNotMatch(shared, /hunter2|opaque-untracked-value-93/, 'an untracked .env is withheld')
    assert.match(shared, /# Changes to \.env withheld/)
    assert.doesNotMatch(shared, /opaque-tracked-value-94/, 'a tracked credentials file is withheld')
    assert.match(shared, /# Changes to credentials\.json withheld/)
    assert.doesNotMatch(shared, /sk-live-0123456789abcdef/, 'a key in an ordinary file is masked')
    assert.match(shared, /\+brand new/)
    const ended = await run('end')
    assert.equal(ended.code, 1)
    assert.match(ended.stdout, /does not host an open meeting/)
    const usage = await run('round')
    assert.equal(usage.code, 1)
    assert.match(usage.stderr, /Usage: meeting\.(ps1|sh) round -File/)
    assert.equal(calls.length, 2, 'a usage error sends nothing')
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
