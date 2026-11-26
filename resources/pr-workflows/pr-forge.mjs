import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const SHA_RE = /^[0-9a-f]{40,64}$/i
const POSITIVE_INT_RE = /^[1-9]\d{0,8}$/

export function itemVersionKey({ updatedAt = '', state = '', body = '' }) {
  return createHash('sha256')
    .update(`${updatedAt ?? ''}\0${state ?? ''}\0${body ?? ''}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

export function parseGitRemoteEndpoint(rawOrigin) {
  const raw = String(rawOrigin ?? '').trim()
  if (!raw) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed
    try {
      parsed = new URL(raw)
    } catch {
      return null
    }
    if (!parsed.hostname) return null
    const repoPath = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
    if (!repoPath || !repoPath.includes('/')) return null
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
    return {
      scheme,
      host: parsed.host.toLowerCase(),
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port,
      origin: `${scheme}://${parsed.host.toLowerCase()}`,
      repoPath,
    }
  }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(raw)
  if (scp && !/^[A-Za-z]:[\\/]/.test(raw)) {
    const hostname = scp[1].toLowerCase()
    const repoPath = scp[2].replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
    if (!repoPath || !repoPath.includes('/')) return null
    return {
      scheme: 'ssh',
      host: hostname,
      hostname,
      port: '',
      origin: `https://${hostname}`,
      repoPath,
    }
  }
  return null
}

function parsePrHttpUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl.trim().replace(/\/+$/, ''))
  } catch {
    throw new Error('Invalid pull request HTTP(S) URL.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Pull request URL must use https: or http:.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Pull request URL must not contain embedded credentials.')
  }
  const segments = parsed.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  const mrIdx = segments.findIndex((seg) => seg.toLowerCase() === 'merge_requests')
  if (mrIdx >= 2 && POSITIVE_INT_RE.test(segments[mrIdx + 1] ?? '')) {
    const repoEnd = segments[mrIdx - 1] === '-' ? mrIdx - 1 : mrIdx
    return {
      forgeHint: 'gitlab',
      protocol: parsed.protocol.replace(/:$/, '').toLowerCase(),
      host: parsed.host.toLowerCase(),
      hostname: parsed.hostname.toLowerCase(),
      httpOrigin: parsed.origin.toLowerCase(),
      repoPath: segments.slice(0, repoEnd).join('/'),
      prNumber: Number(segments[mrIdx + 1]),
    }
  }
  const prIdx = segments.findIndex((seg) => /^(?:pulls?|pull-requests|pullrequest)$/i.test(seg))
  if (prIdx >= 1 && POSITIVE_INT_RE.test(segments[prIdx + 1] ?? '')) {
    const segName = segments[prIdx].toLowerCase()
    if (segName === 'pull-requests' || segName === 'pullrequest') {
      throw new Error(
        `Unsupported forge URL (${parsed.origin}${parsed.pathname}): pr-poll.mjs / pr-approve.mjs supports GitHub, Gitea/Forgejo, and GitLab; query Bitbucket or Azure DevOps directly.`,
      )
    }
    const repoPath = segments.slice(0, prIdx).filter((s) => s !== '_git').join('/')
    const forgeHint = parsed.hostname.toLowerCase() === 'github.com' || segName === 'pull'
      ? 'github'
      : segName === 'pulls'
        ? 'gitea'
        : null
    return {
      forgeHint,
      protocol: parsed.protocol.replace(/:$/, '').toLowerCase(),
      host: parsed.host.toLowerCase(),
      hostname: parsed.hostname.toLowerCase(),
      httpOrigin: parsed.origin.toLowerCase(),
      repoPath,
      prNumber: Number(segments[prIdx + 1]),
    }
  }
  throw new Error(`Could not extract pull request / merge request number from URL: ${parsed.origin}${parsed.pathname}`)
}

export function readOriginFromGit(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim()
  } catch {
    return ''
  }
}

export function resolveForgeEndpoint({
  prInput,
  repoOption,
  prUrlOption,
  originOption,
  forgeOption,
  allowHttpOriginOption,
  cwd = process.cwd(),
}) {
  const originRaw = originOption !== undefined ? originOption : readOriginFromGit(cwd)
  const parsedOrigin = parseGitRemoteEndpoint(originRaw)
  const allowedHttpOrigin = (allowHttpOriginOption || process.env.COPILOT_DESKTOP_ALLOW_HTTP_ORIGIN || '').trim().replace(/\/+$/, '').toLowerCase()

  const rawPr = String(prInput ?? '').trim()
  const urlCandidate = /^https?:\/\//i.test(rawPr)
    ? rawPr
    : prUrlOption && /^https?:\/\//i.test(prUrlOption.trim())
      ? prUrlOption.trim()
      : repoOption && /^https?:\/\//i.test(repoOption.trim())
        ? `${repoOption.trim().replace(/\/+$/, '')}/pulls/${rawPr}`
        : null

  let parsedUrl = null
  if (urlCandidate) {
    parsedUrl = parsePrHttpUrl(urlCandidate)
    if (!POSITIVE_INT_RE.test(rawPr) && /^https?:\/\//i.test(rawPr) === false && rawPr !== '') {
      const cleaned = rawPr.replace(/^[#!]/, '')
      if (!POSITIVE_INT_RE.test(cleaned) || Number(cleaned) !== parsedUrl.prNumber) {
        throw new Error('Conflicting pull request number and URL.')
      }
    }
    if (parsedOrigin) {
      if (parsedOrigin.hostname !== parsedUrl.hostname) {
        throw new Error(`Pull request URL host (${parsedUrl.hostname}) does not match Git origin host (${parsedOrigin.hostname}).`)
      }
      if ((parsedOrigin.scheme === 'http' || parsedOrigin.scheme === 'https') && parsedOrigin.host !== parsedUrl.host) {
        throw new Error(`Pull request URL host:port (${parsedUrl.host}) does not match Git origin (${parsedOrigin.host}).`)
      }
    }
  }

  let prNumber = parsedUrl?.prNumber ?? null
  if (prNumber === null) {
    const cleaned = rawPr.replace(/^(?:pr|mr)\s*/i, '').replace(/^[#!]/, '')
    if (!POSITIVE_INT_RE.test(cleaned)) {
      throw new Error('Pass a positive pull request number or HTTP(S) pull request URL.')
    }
    prNumber = Number(cleaned)
  }

  const explicitForge = forgeOption ? String(forgeOption).trim().toLowerCase() : ''
  if (explicitForge && !['github', 'gitea', 'gitlab'].includes(explicitForge)) {
    throw new Error('Unsupported --forge value (expected github, gitea, or gitlab).')
  }

  let httpOrigin = parsedUrl?.httpOrigin ?? null
  if (!httpOrigin && parsedOrigin) {
    let allowedHostMatches = false
    if (allowedHttpOrigin) {
      try {
        allowedHostMatches = new URL(allowedHttpOrigin).hostname.toLowerCase() === parsedOrigin.hostname
      } catch {
        allowedHostMatches = false
      }
    }
    if (parsedOrigin.scheme === 'http' || parsedOrigin.scheme === 'https') {
      httpOrigin = `${parsedOrigin.scheme}://${parsedOrigin.host}`
    } else if (allowedHostMatches) {
      httpOrigin = allowedHttpOrigin
    } else {
      // Non-HTTP(S) schemes (e.g. ssh://git@host:2222/...) must use hostname without the SSH port.
      httpOrigin = `https://${parsedOrigin.hostname}`
    }
  }

  if (httpOrigin && httpOrigin.startsWith('http://')) {
    const originExplicitlyHttp = parsedOrigin?.scheme === 'http' && `http://${parsedOrigin.host}` === httpOrigin
    const configExplicitlyHttp = allowedHttpOrigin !== '' && allowedHttpOrigin === httpOrigin
    if (!originExplicitlyHttp && !configExplicitlyHttp) {
      throw new Error(
        `Refusing cleartext HTTP forge endpoint (${httpOrigin}) unless Git remote "origin" or COPILOT_DESKTOP_ALLOW_HTTP_ORIGIN explicitly matches ${httpOrigin}.`,
      )
    }
  }

  const hostname = parsedUrl?.hostname ?? parsedOrigin?.hostname ?? 'github.com'
  if (
    !explicitForge
    && (hostname === 'bitbucket.org' || hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com') || parsedOrigin?.repoPath?.includes('/_git/'))
  ) {
    throw new Error(
      `Unsupported forge host (${hostname}): pr-poll.mjs / pr-approve.mjs supports GitHub, Gitea/Forgejo, and GitLab; query Bitbucket or Azure DevOps directly.`,
    )
  }
  const effectiveHost = parsedUrl?.host
    ?? (parsedOrigin && (parsedOrigin.scheme === 'http' || parsedOrigin.scheme === 'https') ? parsedOrigin.host : parsedOrigin?.hostname)
    ?? 'github.com'

  let normalizedRepoOption = repoOption && !/^https?:\/\//i.test(repoOption) ? repoOption.trim().replace(/^\/+|\/+$/g, '') : ''
  if (normalizedRepoOption) {
    const lowerOpt = normalizedRepoOption.toLowerCase()
    for (const prefix of [`${effectiveHost.toLowerCase()}/`, `${hostname.toLowerCase()}/`]) {
      if (lowerOpt.startsWith(prefix) && normalizedRepoOption.slice(prefix.length).includes('/')) {
        normalizedRepoOption = normalizedRepoOption.slice(prefix.length)
        break
      }
    }
  }

  const repoPath = (
    normalizedRepoOption
    || parsedUrl?.repoPath
    || parsedOrigin?.repoPath
    || ''
  )

  const forge = explicitForge
    || parsedUrl?.forgeHint
    || (hostname === 'github.com' ? 'github' : 'gitea')

  return {
    forge,
    httpOrigin: httpOrigin ?? 'https://github.com',
    hostname,
    host: effectiveHost,
    protocol: httpOrigin?.startsWith('http://') ? 'http' : 'https',
    repoPath,
    prNumber,
    cwd,
  }
}

function matchConfiguredEnvOrigin(endpoint, envVarNames) {
  const configured = envVarNames
    .map((name) => String(process.env[name] ?? '').trim())
    .filter((v) => v.length > 0)
  if (configured.length === 0) return 'unbound'
  for (const raw of configured) {
    if (/^https?:\/\//i.test(raw)) {
      try {
        if (new URL(raw).origin.toLowerCase() === String(endpoint.httpOrigin ?? '').toLowerCase()) return 'matches'
      } catch {
        // Malformed URL cannot match.
      }
    } else {
      const normalized = raw.replace(/^\/+|\/+$/g, '').toLowerCase()
      if (normalized === String(endpoint.host ?? '').toLowerCase() || normalized === String(endpoint.hostname ?? '').toLowerCase()) {
        return 'matches'
      }
    }
  }
  return 'mismatches'
}

function readEnvForgeCredential(endpoint) {
  if (endpoint.forge === 'gitea') {
    const envTok = (process.env.GITEA_TOKEN || process.env.FORGEJO_TOKEN || '').trim()
    if (!envTok) return { cred: null, binding: 'unbound' }
    return {
      cred: { kind: 'token', token: envTok },
      binding: matchConfiguredEnvOrigin(endpoint, ['GITEA_URL', 'GITEA_HOST', 'FORGEJO_URL', 'FORGEJO_HOST']),
    }
  }
  if (endpoint.forge === 'gitlab') {
    const envTok = (process.env.GITLAB_TOKEN || '').trim()
    if (!envTok) return { cred: null, binding: 'unbound' }
    return {
      cred: { kind: 'gitlab-token', token: envTok },
      binding: matchConfiguredEnvOrigin(endpoint, ['GITLAB_URL', 'GITLAB_HOST']),
    }
  }
  if (endpoint.forge === 'github') {
    const envTok = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
    if (!envTok) return { cred: null, binding: 'unbound' }
    return {
      cred: { kind: 'bearer', token: envTok },
      binding: matchConfiguredEnvOrigin(endpoint, ['GH_HOST']),
    }
  }
  return { cred: null, binding: 'unbound' }
}

export function readForgeCredentials(endpoint) {
  const envResult = readEnvForgeCredential(endpoint)
  // 1. An env token explicitly bound to this exact origin/host wins immediately.
  if (envResult.binding === 'matches' && envResult.cred) {
    return envResult.cred
  }
  // 2. Otherwise prefer host-scoped `git credential fill` so a second forge instance never receives another host's ambient token.
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      cwd: endpoint.cwd,
      input: `protocol=${endpoint.protocol}\nhost=${endpoint.host}\n\n`,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 10_000,
    })
    const fields = new Map()
    for (const line of out.split(/\r?\n/)) {
      const idx = line.indexOf('=')
      if (idx > 0) fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
    }
    const username = fields.get('username') ?? ''
    const password = fields.get('password') ?? ''
    if (password) {
      if (endpoint.forge === 'gitlab') {
        return username && username !== 'oauth2'
          ? { kind: 'basic', basic: Buffer.from(`${username}:${password}`, 'utf8').toString('base64') }
          : { kind: 'gitlab-token', token: password }
      }
      return username
        ? { kind: 'basic', basic: Buffer.from(`${username}:${password}`, 'utf8').toString('base64') }
        : { kind: 'token', token: password }
    }
  } catch {
    // Fall through to unbound ambient env token below if git credential fill failed or returned nothing.
  }
  // 3. Fall back to an unbound ambient env token ONLY when no host-scoped Git credential exists and no conflicting origin/host env var is set.
  if (envResult.binding === 'unbound' && envResult.cred) {
    return envResult.cred
  }
  return null
}

function buildAuthHeaders(cred) {
  if (!cred) return {}
  if (cred.kind === 'token') return { authorization: `token ${cred.token}` }
  if (cred.kind === 'bearer') return { authorization: `Bearer ${cred.token}` }
  if (cred.kind === 'gitlab-token') return { 'private-token': cred.token }
  if (cred.kind === 'basic') return { authorization: `Basic ${cred.basic}` }
  return {}
}

export async function forgeFetchJson(endpoint, apiPath, { method = 'GET', body = undefined, cred = null } = {}) {
  const fullUrl = new URL(apiPath, `${endpoint.httpOrigin}/`)
  if (fullUrl.origin.toLowerCase() !== endpoint.httpOrigin.toLowerCase()) {
    throw new Error('Forge API path escaped configured origin.')
  }
  const headers = {
    accept: 'application/json',
    ...buildAuthHeaders(cred),
    ...(body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
  }
  const res = await fetch(fullUrl, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  })
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Refusing HTTP ${res.status} redirect from forge endpoint ${endpoint.httpOrigin}.`)
  }
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Forge ${method} ${fullUrl.pathname} failed (${res.status}): ${text.slice(0, 240).replace(/\s+/g, ' ')}`)
  }
  return {
    data: text.trim() ? JSON.parse(text) : null,
    headers: res.headers,
  }
}

function parseNextPageFromHeaders(headers, httpOrigin, totalLoaded, currentPageCount, requestedPageSize) {
  const linkHeader = headers.get('link')
  if (linkHeader !== null) {
    const linkPattern = /<([^>]+)>([^,]*)/g
    let match
    while ((match = linkPattern.exec(linkHeader)) !== null) {
      const target = match[1].trim()
      const params = match[2]
      const relMatch = /;\s*rel=(?:"([^"]+)"|([^\s;]+))/i.exec(params)
      const relTokens = (relMatch?.[1] ?? relMatch?.[2] ?? '').toLowerCase().split(/\s+/)
      if (relTokens.includes('next')) {
        const parsedNext = new URL(target, `${httpOrigin}/`)
        if (parsedNext.origin.toLowerCase() !== httpOrigin.toLowerCase()) {
          throw new Error(`Refusing cross-origin pagination Link target (${parsedNext.origin}) from ${httpOrigin}.`)
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

export async function forgePaginateArray(endpoint, basePath, cred, maxPages = 50) {
  const results = []
  const requestedPageSize = endpoint.forge === 'gitlab' ? 100 : 50
  let nextExplicitPath
  let nextPageNum = 1
  for (let pageCount = 1; ; pageCount += 1) {
    const sep = basePath.includes('?') ? '&' : '?'
    const defaultPageParam = endpoint.forge === 'gitlab' ? `per_page=${requestedPageSize}&page=${nextPageNum}` : `limit=${requestedPageSize}&page=${nextPageNum}`
    const requestPath = nextExplicitPath ?? `${basePath}${sep}${defaultPageParam}`
    const { data, headers } = await forgeFetchJson(endpoint, requestPath, { cred })
    if (!Array.isArray(data) || data.length === 0) break
    results.push(...data)
    const nextInfo = parseNextPageFromHeaders(headers, endpoint.httpOrigin, results.length, data.length, requestedPageSize)
    if (!nextInfo.hasMore) break
    if (pageCount >= maxPages) {
      throw new Error(`Forge pagination exceeded safety cap (${maxPages} pages) on ${basePath}; refusing incomplete PR evidence.`)
    }
    nextExplicitPath = nextInfo.nextPath
    nextPageNum = nextInfo.nextPage ?? (nextPageNum + 1)
  }
  return results
}

function runGh(ghBin, args) {
  return execFileSync(ghBin, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2 * 60_000,
  })
}

export async function fetchForgePullSnapshot(endpoint, { includeActor = true, ghBin = process.env.PR_POLL_GH || 'gh' } = {}) {
  if (endpoint.forge === 'github') {
    const hostArgs = endpoint.hostname && endpoint.hostname !== 'github.com' && !process.env.PR_POLL_GH
      ? ['--hostname', endpoint.hostname]
      : []
    const repo = endpoint.repoPath || runGh(ghBin, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()
    const pr = endpoint.prNumber
    const meta = JSON.parse(
      runGh(ghBin, [
        'api',
        ...hostArgs,
        `repos/${repo}/pulls/${pr}`,
        '--jq',
        '{state: (if .merged then "MERGED" else (.state | ascii_upcase) end), headRefOid: .head.sha, baseRefName: .base.ref, baseRefOid: .base.sha, authorId: .user.id, authorLogin: .user.login, headRepoId: .head.repo.id, baseRepoId: .base.repo.id}',
      ]),
    )
    let actor = null
    if (includeActor) {
      try {
        actor = JSON.parse(runGh(ghBin, ['api', ...hostArgs, 'user', '--jq', '{id: .id, login: .login}']))
      } catch {
        actor = null
      }
    }
    const listGh = (path, projection) =>
      runGh(ghBin, ['api', ...hostArgs, '--paginate', path, '--jq', `.[] | ${projection}`])
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))

    const rawReviews = listGh(
      `repos/${repo}/pulls/${pr}/reviews`,
      '{id, state, user: .user.login, userId: .user.id, body, commitId: .commit_id, updatedAt: (.submitted_at // ""), url: .html_url}',
    )
    const rawInline = listGh(
      `repos/${repo}/pulls/${pr}/comments`,
      '{id, path, line, user: .user.login, userId: .user.id, body, commitId: .original_commit_id, inReplyTo: .in_reply_to_id, updatedAt: (.updated_at // .created_at // ""), url: .html_url}',
    )
    const rawIssue = listGh(
      `repos/${repo}/issues/${pr}/comments`,
      '{id, user: .user.login, userId: .user.id, body, updatedAt: (.updated_at // .created_at // ""), url: .html_url}',
    )
    const addVersion = (item) => ({
      ...item,
      versionKey: itemVersionKey({ updatedAt: item.updatedAt, state: item.state, body: item.body }),
    })
    return {
      forge: 'github',
      repo,
      prNumber: pr,
      meta: {
        state: meta.state,
        headRefOid: String(meta.headRefOid ?? '').toLowerCase(),
        baseRefName: meta.baseRefName ?? '',
        baseRefOid: String(meta.baseRefOid ?? '').toLowerCase(),
        sameRepo: Number.isSafeInteger(meta.baseRepoId) && meta.baseRepoId === meta.headRepoId,
        authorId: meta.authorId ?? null,
        authorLogin: meta.authorLogin ?? null,
        actorId: actor?.id ?? null,
        actorLogin: actor?.login ?? null,
      },
      reviews: rawReviews.map(addVersion),
      inline: rawInline.map(addVersion),
      issue: rawIssue.map(addVersion),
    }
  }

  const cred = readForgeCredentials(endpoint)
  if (!endpoint.repoPath) {
    throw new Error('Pass --repo <owner/repo> or run inside a Git checkout with remote "origin".')
  }

  if (endpoint.forge === 'gitea') {
    const repoApi = `/api/v1/repos/${endpoint.repoPath}`
    const { data: pull } = await forgeFetchJson(endpoint, `${repoApi}/pulls/${endpoint.prNumber}`, { cred })
    const actorRes = includeActor ? await forgeFetchJson(endpoint, '/api/v1/user', { cred }).catch(() => ({ data: null })) : { data: null }
    const [rawReviews, rawIssue] = await Promise.all([
      forgePaginateArray(endpoint, `${repoApi}/pulls/${endpoint.prNumber}/reviews`, cred),
      forgePaginateArray(endpoint, `${repoApi}/issues/${endpoint.prNumber}/comments`, cred),
    ])
    // Gitea exposes inline diff comments per review at /pulls/{index}/reviews/{id}/comments, keyed on `comments_count`.
    const reviewComments = []
    const seenInlineIds = new Set()
    for (const r of rawReviews) {
      const reviewId = Number(r.id)
      if (!Number.isSafeInteger(reviewId) || reviewId < 1) continue
      const countField = r.comments_count ?? r.pull_comments_count
      const shouldFetch = countField === undefined ? true : Number(countField) > 0
      if (!shouldFetch) continue
      const sub = await forgePaginateArray(endpoint, `${repoApi}/pulls/${endpoint.prNumber}/reviews/${reviewId}/comments`, cred)
      for (const c of sub) {
        if (!seenInlineIds.has(Number(c.id))) {
          seenInlineIds.add(Number(c.id))
          reviewComments.push({
            ...c,
            _parentCommitId: r.commit_id ?? null,
          })
        }
      }
    }
    const stateStr = pull.merged ? 'MERGED' : String(pull.state ?? 'open').toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED'
    return {
      forge: 'gitea',
      repo: endpoint.repoPath,
      prNumber: endpoint.prNumber,
      meta: {
        state: stateStr,
        headRefOid: String(pull.head?.sha ?? '').toLowerCase(),
        baseRefName: String(pull.base?.ref ?? ''),
        baseRefOid: String(pull.base?.sha ?? '').toLowerCase(),
        sameRepo: Number.isSafeInteger(pull.base?.repo?.id) && pull.base.repo.id === pull.head?.repo?.id,
        authorId: pull.user?.id ?? null,
        authorLogin: pull.user?.login ?? null,
        actorId: actorRes.data?.id ?? null,
        actorLogin: actorRes.data?.login ?? null,
      },
      reviews: rawReviews.map((r) => {
        const rawState = String(r.state ?? '').toUpperCase()
        const normState = rawState === 'APPROVED' ? 'APPROVED' : rawState === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED'
        const updatedAt = r.updated_at ?? r.submitted_at ?? ''
        const body = r.body ?? ''
        return {
          id: Number(r.id),
          state: normState,
          user: r.user?.login ?? '',
          userId: r.user?.id ?? null,
          body,
          commitId: r.commit_id ? String(r.commit_id).toLowerCase() : null,
          updatedAt,
          versionKey: itemVersionKey({ updatedAt, state: normState, body }),
          url: r.html_url ?? `${endpoint.httpOrigin}/${endpoint.repoPath}/pulls/${endpoint.prNumber}`,
        }
      }),
      inline: reviewComments.map((c) => {
        const updatedAt = c.updated_at ?? c.created_at ?? ''
        const body = c.body ?? ''
        return {
          id: Number(c.id),
          path: c.path ?? '',
          line: c.position ?? c.original_position ?? null,
          user: c.user?.login ?? '',
          userId: c.user?.id ?? null,
          body,
          commitId: (c.original_commit_id ?? c.commit_id ?? c._parentCommitId)
            ? String(c.original_commit_id ?? c.commit_id ?? c._parentCommitId).toLowerCase()
            : null,
          inReplyTo: c.resolver ? null : null,
          updatedAt,
          versionKey: itemVersionKey({ updatedAt, body }),
          url: c.html_url ?? `${endpoint.httpOrigin}/${endpoint.repoPath}/pulls/${endpoint.prNumber}`,
        }
      }),
      issue: rawIssue.map((c) => {
        const updatedAt = c.updated_at ?? c.created_at ?? ''
        const body = c.body ?? ''
        return {
          id: Number(c.id),
          user: c.user?.login ?? '',
          userId: c.user?.id ?? null,
          body,
          updatedAt,
          versionKey: itemVersionKey({ updatedAt, body }),
          url: c.html_url ?? `${endpoint.httpOrigin}/${endpoint.repoPath}/pulls/${endpoint.prNumber}`,
        }
      }),
    }
  }

  // GitLab REST v4
  const encodedProject = encodeURIComponent(endpoint.repoPath)
  const mrApi = `/api/v4/projects/${encodedProject}/merge_requests/${endpoint.prNumber}`
  const { data: mr } = await forgeFetchJson(endpoint, mrApi, { cred })
  const actorRes = includeActor ? await forgeFetchJson(endpoint, '/api/v4/user', { cred }).catch(() => ({ data: null })) : { data: null }
  const rawNotes = await forgePaginateArray(endpoint, `${mrApi}/notes`, cred)
  const targetBranch = typeof mr.target_branch === 'string' ? mr.target_branch.trim() : ''
  const targetProjSpec = Number.isSafeInteger(mr.target_project_id) && mr.target_project_id !== mr.source_project_id
    ? String(mr.target_project_id)
    : encodedProject
  let targetBranchTipSha = ''
  if (targetBranch) {
    const { data: branchObj } = await forgeFetchJson(
      endpoint,
      `/api/v4/projects/${targetProjSpec}/repository/branches/${encodeURIComponent(targetBranch)}`,
      { cred },
    )
    const commitId = branchObj?.commit?.id
    if (typeof commitId === 'string' && SHA_RE.test(commitId.trim())) {
      targetBranchTipSha = commitId.trim().toLowerCase()
    }
  }
  const userNotes = rawNotes.filter((n) => !n.system)
  const rawState = String(mr.state ?? '').toLowerCase()
  const stateStr = rawState === 'merged' ? 'MERGED' : rawState === 'opened' ? 'OPEN' : 'CLOSED'
  const headSha = String(mr.diff_refs?.head_sha ?? mr.sha ?? '').toLowerCase()
  const mergeBaseSha = String(mr.diff_refs?.base_sha ?? '').toLowerCase()
  const baseSha = targetBranchTipSha || mergeBaseSha
  const inline = []
  const issue = []
  for (const n of userNotes) {
    const updatedAt = n.updated_at ?? n.created_at ?? ''
    const body = n.body ?? ''
    const baseItem = {
      id: Number(n.id),
      user: n.author?.username ?? '',
      userId: n.author?.id ?? null,
      body,
      updatedAt,
      versionKey: itemVersionKey({ updatedAt, body }),
      url: `${mr.web_url ?? `${endpoint.httpOrigin}/${endpoint.repoPath}/-/merge_requests/${endpoint.prNumber}`}#note_${n.id}`,
    }
    if (n.position && n.position.new_path) {
      inline.push({
        ...baseItem,
        path: n.position.new_path,
        line: n.position.new_line ?? n.position.old_line ?? null,
        commitId: n.position.head_sha ? String(n.position.head_sha).toLowerCase() : headSha,
        inReplyTo: null,
      })
    } else {
      issue.push(baseItem)
    }
  }
  return {
    forge: 'gitlab',
    repo: endpoint.repoPath,
    prNumber: endpoint.prNumber,
    meta: {
      state: stateStr,
      headRefOid: headSha,
      baseRefName: String(mr.target_branch ?? ''),
      baseRefOid: baseSha,
      mergeBaseOid: mergeBaseSha,
      sameRepo: Number.isSafeInteger(mr.target_project_id) && mr.target_project_id === mr.source_project_id,
      authorId: mr.author?.id ?? null,
      authorLogin: mr.author?.username ?? null,
      actorId: actorRes.data?.id ?? null,
      actorLogin: actorRes.data?.username ?? null,
    },
    reviews: [],
    inline,
    issue,
  }
}

const EXPLICIT_APPROVAL_FIRST_LINE_RE = /^Approved at ([0-9a-f]{40,64})(?:\b|$)/i
const REVIEWED_BASE_RE = /\bReviewed base:\s*([0-9a-f]{40,64})\b/i
const FINDING_LABEL_LINE_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#+\s+)?(?:\*\*|__|`)?(?:blocking|non-blocking|nit)(?:\*\*|__|`)?(?:\s*\[[^\]]+\])?\s*[:—–-]/im
const FINDING_BOLD_RE = /\*\*(?:blocking|non-blocking|nit)\*\*/i

export function hasAffirmativeFindingLabel(body) {
  const unquoted = String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
  return FINDING_LABEL_LINE_RE.test(unquoted) || FINDING_BOLD_RE.test(unquoted)
}

export function isExplicitTextApprovalForRevision(item, headSha, baseSha, requireExplicitBase = false) {
  const raw = String(item.body ?? '').trim()
  if (!raw) return false
  // Strip markdown blockquotes so a quoted "Approved at <sha>" never counts as an approval.
  const unquotedLines = raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
  const unquoted = unquotedLines.join('\n').trim()
  if (!unquoted) return false
  const firstNonEmpty = unquotedLines.find((line) => line.trim() !== '')?.trim() ?? ''
  const headMatch = EXPLICIT_APPROVAL_FIRST_LINE_RE.exec(firstNonEmpty)
  if (!headMatch || headMatch[1].toLowerCase() !== headSha.toLowerCase()) return false
  if (hasAffirmativeFindingLabel(unquoted)) return false
  const baseMatch = REVIEWED_BASE_RE.exec(unquoted)
  if (baseMatch && baseSha && baseMatch[1].toLowerCase() !== baseSha.toLowerCase()) {
    return false
  }
  if (requireExplicitBase && (!baseMatch || !baseSha || baseMatch[1].toLowerCase() !== baseSha.toLowerCase())) {
    return false
  }
  return true
}

export function evaluateRevisionApprovals({
  reviews,
  inline,
  issue,
  headSha,
  baseSha,
  baseChangedSinceWatermark = false,
  allowedApproverLogins = null,
  actorId = null,
  actorLogin = null,
  requiredTags = [],
  marker = '\u{1F916} ',
}) {
  const allowedSet = allowedApproverLogins && allowedApproverLogins.length > 0
    ? new Set(allowedApproverLogins.map((s) => s.toLowerCase()))
    : actorLogin
      ? new Set([actorLogin.toLowerCase()])
      : null

  const isTrustedApprover = (item) => {
    if ((item.body ?? '').startsWith(marker)) return false
    if (!allowedSet && actorId === null) return true
    if (actorId !== null && item.userId !== null && item.userId !== undefined && String(item.userId) === String(actorId)) {
      return true
    }
    if (allowedSet && typeof item.user === 'string' && allowedSet.has(item.user.toLowerCase())) {
      return true
    }
    return false
  }

  const approvingItems = []
  for (const r of reviews) {
    if ((r.body ?? '').startsWith(marker)) continue
    const unquotedBody = String(r.body ?? '')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('>'))
      .join('\n')
    const reviewedBase = REVIEWED_BASE_RE.exec(unquotedBody)?.[1]?.toLowerCase() ?? null
    const baseMismatch = reviewedBase !== null && Boolean(baseSha) && reviewedBase !== baseSha.toLowerCase()
    const textApproves = isTrustedApprover(r) && isExplicitTextApprovalForRevision(r, headSha, baseSha, baseChangedSinceWatermark)
    const formalApproves = r.state === 'APPROVED'
      && String(r.commitId ?? '').toLowerCase() === headSha.toLowerCase()
      && !hasAffirmativeFindingLabel(unquotedBody)
      && !baseMismatch
      && (!baseChangedSinceWatermark || (reviewedBase !== null && reviewedBase === baseSha.toLowerCase()))
    if (textApproves || formalApproves) {
      approvingItems.push({ kind: 'review', id: r.id, body: r.body ?? '', formal: formalApproves, user: r.user })
    }
  }
  for (const c of inline) {
    if (isTrustedApprover(c) && isExplicitTextApprovalForRevision(c, headSha, baseSha, baseChangedSinceWatermark)) {
      approvingItems.push({ kind: 'inline', id: c.id, body: c.body ?? '', formal: false, user: c.user })
    }
  }
  for (const c of issue) {
    if (isTrustedApprover(c) && isExplicitTextApprovalForRevision(c, headSha, baseSha, baseChangedSinceWatermark)) {
      approvingItems.push({ kind: 'issue', id: c.id, body: c.body ?? '', formal: false, user: c.user })
    }
  }

  if (requiredTags.length === 0) {
    return {
      approvalForHead: approvingItems.length > 0,
      approvedTags: [],
      missingTags: [],
      approvingItems,
    }
  }

  // Distinct item assignment: one comment/review ID can satisfy at most ONE required seat tag!
  const usedKeys = new Set()
  const approvedTags = []
  const missingTags = []
  for (const tag of requiredTags) {
    const match = approvingItems.find((item) => {
      const key = `${item.kind}:${item.id}`
      if (usedKeys.has(key)) return false
      if (item.body.includes(tag)) return true
      if (requiredTags.length === 1 && item.formal) return true
      return false
    })
    if (match) {
      usedKeys.add(`${match.kind}:${match.id}`)
      approvedTags.push(tag)
    } else {
      missingTags.push(tag)
    }
  }

  return {
    approvalForHead: missingTags.length === 0,
    approvedTags,
    missingTags,
    approvingItems,
  }
}

export { SHA_RE }
