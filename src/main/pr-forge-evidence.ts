import { createHash } from 'node:crypto'
import type { GitRunner } from './git-runner.js'
import { sessionCliLabel, type ReviewerCli } from './session-cli.js'
import { githubCliApi } from './workflow-github.js'

const SHA_RE = /^[0-9a-f]{40,64}$/i
const WORDING_RE = /\b(approved?|lgtm|looks good to me)\b/i
const NEGATED_APPROVAL_RE = /\b(not|n't|cannot|can't|no longer|never)\s+(yet\s+)?approv/i
const REVIEWED_BASE_RE = /\bReviewed base:\s*([0-9a-f]{40,64})\b/i

export interface ForgeEvidenceItem {
  kind: 'review' | 'inline' | 'issue'
  id: number
  state?: string
  user: string
  userId: string | number | null
  body: string
  commitId: string | null
  createdAtMs: number | null
}

export interface ForgePullEvidenceSnapshot {
  forge: 'github' | 'gitea' | 'gitlab'
  open: boolean
  merged: boolean
  head: string
  base: string
  sameRepo: boolean
  actorId: string | number | null
  actorLogin: string | null
  items: ForgeEvidenceItem[]
}

export interface ParsedForgeEndpoint {
  forge: 'github' | 'gitea' | 'gitlab'
  httpOrigin: string
  host: string
  hostname: string
  protocol: 'https' | 'http'
  repoPath: string
  prNumber: number
}

function parseRemoteOrigin(rawOrigin: string): {
  scheme: string
  host: string
  hostname: string
  repoPath: string
} | null {
  const raw = rawOrigin.trim()
  if (!raw) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (!parsed.hostname) return null
      const repoPath = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
      if (!repoPath.includes('/')) return null
      return {
        scheme: parsed.protocol.replace(/:$/, '').toLowerCase(),
        host: parsed.host.toLowerCase(),
        hostname: parsed.hostname.toLowerCase(),
        repoPath,
      }
    } catch {
      return null
    }
  }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(raw)
  if (scp && !/^[A-Za-z]:[\\/]/.test(raw)) {
    const repoPath = scp[2]!.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
    if (!repoPath.includes('/')) return null
    return {
      scheme: 'ssh',
      host: scp[1]!.toLowerCase(),
      hostname: scp[1]!.toLowerCase(),
      repoPath,
    }
  }
  return null
}

export function resolveTrustedForgeEndpoint(options: {
  origin: string
  prNumber: number | null
  prUrl: string | null
  allowHttpOrigin?: string | null
}): ParsedForgeEndpoint | null {
  const parsedOrigin = parseRemoteOrigin(options.origin)
  let parsedUrl: URL | null = null
  if (options.prUrl) {
    try {
      parsedUrl = new URL(options.prUrl)
    } catch {
      return null
    }
    if ((parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') || parsedUrl.username || parsedUrl.password) {
      return null
    }
    if (parsedOrigin && parsedOrigin.hostname !== parsedUrl.hostname.toLowerCase()) {
      return null
    }
    if (parsedOrigin && (parsedOrigin.scheme === 'http' || parsedOrigin.scheme === 'https') && parsedOrigin.host !== parsedUrl.host.toLowerCase()) {
      return null
    }
  }

  // Local filesystem bare origins used in offline tests have neither parsedOrigin nor matching host if no prUrl:
  if (!parsedOrigin && !parsedUrl) return null
  if (options.prNumber === null || !Number.isSafeInteger(options.prNumber) || options.prNumber < 1) return null

  const httpOrigin = parsedUrl
    ? parsedUrl.origin.toLowerCase()
    : parsedOrigin!.scheme === 'http' || parsedOrigin!.scheme === 'https'
      ? `${parsedOrigin!.scheme}://${parsedOrigin!.host}`
      : `https://${parsedOrigin!.host}`

  if (httpOrigin.startsWith('http://')) {
    const originIsSameHttp = parsedOrigin?.scheme === 'http' && `http://${parsedOrigin.host}` === httpOrigin
    const explicitAllowed = options.allowHttpOrigin?.trim().replace(/\/+$/, '').toLowerCase() === httpOrigin
    if (!originIsSameHttp && !explicitAllowed) {
      return null
    }
  }

  const hostname = parsedUrl?.hostname.toLowerCase() ?? parsedOrigin!.hostname
  const host = parsedUrl?.host.toLowerCase() ?? parsedOrigin!.host
  if (
    hostname === 'bitbucket.org'
    || hostname === 'dev.azure.com'
    || hostname.endsWith('.visualstudio.com')
  ) {
    return null
  }
  const pathStr = parsedUrl?.pathname ?? ''
  const forge: 'github' | 'gitea' | 'gitlab' = /\/merge_requests\//i.test(pathStr)
    ? 'gitlab'
    : hostname === 'github.com'
      ? 'github'
      : 'gitea'

  let repoPath = parsedOrigin?.repoPath ?? ''
  if (!repoPath && parsedUrl) {
    const segs = parsedUrl.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
    const mrIdx = segs.findIndex((s) => s.toLowerCase() === 'merge_requests')
    const prIdx = segs.findIndex((s) => /^(?:pulls?|pull-requests|pullrequest)$/i.test(s))
    if (mrIdx >= 2) repoPath = segs.slice(0, segs[mrIdx - 1] === '-' ? mrIdx - 1 : mrIdx).join('/')
    else if (prIdx >= 1) repoPath = segs.slice(0, prIdx).filter((s) => s !== '_git').join('/')
  }
  if (!repoPath) return null

  return {
    forge,
    httpOrigin,
    host,
    hostname,
    protocol: httpOrigin.startsWith('http://') ? 'http' : 'https',
    repoPath,
    prNumber: options.prNumber,
  }
}

async function readCredentialsViaGit(
  runner: GitRunner | null,
  cwd: string,
  endpoint: ParsedForgeEndpoint,
): Promise<Record<string, string>> {
  if (endpoint.forge === 'gitea') {
    const tok = process.env.GITEA_TOKEN || process.env.FORGEJO_TOKEN
    if (tok?.trim()) return { authorization: `token ${tok.trim()}` }
  }
  if (endpoint.forge === 'gitlab') {
    const tok = process.env.GITLAB_TOKEN
    if (tok?.trim()) return { 'private-token': tok.trim() }
  }
  if (!runner) return {}
  // Note: GitRunner does not pass stdin, so use child_process execFile directly with GIT_TERMINAL_PROMPT=0!
  const { execFile } = await import('node:child_process')
  const credOut = await new Promise<string>((resolveOut) => {
    const child = execFile(
      'git',
      ['credential', 'fill'],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        windowsHide: true,
        timeout: 8_000,
      },
      (err, stdout) => resolveOut(err ? '' : String(stdout)),
    )
    child.stdin?.end(`protocol=${endpoint.protocol}\nhost=${endpoint.host}\n\n`)
  })
  if (!credOut) return {}
  const fields = new Map<string, string>()
  for (const line of credOut.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const username = fields.get('username') ?? ''
  const password = fields.get('password') ?? ''
  if (!password) return {}
  if (endpoint.forge === 'gitlab' && (!username || username === 'oauth2')) {
    return { 'private-token': password }
  }
  return username
    ? { authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` }
    : { authorization: `token ${password}` }
}

async function safeForgeGetJson(httpOrigin: string, apiPath: string, authHeaders: Record<string, string>): Promise<unknown> {
  const url = new URL(apiPath, `${httpOrigin}/`)
  if (url.origin.toLowerCase() !== httpOrigin.toLowerCase()) {
    throw new Error('Forge path escaped configured origin')
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...authHeaders },
    redirect: 'manual',
    signal: AbortSignal.timeout(25_000),
  })
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Refusing HTTP ${res.status} redirect from ${httpOrigin}`)
  }
  if (!res.ok) {
    throw new Error(`Forge GET ${url.pathname} failed (${res.status})`)
  }
  const text = await res.text()
  return text.trim() ? JSON.parse(text) : null
}

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

export async function fetchForgePullEvidence(options: {
  endpoint: ParsedForgeEndpoint
  userDataDir: string
  projectCwd: string
  runner: GitRunner | null
}): Promise<ForgePullEvidenceSnapshot> {
  const { endpoint, userDataDir, projectCwd, runner } = options

  // Optional deterministic test override hook for local offline Electron E2E runs (`COPILOT_DESKTOP_TEST_FORGE_EVIDENCE_FILE`).
  const testEvidenceFile = process.env.COPILOT_DESKTOP_TEST_FORGE_EVIDENCE_FILE
  if (testEvidenceFile) {
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(testEvidenceFile, 'utf8')) as ForgePullEvidenceSnapshot
    return raw
  }

  if (endpoint.forge === 'github' && endpoint.hostname === 'github.com') {
    const api = await githubCliApi(userDataDir)
    const root = `repos/${endpoint.repoPath}/pulls/${endpoint.prNumber}`
    const [pullRaw, meRaw, reviewsRaw, inlineRaw, issueRaw] = await Promise.all([
      api(root) as Promise<Record<string, unknown>>,
      api('user').catch(() => null) as Promise<{ id?: number; login?: string } | null>,
      api(`${root}/reviews?per_page=100`, true) as Promise<unknown[]>,
      api(`${root}/comments?per_page=100`, true) as Promise<unknown[]>,
      api(`repos/${endpoint.repoPath}/issues/${endpoint.prNumber}/comments?per_page=100`, true) as Promise<unknown[]>,
    ])
    const headObj = (pullRaw.head ?? {}) as { sha?: string; repo?: { id?: number } | null }
    const baseObj = (pullRaw.base ?? {}) as { sha?: string; repo?: { id?: number } | null }
    const items: ForgeEvidenceItem[] = []
    for (const r of Array.isArray(reviewsRaw) ? reviewsRaw : []) {
      const rec = r as Record<string, unknown>
      const user = (rec.user ?? {}) as { id?: number; login?: string }
      items.push({
        kind: 'review',
        id: Number(rec.id),
        state: typeof rec.state === 'string' ? rec.state.toUpperCase() : 'COMMENTED',
        user: user.login ?? '',
        userId: user.id ?? null,
        body: typeof rec.body === 'string' ? rec.body : '',
        commitId: typeof rec.commit_id === 'string' ? rec.commit_id.toLowerCase() : null,
        createdAtMs: parseTimestampMs(rec.submitted_at),
      })
    }
    for (const c of Array.isArray(inlineRaw) ? inlineRaw : []) {
      const rec = c as Record<string, unknown>
      const user = (rec.user ?? {}) as { id?: number; login?: string }
      items.push({
        kind: 'inline',
        id: Number(rec.id),
        user: user.login ?? '',
        userId: user.id ?? null,
        body: typeof rec.body === 'string' ? rec.body : '',
        commitId: typeof rec.original_commit_id === 'string' ? rec.original_commit_id.toLowerCase() : null,
        createdAtMs: parseTimestampMs(rec.updated_at ?? rec.created_at),
      })
    }
    for (const c of Array.isArray(issueRaw) ? issueRaw : []) {
      const rec = c as Record<string, unknown>
      const user = (rec.user ?? {}) as { id?: number; login?: string }
      items.push({
        kind: 'issue',
        id: Number(rec.id),
        user: user.login ?? '',
        userId: user.id ?? null,
        body: typeof rec.body === 'string' ? rec.body : '',
        commitId: null,
        createdAtMs: parseTimestampMs(rec.updated_at ?? rec.created_at),
      })
    }
    return {
      forge: 'github',
      open: pullRaw.state === 'open' && !pullRaw.merged,
      merged: Boolean(pullRaw.merged),
      head: String(headObj.sha ?? '').toLowerCase(),
      base: String(baseObj.sha ?? '').toLowerCase(),
      sameRepo: Number.isSafeInteger(baseObj.repo?.id) && baseObj.repo?.id === headObj.repo?.id,
      actorId: meRaw?.id ?? null,
      actorLogin: meRaw?.login ?? null,
      items,
    }
  }

  const authHeaders = await readCredentialsViaGit(runner, projectCwd, endpoint)
  if (endpoint.forge === 'gitea') {
    const repoApi = `/api/v1/repos/${endpoint.repoPath}`
    const [pullRaw, meRaw, reviewsRaw, inlineRaw, issueRaw] = await Promise.all([
      safeForgeGetJson(endpoint.httpOrigin, `${repoApi}/pulls/${endpoint.prNumber}`, authHeaders) as Promise<Record<string, unknown>>,
      safeForgeGetJson(endpoint.httpOrigin, '/api/v1/user', authHeaders).catch(() => null) as Promise<{ id?: number; login?: string } | null>,
      safeForgeGetJson(endpoint.httpOrigin, `${repoApi}/pulls/${endpoint.prNumber}/reviews?limit=50`, authHeaders).catch(() => []) as Promise<unknown[]>,
      safeForgeGetJson(endpoint.httpOrigin, `${repoApi}/pulls/${endpoint.prNumber}/comments?limit=50`, authHeaders).catch(() => []) as Promise<unknown[]>,
      safeForgeGetJson(endpoint.httpOrigin, `${repoApi}/issues/${endpoint.prNumber}/comments?limit=50`, authHeaders).catch(() => []) as Promise<unknown[]>,
    ])
    const headObj = (pullRaw.head ?? {}) as { sha?: string; repo?: { id?: number } | null }
    const baseObj = (pullRaw.base ?? {}) as { sha?: string; repo?: { id?: number } | null }
    const items: ForgeEvidenceItem[] = []
    for (const r of Array.isArray(reviewsRaw) ? reviewsRaw : []) {
      const rec = r as Record<string, unknown>
      const user = (rec.user ?? {}) as { id?: number; login?: string }
      const rawState = String(rec.state ?? '').toUpperCase()
      items.push({
        kind: 'review',
        id: Number(rec.id),
        state: rawState === 'APPROVED' ? 'APPROVED' : rawState === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED',
        user: user.login ?? '',
        userId: user.id ?? null,
        body: typeof rec.body === 'string' ? rec.body : '',
        commitId: typeof rec.commit_id === 'string' ? rec.commit_id.toLowerCase() : null,
        createdAtMs: parseTimestampMs(rec.updated_at ?? rec.submitted_at),
      })
    }
    for (const c of Array.isArray(inlineRaw) ? inlineRaw : []) {
      const rec = c as Record<string, unknown>
      const user = (rec.user ?? {}) as { id?: number; login?: string }
      items.push({
        kind: 'inline',
        id: Number(rec.id),
        user: user.login ?? '',
        userId: user.id ?? null,
        body: typeof rec.body === 'string' ? rec.body : '',
        commitId: typeof rec.original_commit_id === 'string'
          ? rec.original_commit_id.toLowerCase()
          : typeof rec.commit_id === 'string'
            ? rec.commit_id.toLowerCase()
            : null,
        createdAtMs: parseTimestampMs(rec.updated_at ?? rec.created_at),
      })
    }
    for (const c of Array.isArray(issueRaw) ? issueRaw : []) {
      const rec = c as Record<string, unknown>
      const user = (rec.user ?? {}) as { id?: number; login?: string }
      items.push({
        kind: 'issue',
        id: Number(rec.id),
        user: user.login ?? '',
        userId: user.id ?? null,
        body: typeof rec.body === 'string' ? rec.body : '',
        commitId: null,
        createdAtMs: parseTimestampMs(rec.updated_at ?? rec.created_at),
      })
    }
    return {
      forge: 'gitea',
      open: String(pullRaw.state ?? '').toLowerCase() === 'open' && !pullRaw.merged,
      merged: Boolean(pullRaw.merged),
      head: String(headObj.sha ?? '').toLowerCase(),
      base: String(baseObj.sha ?? '').toLowerCase(),
      sameRepo: Number.isSafeInteger(baseObj.repo?.id) && baseObj.repo?.id === headObj.repo?.id,
      actorId: meRaw?.id ?? null,
      actorLogin: meRaw?.login ?? null,
      items,
    }
  }

  // GitLab REST v4
  const encodedProject = encodeURIComponent(endpoint.repoPath)
  const mrApi = `/api/v4/projects/${encodedProject}/merge_requests/${endpoint.prNumber}`
  const [mrRaw, meRaw, notesRaw] = await Promise.all([
    safeForgeGetJson(endpoint.httpOrigin, mrApi, authHeaders) as Promise<Record<string, unknown>>,
    safeForgeGetJson(endpoint.httpOrigin, '/api/v4/user', authHeaders).catch(() => null) as Promise<{ id?: number; username?: string } | null>,
    safeForgeGetJson(endpoint.httpOrigin, `${mrApi}/notes?per_page=100`, authHeaders).catch(() => []) as Promise<unknown[]>,
  ])
  const diffRefs = (mrRaw.diff_refs ?? {}) as { head_sha?: string; base_sha?: string }
  const items: ForgeEvidenceItem[] = []
  for (const n of Array.isArray(notesRaw) ? notesRaw : []) {
    const rec = n as Record<string, unknown>
    if (rec.system) continue
    const author = (rec.author ?? {}) as { id?: number; username?: string }
    const pos = (rec.position ?? null) as { new_path?: string; head_sha?: string } | null
    items.push({
      kind: pos?.new_path ? 'inline' : 'issue',
      id: Number(rec.id),
      user: author.username ?? '',
      userId: author.id ?? null,
      body: typeof rec.body === 'string' ? rec.body : '',
      commitId: typeof pos?.head_sha === 'string' ? pos.head_sha.toLowerCase() : null,
      createdAtMs: parseTimestampMs(rec.updated_at ?? rec.created_at),
    })
  }
  const mrState = String(mrRaw.state ?? '').toLowerCase()
  return {
    forge: 'gitlab',
    open: mrState === 'opened',
    merged: mrState === 'merged',
    head: String(diffRefs.head_sha ?? mrRaw.sha ?? '').toLowerCase(),
    base: String(diffRefs.base_sha ?? '').toLowerCase(),
    sameRepo: Number.isSafeInteger(mrRaw.target_project_id) && mrRaw.target_project_id === mrRaw.source_project_id,
    actorId: meRaw?.id ?? null,
    actorLogin: meRaw?.username ?? null,
    items,
  }
}

export function isItemExplicitApproval(item: ForgeEvidenceItem, head: string, base: string, baseMovedInGroup: boolean): boolean {
  if (!SHA_RE.test(head) || !SHA_RE.test(base)) return false
  const raw = item.body.trim()
  const unquoted = raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()

  const baseMatch = REVIEWED_BASE_RE.exec(unquoted)
  if (baseMatch && baseMatch[1]!.toLowerCase() !== base.toLowerCase()) return false

  if (item.kind === 'review' && item.state === 'APPROVED' && item.commitId === head.toLowerCase()) {
    if (baseMovedInGroup && (!baseMatch || baseMatch[1]!.toLowerCase() !== base.toLowerCase())) return false
    return true
  }

  if (!unquoted || NEGATED_APPROVAL_RE.test(unquoted) || !WORDING_RE.test(unquoted)) return false
  const namesHead = (unquoted.match(/\b[0-9a-f]{40,64}\b/gi) ?? []).some((tok) => tok.toLowerCase() === head.toLowerCase())
  if (!namesHead) return false
  if (baseMovedInGroup && (!baseMatch || baseMatch[1]!.toLowerCase() !== base.toLowerCase())) return false
  return true
}

export function verifySeatOutcomeFromSnapshot(options: {
  snapshot: ForgePullEvidenceSnapshot
  cli: ReviewerCli
  totalRequiredSeats: number
  head: string
  base: string
  baseMovedInGroup: boolean
  roundStartedAtMs: number
  marker: string
  claimedEvidenceKeys: ReadonlySet<string>
  receipt?: { kind: 'approved' | 'findings'; remoteId: number; itemType?: string } | null
}): { verdict: 'approved' | 'findings'; claimedKeys: string[] } | null {
  const {
    snapshot,
    cli,
    totalRequiredSeats,
    head,
    base,
    baseMovedInGroup,
    roundStartedAtMs,
    marker,
    claimedEvidenceKeys,
    receipt,
  } = options

  const tag = `[${sessionCliLabel(cli)}]`
  const isExpectedAccount = (item: ForgeEvidenceItem): boolean => {
    if (item.body.startsWith(marker)) return false
    if (snapshot.actorId === null && !snapshot.actorLogin) return true
    if (snapshot.actorId !== null && item.userId !== null && String(item.userId) === String(snapshot.actorId)) return true
    if (snapshot.actorLogin && item.user.toLowerCase() === snapshot.actorLogin.toLowerCase()) return true
    return false
  }

  const keyOf = (item: ForgeEvidenceItem): string => `${item.kind}:${item.id}`
  const eligible = snapshot.items.filter((item) => {
    const key = keyOf(item)
    if (claimedEvidenceKeys.has(key)) return false
    if (!isExpectedAccount(item)) return false
    if (item.kind === 'review' && item.state === 'COMMENTED' && item.body.trim() === '') return false
    if (item.commitId !== null && item.commitId !== head.toLowerCase()) return false
    if (item.createdAtMs !== null && item.createdAtMs + 5_000 < roundStartedAtMs) return false
    if (receipt && item.id === receipt.remoteId && (!receipt.itemType || receipt.itemType === 'any' || receipt.itemType === item.kind)) {
      return true
    }
    if (totalRequiredSeats > 1 && !item.body.includes(tag)) return false
    return true
  })

  if (eligible.length === 0) return null

  const approvalItem = eligible.find((item) => {
    if (!isItemExplicitApproval(item, head, base, baseMovedInGroup)) return false
    if (totalRequiredSeats > 1 && !item.body.includes(tag)) return false
    return true
  })
  const findingItems = eligible.filter((item) => item !== approvalItem && !isItemExplicitApproval(item, head, base, baseMovedInGroup))

  // Never count as approved if this seat also posted open findings in the same round!
  if (approvalItem && findingItems.length === 0 && (!receipt || receipt.kind === 'approved')) {
    return { verdict: 'approved', claimedKeys: [keyOf(approvalItem)] }
  }
  if (findingItems.length > 0) {
    return { verdict: 'findings', claimedKeys: findingItems.map(keyOf) }
  }
  return null
}

export function hashSeatReceiptToken(token: string): string {
  return createHash('sha256').update(`seat-receipt:${token}`, 'utf8').digest('hex')
}
