// Manual proof, with real agents and paid model calls: does a review meeting reach an outside agent after its turn ended?
// The real app, built from this tree, on its own port and data; real Codex and Claude Code in terminals, one hosting and one
// reviewing. "The person" tells each to end its turn whenever it has nothing to do, as it may. When the meeting stands still for
// five minutes, this script types a nudge as the person would have to. The result is how many nudges closing the meeting took.
//
//   npm run build
//   node scripts/guest-wake-real-check.mjs --label new --host codex --port 47392 --out D:\proof
//
// Run it from a copy of the same script in an older tree to compare. --out must be on a plain drive: the agents read and write
// there, and a packaged session redirects AppData. Windows only. Needs both agents signed in; agent settings files are not
// touched. Claude Code is allowed curl.exe up front, so this does not exercise its permission question.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.versions.electron) {
  const { app } = await import('electron')
  app.setPath('userData', process.env.DESKTOP_WAKE_CHECK_DATA)
  // Out of the person's way: this runs for a long time on their own screen.
  app.on('browser-window-created', (_event, window) => window.once('ready-to-show', () => window.minimize()))
  await import('../dist/src/main/main.js')
} else {
  await proof()
}

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

async function proof() {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const label = option('label', 'run')
  const hostAgent = option('host', 'codex')
  assert.ok(hostAgent === 'codex' || hostAgent === 'claude', '--host codex or --host claude')
  const reviewerAgent = hostAgent === 'codex' ? 'claude' : 'codex'
  const port = Number(option('port', '47392'))
  assert.notEqual(port, 47391, 'that is the port of the desktop the person uses')
  const stallMs = Number(option('stall-minutes', '5')) * 60_000
  const claudeModel = option('claude-model', 'sonnet')
  const out = join(option('out', 'D:\\copilot-wake-proof'), `${label}-${hostAgent}-host`)
  assert.ok(!out.toLowerCase().includes('appdata'), '--out must be on a plain drive')
  mkdirSync(out, { recursive: true })
  const data = join(out, 'desktop')
  const started = Date.now()
  const say = (text) => { const line = `${new Date().toISOString().slice(11, 19)} ${text}`; console.log(line); appendFileSync(join(out, 'run.log'), `${line}\n`) }
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import(pathToFileURL(join(repo, 'dist/src/main/desktop-config.js')).href)
  const pty = createRequire(join(repo, 'package.json'))('node-pty')
  mkdirSync(data, { recursive: true })
  const appWork = join(out, 'app-project')
  mkdirSync(appWork, { recursive: true })
  const profile = Object.assign(createWorkspaceProfile(appWork, 'read-only'), { name: 'Wake check', tabs: [] })
  await writeDesktopConfig(join(data, 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id, closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false, provider: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'none', offline: true } })

  const electron = createRequire(join(repo, 'package.json'))('electron')
  const appEnv = { ...process.env, DESKTOP_WAKE_CHECK_DATA: data, COPILOT_DESKTOP_MEETING_MCP_PORT: String(port), COPILOT_HOME: join(data, 'copilot-home'), COPILOT_OFFLINE: 'true' }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const desktop = spawn(electron, [fileURLToPath(import.meta.url)], { env: appEnv, stdio: 'ignore' })
  const children = [desktop]
  say(`app from ${repo}, port ${port}, data ${data}`)
  for (let index = 0; ; index++) {
    const ready = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' }).then((answer) => answer.ok, () => false)
    if (ready) break
    assert.ok(index < 120, 'the desktop did not open its meeting tools')
    await delay(1000)
  }

  const agentEnv = { ...process.env }
  for (const name of Object.keys(agentEnv)) if (/^(CLAUDE|ANTHROPIC_)/.test(name)) delete agentEnv[name]
  const codexPath = () => {
    const location = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage OpenAI.Codex).InstallLocation'], { encoding: 'utf8' }).trim()
    return location ? join(location, 'app', 'resources', 'codex.exe') : 'codex'
  }
  const claudePath = () => execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).find((line) => /\.(cmd|exe)$/i.test(line.trim())).trim()
  const mcpUrl = `http://127.0.0.1:${port}/mcp`

  function terminal(name, file, args, cwd) {
    const log = join(out, `${name}.terminal.log`)
    const term = pty.spawn(file, args, { name: 'xterm-256color', cols: 160, rows: 50, cwd, env: agentEnv })
    term.onData((text) => appendFileSync(log, text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')))
    children.push({ kill: () => term.kill() })
    return { type: async (text) => { term.write(text); await delay(1000); term.write('\r') }, enter: () => term.write('\r') }
  }

  /** Says something to an agent. A terminal still busy with its long input can swallow the Enter, and another one does no harm. */
  async function tell(party, text) {
    const before = party.events().length
    await party.type(text)
    for (let index = 0; index < 8 && party.events().length === before; index++) {
      await delay(10_000)
      if (party.events().length === before) party.enter()
    }
  }

  function startClaude(name) {
    const cwd = join(out, `${name}-project`)
    mkdirSync(cwd, { recursive: true })
    const session = randomUUID()
    const config = join(out, `${name}-mcp.json`)
    writeFileSync(config, JSON.stringify({ mcpServers: { 'copilot-meeting': { type: 'http', url: mcpUrl } } }))
    const term = terminal(name, claudePath(), ['--session-id', session, '--model', claudeModel, '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__copilot-meeting__*', 'Bash(curl.exe:*)'], cwd)
    const transcript = join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`)
    return {
      name, agent: 'claude', ...term,
      // The trust question for this new folder: its first answer is yes.
      ready: async () => { await delay(10_000); await term.type(''); await delay(6000) },
      events: () => claudeEvents(transcript, name),
    }
  }

  function startCodex(name) {
    const cwd = join(out, `${name}-project`)
    mkdirSync(cwd, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd })
    const trust = `projects.${cwd.toLowerCase()}.trust_level="trusted"`
    const term = terminal(name, codexPath(), ['-c', `mcp_servers.copilot-meeting.url="${mcpUrl}"`, '-c', 'mcp_servers.copilot-meeting.default_tools_approval_mode="approve"', '-c', 'model_reasoning_effort="low"', '-c', trust, '-a', 'never', '-s', 'workspace-write'], cwd)
    let rollout = null
    return {
      name, agent: 'codex', ...term,
      ready: () => delay(12_000),
      events: () => { rollout ??= findRollout(cwd, started); return rollout ? codexEvents(rollout, name) : [] },
    }
  }

  const start = (agent, name) => agent === 'codex' ? startCodex(name) : startClaude(name)
  const host = start(hostAgent, 'host')
  const reviewer = start(reviewerAgent, 'reviewer')
  const meetingsFolder = join(data, 'meetings')
  const meetingState = () => {
    if (!existsSync(meetingsFolder)) return null
    for (const id of readdirSync(meetingsFolder)) {
      const state = join(meetingsFolder, id, 'meeting.json')
      if (existsSync(state)) { try { return { id, ...JSON.parse(readFileSync(state, 'utf8')) } } catch { /* Being written. */ } }
    }
    return null
  }
  const turnEnds = (party) => party.events().filter((event) => event.kind === 'turn ended').length
  const until = async (test, label, ms) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { const value = test(); if (value) return value; await delay(2000) }
    throw new Error(`Timed out: ${label}`)
  }

  const nudges = []
  try {
    await host.ready()
    await tell(host, 'I am testing a review meeting. With the copilot-meeting tools, call meeting_start with the topic "Retry on login" and the post "Plan: retry the login request up to 3 times with backoff. Anything wrong with this?". Then end your turn, without calling meeting_next: I am telling you to, here and whenever you have nothing to do, so do not poll meeting_next. If you are later told the meeting has a message, call meeting_next. When reviewers\' replies arrive, call meeting_propose_close listing what you agree on. When told that everyone agreed, say so and stop.')
    const meeting = await until(meetingState, 'the host started a meeting', 240_000)
    say(`meeting ${meeting.id} started by the host (${hostAgent})`)
    await until(() => turnEnds(host) >= 1, 'the host ended its first turn', 240_000)
    say('the host ended its turn')
    await reviewer.ready()
    await tell(reviewer, `I am testing a review meeting. With the copilot-meeting tools, call meeting_join with meeting "${meeting.id}", then meeting_next, and answer what it gives you with meeting_reply, in a sentence or two. Then end your turn: I am telling you to, here and whenever you have nothing to do, so do not poll meeting_next. If you are later told the meeting has a message, call meeting_next. If you are asked to vote, the plan is fine, so vote AGREE with meeting_reply.`)
    say(`the reviewer (${reviewerAgent}) was told to join`)

    let lastActivity = Date.now()
    let lastKey = ''
    const deadline = Date.now() + 60 * 60_000
    while (Date.now() < deadline) {
      const state = meetingState()
      const events = [...host.events(), ...reviewer.events()]
      const key = `${state?.stage}/${state?.round}/${events.length}`
      if (key !== lastKey) { lastKey = key; lastActivity = Date.now() }
      if (state?.stage === 'closed') { say(`the meeting closed: ${state.outcome}`); break }
      if (Date.now() - lastActivity > stallMs) {
        const stuck = state?.stage === 'reviewing' ? reviewer : host
        nudges.push({ at: new Date().toISOString(), who: stuck.name, stage: state?.stage })
        say(`STALL: nothing happened for ${stallMs / 60_000} minutes at stage ${state?.stage}; nudging the ${stuck.name} as the person would have to`)
        await tell(stuck, 'Call meeting_next and answer what it gives you. Then end your turn again.')
        lastActivity = Date.now()
        assert.ok(nudges.length <= 6, 'the meeting does not close even with nudges')
      }
      await delay(5000)
    }
    // A host learns the outcome from one more message, which it should get without being asked.
    await delay(120_000)
  } catch (error) {
    say(`FAILED: ${error?.stack ?? error}`)
    process.exitCode = 1
  } finally {
    // Whatever goes wrong while reporting, nothing this run started stays behind.
    process.once('exit', () => { for (const child of children) { try { child.kill() } catch { /* Gone already. */ } } })
    const appLog = join(data, 'logs', 'app.log')
    const log = (existsSync(appLog) ? readFileSync(appLog, 'utf8') : '').split(/\r?\n/).filter((line) => /Meeting [0-9A-Z]{4}:|wake|Could not/.test(line))
    const state = meetingState()
    const timeline = [...host.events(), ...reviewer.events()].sort((a, b) => a.t.localeCompare(b.t))
    const closed = state?.stage === 'closed'
    const report = [
      `# ${label}: ${hostAgent} hosts, ${reviewerAgent} reviews`,
      '',
      `Code: ${repo} (${execFileSync('git', ['describe', '--always', '--dirty'], { cwd: repo, encoding: 'utf8' }).trim()})`,
      `Result: ${closed ? `closed (${state.outcome})` : `NOT closed, stage ${state?.stage}`} after ${Math.round((Date.now() - started) / 60_000)} minutes, with ${nudges.length} nudge(s) from the person`,
      '',
      '## Nudges',
      ...(nudges.length ? nudges.map((nudge) => `- ${nudge.at.slice(11, 19)} ${nudge.who}, stage ${nudge.stage}`) : ['- none']),
      '',
      '## Desktop log',
      ...(log.length ? log.map((line) => `- ${line}`) : ['- nothing about meetings']),
      '',
      '## Timeline (from the agents\' own logs)',
      ...timeline.map((event) => `- ${event.t.slice(11, 19)} ${event.who}: ${event.kind}${event.detail ? ` ${event.detail}` : ''}`),
    ].join('\n')
    writeFileSync(join(out, 'report.md'), `${report}\n`)
    writeFileSync(join(out, 'transcript.md'), state ? readFileSync(join(meetingsFolder, state.id, 'transcript.md'), 'utf8') : '')
    console.log(`\n${report}\n`)
    for (const child of children) { try { child.kill() } catch { /* Gone already. */ } }
    process.exitCode = closed && nudges.length === 0 && !process.exitCode ? 0 : 1
    setTimeout(() => process.exit(), 5000)
  }
}

function jsonLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => { if (!line.trim()) return []; try { return [JSON.parse(line)] } catch { return [] } })
}

function claudeEvents(path, who) {
  return jsonLines(path).flatMap((entry) => {
    if (entry.type === 'system' && entry.subtype === 'turn_duration') return [{ t: entry.timestamp, who, kind: 'turn ended' }]
    const content = entry.message?.content
    if (entry.type === 'user' && typeof content === 'string' && content.includes('<task-notification>')) return [{ t: entry.timestamp, who, kind: 'WOKEN by its background command' }]
    if (entry.type === 'assistant' && Array.isArray(content)) {
      return content.flatMap((block) => {
        if (block.type !== 'tool_use') return []
        if (/meeting_/.test(block.name)) return [{ t: entry.timestamp, who, kind: 'called', detail: block.name.replace(/^.*__/, '') }]
        if (block.name === 'Bash' && /meeting-wake/.test(block.input?.command ?? '')) return [{ t: entry.timestamp, who, kind: 'started its wake-up command', detail: block.input.run_in_background ? '(background)' : '(NOT in the background)' }]
        return []
      })
    }
    return []
  })
}

function findRollout(cwd, since) {
  const root = join(homedir(), '.codex', 'sessions')
  const files = []
  const walk = (folder, depth) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      const info = statSync(path)
      if (info.isDirectory()) { if (depth < 3) walk(path, depth + 1) }
      else if (name.endsWith('.jsonl') && info.mtimeMs >= since) files.push(path)
    }
  }
  walk(root, 0)
  const wanted = cwd.toLowerCase()
  return files.find((path) => readFileSync(path, 'utf8').split('\n', 1)[0].toLowerCase().includes(JSON.stringify(wanted).slice(1, -1))) ?? null
}

function codexEvents(path, who) {
  return jsonLines(path).flatMap((entry) => {
    const payload = entry.payload ?? {}
    if (payload.type === 'task_complete') return [{ t: entry.timestamp, who, kind: 'turn ended' }]
    if (payload.type === 'task_started') {
      const trigger = payload.turn_attribution?.turn_trigger
      return [{ t: entry.timestamp, who, kind: trigger === 'queue' ? 'WOKEN by codex queue' : 'turn started', detail: trigger === 'queue' ? '' : `(${trigger})` }]
    }
    if (payload.type === 'item_completed' && payload.item?.type === 'McpToolCall' && /meeting/.test(payload.item.server ?? '')) return [{ t: entry.timestamp, who, kind: 'called', detail: payload.item.tool }]
    return []
  })
}
