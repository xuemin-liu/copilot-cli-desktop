import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GitRunner } from './git-runner.js'
import { sessionCliLabel, type ReviewerCli } from './session-cli.js'
import { githubCliApi } from './workflow-github.js'

const SHA_RE = /^[0-9a-f]{40,64}$/i
const EXPLICIT_APPROVAL_FIRST_LINE_RE = /^Approved at ([0-9a-f]{40,64})(?:\b|$)/i
const REVIEWED_BASE_RE = /\bReviewed base:\s*([0-9a-f]{40,64})\b/i
const FINDING_LABEL_LINE_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#+\s+)?(?:\*\*|__|`)?(?:blocking|non-blocking|nit)(?:\*\*|__|`)?(?:\s*\[[^\]]+\])?\s*[:—–-]/im
const FINDING_BOLD_RE = /\*\*(?:blocking|non-blocking|nit)\*\*/i

export interface ForgeEvidenceItem {
  kind: 'review' | 'inline' | 'issue'
  id: number
  parentReviewId?: number
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
  forge: 'github' | 'gitea' | 'gitlab' | 'probe'
  httpOrigin: string
  host: string
  hostname: string
  protocol: 'https' | 'http'
  repoPath: string
  prNumber: number
}

const probedOriginKinds = new Map<string, 'github' | 'gitea' | 'gitlab' | 'unsupported'>()

export function clearForgeProbeCacheForTests(): void {
  probedOriginKinds.clear()
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

  // For non-HTTP(S) origins (e.g. ssh://git@host:2222/...), never carry the SSH port into HTTPS!
  const httpOrigin = parsedUrl
    ? parsedUrl.origin.toLowerCase()
    : parsedOrigin!.scheme === 'http' || parsedOrigin!.scheme === 'https'
      ? `${parsedOrigin!.scheme}://${parsedOrigin!.host}`
      : options.allowHttpOrigin && (() => {
          try { return new URL(options.allowHttpOrigin).hostname.toLowerCase() === parsedOrigin!.hostname } catch { return false }
        })()
        ? new URL(options.allowHttpOrigin!).origin.toLowerCase()
        : `https://${parsedOrigin!.hostname}`

  if (httpOrigin.startsWith('http://')) {
    const originIsSameHttp = parsedOrigin?.scheme === 'http' && `http://${parsedOrigin.host}` === httpOrigin
    const explicitAllowed = options.allowHttpOrigin?.trim().replace(/\/+$/, '').toLowerCase() === httpOrigin
    if (!originIsSameHttp && !explicitAllowed) {
      return null
    }
  }

  const hostname = parsedUrl?.hostname.toLowerCase() ?? parsedOrigin!.hostname
  const host = parsedUrl?.host.toLowerCase()
    ?? (parsedOrigin!.scheme === 'http' || parsedOrigin!.scheme === 'https' ? parsedOrigin!.host : parsedOrigin!.hostname)
  const pathStr = parsedUrl?.pathname ?? ''

  // Bitbucket (Cloud & Server/DC) and Azure DevOps (Cloud & Server) have no built-in REST poller here; return null so seat receipts apply.
  if (
    hostname === 'bitbucket.org'
    || hostname === 'dev.azure.com'
    || hostname.endsWith('.visualstudio.com')
    || /\/(?:pull-requests|pullrequest|_git)\//i.test(pathStr)
  ) {
    return null
  }

  const forge: ParsedForgeEndpoint['forge'] = /\/merge_requests\//i.test(pathStr)
    ? 'gitlab'
    : hostname === 'github.com'
      ? 'github'
      : 'probe'

  let repoPath = parsedOrigin?.repoPath ?? ''
  if (!repoPath && parsedUrl) {
    const segs = parsedUrl.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
    const mrIdx = segs.findIndex((s) => s.toLowerCase() === 'merge_requests')
    const prIdx = segs.findIndex((s) => /^(?:pulls?)$/i.test(s))
    if (mrIdx >= 2) repoPath = segs.slice(0, segs[mrIdx - 1] === '-' ? mrIdx - 1 : mrIdx).join('/')
    else if (prIdx >= 1) repoPath = segs.slice(0, prIdx).join('/')
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
  endpoint: Pick<ParsedForgeEndpoint, 'forge' | 'protocol' | 'host'>,
): Promise<Record<string, string>> {
  if (endpoint.forge === 'gitea' || endpoint.forge === 'probe') {
    const tok = process.env.GITEA_TOKEN || process.env.FORGEJO_TOKEN
    if (tok?.trim()) return { authorization: `token ${tok.trim()}` }
  }
  if (endpoint.forge === 'gitlab' || endpoint.forge === 'probe') {
    const tok = process.env.GITLAB_TOKEN
    if (tok?.trim() && endpoint.forge === 'gitlab') return { 'private-token': tok.trim() }
  }
  if (!runner) return {}
  const credOut = await new Promise<string>((resolveOut) => {
    let settled = false
    const finish = (val: string): void => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      resolveOut(val)
    }
    const child = execFile(
      'git',
      ['credential', 'fill'],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        windowsHide: true,
        timeout: 6_000,
      },
      (err, stdout) => finish(err ? '' : String(stdout)),
    )
    const hardTimer = setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      try { child.kill('SIGKILL') } catch {}
      finish('')
    }, 7_000)
    hardTimer.unref?.()
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

async function safeForgeFetchResponse(httpOrigin: string, apiPath: string, authHeaders: Record<string, string>, timeoutMs = 25_000): Promise<{ data: unknown; headers: Headers }> {
  const url = new URL(apiPath, `${httpOrigin}/`)
  if (url.origin.toLowerCase() !== httpOrigin.toLowerCase()) {
    throw new Error('Forge path escaped configured origin')
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...authHeaders },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Refusing HTTP ${res.status} redirect from ${httpOrigin}`)
  }
  if (!res.ok) {
    throw new Error(`Forge GET ${url.pathname} failed (${res.status})`)
  }
  const text = await res.text()
  return {
    data: text.trim() ? JSON.parse(text) : null,
    headers: res.headers,
  }
}

async function safeForgeGetJson(httpOrigin: string, apiPath: string, authHeaders: Record<string, string>, timeoutMs = 25_000): Promise<unknown> {
  return (await safeForgeFetchResponse(httpOrigin, apiPath, authHeaders, timeoutMs)).data
}

function parseNextPageFromHeaders(
  headers: Headers,
  httpOrigin: string,
  totalLoaded: number,
  currentPageCount: number,
  requestedPageSize: number,
): { hasMore: boolean; nextPath?: string; nextPage?: number } {
  const linkHeader = headers.get('link')
  if (linkHeader !== null) {
    const linkPattern = /<([^>]+)>([^,]*)/g
    let match: RegExpExecArray | null
    while ((match = linkPattern.exec(linkHeader)) !== null) {
      const target = match[1]!.trim()
      const params = match[2]!
      const relMatch = /;\s*rel=(?:"([^"]+)"|([^\s;]+))/i.exec(params)
      const relTokens = (relMatch?.[1] ?? relMatch?.[2] ?? '').toLowerCase().split(/\s+/)
      if (relTokens.includes('next')) {
        const parsedNext = new URL(target, `${httpOrigin}/`)
        if (parsedNext.origin.toLowerCase() !== httpOrigin.toLowerCase()) {
          throw new Error(`Refusing cross-origin pagination Link target (${parsedNext.origin}) from ${httpOrigin}`)
        }
        return { hasMore: true, nextPath: `${parsedNext.pathname}${parsedNext.search}` }
      }
    }
    return { hasMore: false }
  }
  if (headers.has('x-next-page')) {
    const rawNext = headers.get('x-next-page')?.trim() ?? ''
    if (/^[1-9]\d*$/.test(rawNext)) {
      return { hasMore: true, nextPage: Number(rawNext) }
    }
    return { hasMore: false }
  }
  if (headers.has('x-hasmore')) {
    return { hasMore: headers.get('x-hasmore')?.trim().toLowerCase() === 'true' }
  }
  if (headers.has('x-total-count')) {
    const rawTotal = headers.get('x-total-count')?.trim() ?? ''
    if (/^\d+$/.test(rawTotal)) {
      return { hasMore: totalLoaded < Number(rawTotal) }
    }
  }
  return { hasMore: currentPageCount >= requestedPageSize }
}

async function safeForgePaginateArray(
  httpOrigin: string,
  basePath: string,
  authHeaders: Record<string, string>,
  forge: 'gitea' | 'gitlab',
  maxPages = 50,
): Promise<unknown[]> {
  const results: unknown[] = []
  const requestedPageSize = forge === 'gitlab' ? 100 : 50
  let nextExplicitPath: string | undefined
  let nextPageNum = 1
  for (let pageCount = 1; ; pageCount += 1) {
    const sep = basePath.includes('?') ? '&' : '?'
    const defaultPageParam = forge === 'gitlab' ? `per_page=${requestedPageSize}&page=${nextPageNum}` : `limit=${requestedPageSize}&page=${nextPageNum}`
    const requestPath = nextExplicitPath ?? `${basePath}${sep}${defaultPageParam}`
    const { data, headers } = await safeForgeFetchResponse(httpOrigin, requestPath, authHeaders)
    if (!Array.isArray(data) || data.length === 0) break
    results.push(...data)
    const nextInfo = parseNextPageFromHeaders(headers, httpOrigin, results.length, data.length, requestedPageSize)
    if (!nextInfo.hasMore) break
    if (pageCount >= maxPages) {
      throw new Error(`Forge pagination exceeded safety cap (${maxPages} pages) on ${basePath}; refusing incomplete PR evidence`)
    }
    nextExplicitPath = nextInfo.nextPath
    nextPageNum = nextInfo.nextPage ?? (nextPageNum + 1)
  }
  return results
}

async function probeVersionEndpoint(
  httpOrigin: string,
  apiPath: string,
  authHeaders: Record<string, string>,
  timeoutMs = 6_000,
): Promise<{ status: 'matched' } | { status: 'absent' } | { status: 'error'; reason: string }> {
  let res: Response
  try {
    const url = new URL(apiPath, `${httpOrigin}/`)
    res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...authHeaders },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
  if (res.status >= 300 && res.status < 400) {
    return { status: 'error', reason: `HTTP ${res.status} redirect on ${apiPath}` }
  }
  if (res.status === 404 || res.status === 405 || res.status === 410 || res.status === 501) {
    return { status: 'absent' }
  }
  if (!res.ok) {
    return { status: 'error', reason: `HTTP ${res.status} on ${apiPath}` }
  }
  const text = await res.text().catch(() => '')
  try {
    const parsed = text.trim() ? JSON.parse(text) : null
    if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string' && (parsed as { version: string }).version.trim() !== '') {
      return { status: 'matched' }
    }
  } catch {
    // Non-JSON 200 (e.g. HTML web UI catch-all) indicates this API route is not present.
  }
  return { status: 'absent' }
}

async function probeGitHubEnterpriseEndpoint(
  httpOrigin: string,
  timeoutMs = 6_000,
): Promise<{ status: 'matched' } | { status: 'absent' } | { status: 'error'; reason: string }> {
  const token = (process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN || '').trim()
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
  let res: Response
  try {
    const url = new URL('/api/v3/meta', `${httpOrigin}/`)
    res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
  if (res.headers.has('x-github-enterprise-version') || res.headers.has('x-github-request-id')) {
    return { status: 'matched' }
  }
  if (res.status >= 300 && res.status < 400) {
    return { status: 'error', reason: `HTTP ${res.status} redirect on /api/v3/meta` }
  }
  if (res.status === 404 || res.status === 405 || res.status === 410 || res.status === 501) {
    return { status: 'absent' }
  }
  if (!res.ok) {
    return { status: 'error', reason: `HTTP ${res.status} on /api/v3/meta` }
  }
  const text = await res.text().catch(() => '')
  try {
    const parsed = text.trim() ? JSON.parse(text) : null
    if (
      parsed
      && typeof parsed === 'object'
      && ('verifiable_password_authentication' in parsed || 'installed_version' in parsed)
    ) {
      return { status: 'matched' }
    }
  } catch {
    // Non-JSON 200 (e.g. HTML catch-all) indicates this API route is not GitHub Enterprise.
  }
  return { status: 'absent' }
}

export function ghConfigMayKnowHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (
    !lower
    || lower === 'localhost'
    || lower === '127.0.0.1'
    || lower === '::1'
    || lower === '[::1]'
    || /^\d+\.\d+\.\d+\.\d+$/.test(lower)
  ) {
    return false
  }
  if (process.env.GH_HOST?.trim().toLowerCase() === lower) return true
  if (process.env.GH_ENTERPRISE_TOKEN?.trim() || process.env.GITHUB_ENTERPRISE_TOKEN?.trim()) return true
  const candidates = [
    process.env.GH_CONFIG_DIR ? join(process.env.GH_CONFIG_DIR, 'hosts.yml') : null,
    process.env.APPDATA ? join(process.env.APPDATA, 'GitHub CLI', 'hosts.yml') : null,
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'gh', 'hosts.yml') : null,
    join(homedir(), '.config', 'gh', 'hosts.yml'),
  ].filter((p): p is string => Boolean(p))
  for (const file of candidates) {
    try {
      if (existsSync(file) && readFileSync(file, 'utf8').toLowerCase().includes(lower)) {
        return true
      }
    } catch {
      // Ignore unreadable config candidate.
    }
  }
  return false
}

function checkGhEnterpriseAuth(hostname: string, protocol: 'http' | 'https' = 'https'): Promise<boolean> {
  if (protocol === 'http' || !ghConfigMayKnowHost(hostname)) {
    return Promise.resolve(false)
  }
  return new Promise((resolveAuth) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      resolveAuth(ok)
    }
    const child = execFile(
      'gh',
      ['auth', 'status', '--hostname', hostname],
      {
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
        windowsHide: true,
        timeout: 6_000,
      },
      (err) => finish(!err),
    )
    const hardTimer = setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      try { child.kill('SIGKILL') } catch {}
      finish(false)
    }, 7_000)
    hardTimer.unref?.()
    child.stdin?.end()
  })
}

function runGhEnterpriseJson(hostname: string, apiPath: string, paginate = false): Promise<unknown> {
  return new Promise((resolveJson, rejectJson) => {
    const args = ['api', '--hostname', hostname, ...(paginate ? ['--paginate', '--slurp'] : []), apiPath]
    const child = execFile(
      'gh',
      args,
      { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          rejectJson(new Error(String(stderr || err.message).trim()))
          return
        }
        const parsed = String(stdout).trim() ? JSON.parse(String(stdout)) : null
        if (paginate && Array.isArray(parsed)) {
          resolveJson(parsed.flat())
          return
        }
        resolveJson(parsed)
      },
    )
    child.stdin?.end()
  })
}

/**
 * Resolves a `'probe'` self-hosted endpoint into a positively verified forge (`'gitea'`, `'github'` for GitHub Enterprise,
 * or `'gitlab'`), returning `null` when the host is an unknown or unauthenticated forge so Desktop falls back to seat receipts.
 */
export async function resolveVerifiedForgeKind(options: {
  endpoint: ParsedForgeEndpoint
  projectCwd: string
  runner: GitRunner | null
}): Promise<(ParsedForgeEndpoint & { forge: 'github' | 'gitea' | 'gitlab' }) | null> {
  const { endpoint, projectCwd, runner } = options
  if (endpoint.forge !== 'probe') {
    return endpoint as ParsedForgeEndpoint & { forge: 'github' | 'gitea' | 'gitlab' }
  }
  const cached = probedOriginKinds.get(endpoint.httpOrigin)
  if (cached) {
    return cached === 'unsupported' ? null : { ...endpoint, forge: cached }
  }

  const probeErrors: string[] = []

  const giteaAuth = await readCredentialsViaGit(runner, projectCwd, { ...endpoint, forge: 'gitea' })
  const giteaProbe = await probeVersionEndpoint(endpoint.httpOrigin, '/api/v1/version', giteaAuth, 6_000)
  if (giteaProbe.status === 'matched') {
    probedOriginKinds.set(endpoint.httpOrigin, 'gitea')
    return { ...endpoint, forge: 'gitea' }
  }
  if (giteaProbe.status === 'error') {
    probeErrors.push(`Gitea probe failed (${giteaProbe.reason})`)
  }

  const gheProbe = await probeGitHubEnterpriseEndpoint(endpoint.httpOrigin, 6_000)
  if (gheProbe.status === 'matched') {
    probedOriginKinds.set(endpoint.httpOrigin, 'github')
    return { ...endpoint, forge: 'github' }
  }
  if (gheProbe.status === 'error') {
    probeErrors.push(`GitHub Enterprise probe failed (${gheProbe.reason})`)
  }
  if (await checkGhEnterpriseAuth(endpoint.hostname, endpoint.protocol)) {
    probedOriginKinds.set(endpoint.httpOrigin, 'github')
    return { ...endpoint, forge: 'github' }
  }

  const gitlabAuth = await readCredentialsViaGit(runner, projectCwd, { ...endpoint, forge: 'gitlab' })
  const gitlabProbe = await probeVersionEndpoint(endpoint.httpOrigin, '/api/v4/version', gitlabAuth, 6_000)
  if (gitlabProbe.status === 'matched') {
    probedOriginKinds.set(endpoint.httpOrigin, 'gitlab')
    return { ...endpoint, forge: 'gitlab' }
  }
  if (gitlabProbe.status === 'error') {
    probeErrors.push(`GitLab probe failed (${gitlabProbe.reason})`)
  }

  // Never cache or classify as unsupported when any probe failed transiently or due to auth/server errors!
  if (probeErrors.length > 0) {
    throw new Error(`Could not verify forge type for ${endpoint.httpOrigin}: ${probeErrors.join('; ')}`)
  }

  probedOriginKinds.set(endpoint.httpOrigin, 'unsupported')
  return null
}

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

export async function fetchForgePullEvidence(options: {
  endpoint: ParsedForgeEndpoint & { forge: 'github' | 'gitea' | 'gitlab' }
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

  if (endpoint.forge === 'github') {
    const root = `repos/${endpoint.repoPath}/pulls/${endpoint.prNumber}`
    let pullRaw: Record<string, unknown>
    let meRaw: { id?: number; login?: string } | null
    let reviewsRaw: unknown[]
    let inlineRaw: unknown[]
    let issueRaw: unknown[]
    if (endpoint.hostname === 'github.com') {
      const api = await githubCliApi(userDataDir)
      ;[pullRaw, meRaw, reviewsRaw, inlineRaw, issueRaw] = await Promise.all([
        api(root) as Promise<Record<string, unknown>>,
        api('user').catch(() => null) as Promise<{ id?: number; login?: string } | null>,
        api(`${root}/reviews?per_page=100`, true) as Promise<unknown[]>,
        api(`${root}/comments?per_page=100`, true) as Promise<unknown[]>,
        api(`repos/${endpoint.repoPath}/issues/${endpoint.prNumber}/comments?per_page=100`, true) as Promise<unknown[]>,
      ])
    } else {
      ;[pullRaw, meRaw, reviewsRaw, inlineRaw, issueRaw] = await Promise.all([
        runGhEnterpriseJson(endpoint.hostname, root) as Promise<Record<string, unknown>>,
        runGhEnterpriseJson(endpoint.hostname, 'user').catch(() => null) as Promise<{ id?: number; login?: string } | null>,
        runGhEnterpriseJson(endpoint.hostname, `${root}/reviews?per_page=100`, true) as Promise<unknown[]>,
        runGhEnterpriseJson(endpoint.hostname, `${root}/comments?per_page=100`, true) as Promise<unknown[]>,
        runGhEnterpriseJson(endpoint.hostname, `repos/${endpoint.repoPath}/issues/${endpoint.prNumber}/comments?per_page=100`, true) as Promise<unknown[]>,
      ])
    }
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
      const parentReviewId = typeof rec.pull_request_review_id === 'number' ? rec.pull_request_review_id : undefined
      items.push({
        kind: 'inline',
        id: Number(rec.id),
        ...(parentReviewId !== undefined ? { parentReviewId } : {}),
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
    const [pullRaw, meRaw, reviewsRaw, issueRaw] = await Promise.all([
      safeForgeGetJson(endpoint.httpOrigin, `${repoApi}/pulls/${endpoint.prNumber}`, authHeaders) as Promise<Record<string, unknown>>,
      safeForgeGetJson(endpoint.httpOrigin, '/api/v1/user', authHeaders).catch(() => null) as Promise<{ id?: number; login?: string } | null>,
      safeForgePaginateArray(endpoint.httpOrigin, `${repoApi}/pulls/${endpoint.prNumber}/reviews`, authHeaders, 'gitea'),
      safeForgePaginateArray(endpoint.httpOrigin, `${repoApi}/issues/${endpoint.prNumber}/comments`, authHeaders, 'gitea'),
    ])
    const headObj = (pullRaw.head ?? {}) as { sha?: string; repo?: { id?: number } | null }
    const baseObj = (pullRaw.base ?? {}) as { sha?: string; repo?: { id?: number } | null }
    const items: ForgeEvidenceItem[] = []
    const seenInlineIds = new Set<number>()
    for (const r of reviewsRaw) {
      const rec = r as Record<string, unknown>
      const reviewId = Number(rec.id)
      const user = (rec.user ?? {}) as { id?: number; login?: string }
      const rawState = String(rec.state ?? '').toUpperCase()
      const reviewCommitId = typeof rec.commit_id === 'string' ? rec.commit_id.toLowerCase() : null
      items.push({
        kind: 'review',
        id: reviewId,
        state: rawState === 'APPROVED' ? 'APPROVED' : rawState === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED',
        user: user.login ?? '',
        userId: user.id ?? null,
        body: typeof rec.body === 'string' ? rec.body : '',
        commitId: reviewCommitId,
        createdAtMs: parseTimestampMs(rec.updated_at ?? rec.submitted_at),
      })
      if (Number.isSafeInteger(reviewId) && reviewId > 0) {
        const countField = rec.comments_count ?? rec.pull_comments_count
        const shouldFetchInline = countField === undefined ? true : Number(countField) > 0
        if (shouldFetchInline) {
          const inlineRaw = await safeForgePaginateArray(
            endpoint.httpOrigin,
            `${repoApi}/pulls/${endpoint.prNumber}/reviews/${reviewId}/comments`,
            authHeaders,
            'gitea',
          )
          for (const c of inlineRaw) {
            const cRec = c as Record<string, unknown>
            const cId = Number(cRec.id)
            if (seenInlineIds.has(cId)) continue
            seenInlineIds.add(cId)
            const cUser = (cRec.user ?? {}) as { id?: number; login?: string }
            items.push({
              kind: 'inline',
              id: cId,
              parentReviewId: reviewId,
              user: cUser.login ?? '',
              userId: cUser.id ?? null,
              body: typeof cRec.body === 'string' ? cRec.body : '',
              commitId: typeof cRec.original_commit_id === 'string'
                ? cRec.original_commit_id.toLowerCase()
                : typeof cRec.commit_id === 'string'
                  ? cRec.commit_id.toLowerCase()
                  : reviewCommitId,
              createdAtMs: parseTimestampMs(cRec.updated_at ?? cRec.created_at),
            })
          }
        }
      }
    }
    for (const c of issueRaw) {
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
    safeForgePaginateArray(endpoint.httpOrigin, `${mrApi}/notes`, authHeaders, 'gitlab'),
  ])
  const diffRefs = (mrRaw.diff_refs ?? {}) as { head_sha?: string; base_sha?: string }
  const targetBranch = typeof mrRaw.target_branch === 'string' ? mrRaw.target_branch.trim() : ''
  const targetProjSpec = Number.isSafeInteger(mrRaw.target_project_id) && mrRaw.target_project_id !== mrRaw.source_project_id
    ? String(mrRaw.target_project_id)
    : encodedProject
  let targetBranchTipSha = ''
  if (targetBranch) {
    const branchRaw = await safeForgeGetJson(
      endpoint.httpOrigin,
      `/api/v4/projects/${targetProjSpec}/repository/branches/${encodeURIComponent(targetBranch)}`,
      authHeaders,
    ) as Record<string, unknown> | null
    const commitId = ((branchRaw?.commit ?? {}) as { id?: unknown }).id
    if (typeof commitId === 'string' && SHA_RE.test(commitId.trim())) {
      targetBranchTipSha = commitId.trim().toLowerCase()
    }
  }
  const items: ForgeEvidenceItem[] = []
  for (const n of notesRaw) {
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
    base: targetBranchTipSha || String(diffRefs.base_sha ?? '').toLowerCase(),
    sameRepo: Number.isSafeInteger(mrRaw.target_project_id) && mrRaw.target_project_id === mrRaw.source_project_id,
    actorId: meRaw?.id ?? null,
    actorLogin: meRaw?.username ?? null,
    items,
  }
}

export function hasAffirmativeFindingLabel(body: string): boolean {
  const unquoted = body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
  return FINDING_LABEL_LINE_RE.test(unquoted) || FINDING_BOLD_RE.test(unquoted)
}

export function isItemExplicitApproval(item: ForgeEvidenceItem, head: string, base: string, baseMovedInGroup: boolean): boolean {
  if (!SHA_RE.test(head) || !SHA_RE.test(base)) return false
  const raw = item.body.trim()
  const unquotedLines = raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
  const unquoted = unquotedLines.join('\n').trim()
  if (hasAffirmativeFindingLabel(unquoted)) return false

  const baseMatch = REVIEWED_BASE_RE.exec(unquoted)
  if (baseMatch && baseMatch[1]!.toLowerCase() !== base.toLowerCase()) return false

  if (item.kind === 'review' && item.state === 'APPROVED' && item.commitId === head.toLowerCase()) {
    if (baseMovedInGroup && (!baseMatch || baseMatch[1]!.toLowerCase() !== base.toLowerCase())) return false
    return true
  }

  if (!unquoted) return false
  const firstNonEmpty = unquotedLines.find((line) => line.trim() !== '')?.trim() ?? ''
  const headMatch = EXPLICIT_APPROVAL_FIRST_LINE_RE.exec(firstNonEmpty)
  if (!headMatch || headMatch[1]!.toLowerCase() !== head.toLowerCase()) return false
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

  const matchesReceipt = (item: ForgeEvidenceItem): boolean => {
    if (!receipt) return false
    if (item.id === receipt.remoteId && (!receipt.itemType || receipt.itemType === 'any' || receipt.itemType === item.kind)) {
      return true
    }
    if (item.parentReviewId !== undefined && item.parentReviewId === receipt.remoteId && (!receipt.itemType || receipt.itemType === 'any' || receipt.itemType === 'review')) {
      return true
    }
    return false
  }

  // Inherit reviewer tag attribution from an eligible parent review (e.g. GitHub/Gitea grouped review with tagged summary and untagged inline comments).
  const taggedParentReviewIds = new Set<number>()
  for (const item of snapshot.items) {
    if (
      item.kind === 'review'
      && isExpectedAccount(item)
      && item.body.includes(tag)
      && (item.commitId === null || item.commitId === head.toLowerCase())
      && (item.createdAtMs === null || item.createdAtMs + 5_000 >= roundStartedAtMs)
    ) {
      taggedParentReviewIds.add(item.id)
    }
  }

  const hasSeatTag = (item: ForgeEvidenceItem): boolean => (
    item.body.includes(tag)
    || (item.parentReviewId !== undefined && taggedParentReviewIds.has(item.parentReviewId))
  )

  const keyOf = (item: ForgeEvidenceItem): string => `${item.kind}:${item.id}`
  const eligible = snapshot.items.filter((item) => {
    const key = keyOf(item)
    if (claimedEvidenceKeys.has(key)) return false
    if (!isExpectedAccount(item)) return false
    if (item.kind === 'review' && item.state === 'COMMENTED' && item.body.trim() === '') return false
    if (item.commitId !== null && item.commitId !== head.toLowerCase()) return false
    if (item.createdAtMs !== null && item.createdAtMs + 5_000 < roundStartedAtMs) return false
    if (matchesReceipt(item)) return true
    if (totalRequiredSeats > 1 && !hasSeatTag(item)) return false
    return true
  })

  if (eligible.length === 0) return null

  const approvalItem = eligible.find((item) => {
    if (!isItemExplicitApproval(item, head, base, baseMovedInGroup)) return false
    if (totalRequiredSeats > 1 && !hasSeatTag(item)) return false
    return true
  })

  const findingItems = eligible.filter((item) => {
    if (item === approvalItem || isItemExplicitApproval(item, head, base, baseMovedInGroup)) return false
    if (receipt?.kind === 'findings' && matchesReceipt(item)) return true
    const hasSeatAttribution = totalRequiredSeats === 1 || hasSeatTag(item)
    if (!hasSeatAttribution) return false
    if (item.kind === 'review' && item.state === 'CHANGES_REQUESTED') return true
    return hasAffirmativeFindingLabel(item.body)
  })

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
