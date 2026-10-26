import { redactDiagnosticText } from './desktop-diagnostics.js'
import type { GitRunResult } from './git-runner.js'

/**
 * Fetch, pull and push talk to another machine, and the address they use comes from the repository's own config. This module
 * holds the pure decisions around that: which addresses may be used at all, and what a failure means for the person.
 */

/**
 * The only transports a fetch, pull or push may use (`GIT_ALLOW_PROTOCOL`). It leaves out `ext` and `fd`, which run a program
 * named in the address, and every `name::address` remote helper.
 */
export const ALLOWED_PROTOCOLS = 'http:https:ssh:git:file'

export type RemoteUrlVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Whether the address of a remote is one the panel will contact. A repository can arrive with any address in its config:
 * - a network share (`\\server\share`, `//server/share`, `file://server/share`) makes Windows send the user's credentials to
 *   that server just to open it;
 * - a `name::address` helper or an `ext::` address runs a program;
 * - a host that starts with `-` is read by `ssh` as an option.
 */
export function checkRemoteUrl(url: string): RemoteUrlVerdict {
  const text = url.trim()
  if (text === '') return { ok: false, reason: 'has no address' }
  if (text.startsWith('-')) return { ok: false, reason: 'has an address that starts with "-"' }
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(text)) return { ok: false, reason: 'uses a custom transport that runs a program' }
  if (text.startsWith('\\\\') || text.startsWith('//')) return { ok: false, reason: 'points at a network share' }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s.exec(text)
  if (scheme) {
    const name = (scheme[1] ?? '').toLowerCase()
    const rest = scheme[2] ?? ''
    if (!['http', 'https', 'ssh', 'git', 'file'].includes(name)) return { ok: false, reason: `uses the "${name}" protocol, which the panel does not use` }
    const authority = rest.split(/[/\\]/, 1)[0] ?? ''
    const host = authority.slice(authority.lastIndexOf('@') + 1)
    if (host.startsWith('-')) return { ok: false, reason: 'has a host that starts with "-"' }
    if (name === 'file' && host !== '' && host.toLowerCase() !== 'localhost') return { ok: false, reason: 'points at a network share' }
    // `file:////server/share` has no host, but its path starts with two separators, which Windows reads as a network share.
    if (name === 'file' && /^[/\\]{2}/.test(rest.slice(authority.length))) return { ok: false, reason: 'points at a network share' }
    return { ok: true }
  }
  // `user@host:path` (scp style) or a local path.
  const hostPart = text.split(':', 1)[0] ?? ''
  if (hostPart.includes('@') && hostPart.slice(hostPart.lastIndexOf('@') + 1).startsWith('-')) return { ok: false, reason: 'has a host that starts with "-"' }
  return { ok: true }
}

/**
 * Whether the fetch refspecs a remote is configured with write only into its own remote-tracking branches. A fetch applies every
 * `remote.<name>.fetch` the repository has, so `+refs/heads/main:refs/heads/backup` would reset a local branch, and a refspec
 * that writes under `refs/tags` or another remote's namespace changes more than "fetch" promises.
 */
export function checkFetchRefspecs(remote: string, refspecs: readonly string[]): RemoteUrlVerdict {
  const inside = `refs/remotes/${remote}/`
  for (const raw of refspecs) {
    const spec = raw.trim()
    if (spec === '' || spec.startsWith('^')) continue // negative refspecs only exclude
    const body = spec.startsWith('+') ? spec.slice(1) : spec
    const colon = body.indexOf(':')
    if (colon === -1) continue // no destination: the result goes to FETCH_HEAD only
    const destination = body.slice(colon + 1)
    if (!destination.startsWith(inside) || destination.includes(':') || destination.includes('..') || destination.includes('\\')) {
      return { ok: false, reason: `has the fetch setting "${spec}", which writes outside its remote-tracking branches` }
    }
  }
  return { ok: true }
}

export type SyncOperation = 'fetch' | 'pull' | 'push'

export type SyncFailureReason = 'auth-required' | 'rejected' | 'diverged' | 'local-changes' | 'failed'

export interface SyncFailure {
  reason: SyncFailureReason
  message: string
}

const AUTH_FAILURE = new RegExp([
  'terminal prompts disabled',
  'could not read (?:username|password)',
  'authentication failed',
  'permission denied \\(',
  'host key verification failed',
  'returned error: (?:401|403)',
  'invalid username or password',
  'support for password authentication was removed',
  'no supported authentication methods',
  'repository not found',
].join('|'), 'i')

const NOT_FAST_FORWARD = /\[rejected\]|non-fast-forward|fetch first|failed to push some refs|updates were rejected/i
const CANNOT_FAST_FORWARD = /not possible to fast-forward|have diverged|diverging branches/i
const LOCAL_CHANGES_IN_THE_WAY = /would be overwritten by merge|untracked working tree files would be (?:overwritten|removed) by merge/i

const AUTH_MESSAGE = 'Authentication required. In a terminal, run git fetch in this repository once, so Git can ask for your credentials or use the ones it has saved, then try again here. The panel never asks for or stores credentials.'

/** What a failed fetch, pull or push means in plain words, from the exit status and what git printed. */
export function describeSyncFailure(result: GitRunResult, operation: SyncOperation): SyncFailure {
  const text = result.stderr
  if (AUTH_FAILURE.test(text)) return { reason: 'auth-required', message: AUTH_MESSAGE }
  if (operation === 'push' && NOT_FAST_FORWARD.test(text)) {
    return { reason: 'rejected', message: 'The remote has changes you do not have, so Git refused the push. Fetch and pull first, then push again. The panel never forces a push.' }
  }
  if (operation === 'pull' && CANNOT_FAST_FORWARD.test(text)) {
    return { reason: 'diverged', message: 'Your branch and its upstream have each moved on, so the pull cannot fast-forward. Nothing was changed. Merge or rebase in a terminal.' }
  }
  if (operation === 'pull' && LOCAL_CHANGES_IN_THE_WAY.test(text)) {
    return { reason: 'local-changes', message: 'Your uncommitted changes would be overwritten by the pull, so Git refused it. Nothing was changed. Commit them or set them aside, then pull again.' }
  }
  const line = redactDiagnosticText(text.split(/\r?\n/).map(item => item.trim()).find(item => item !== '' && !item.startsWith('hint:')) ?? '')
  return { reason: 'failed', message: line || `git ${operation} failed (exit ${result.exitCode ?? 'none'})` }
}

/**
 * The files Git names when local changes stop a merge: the indented lines under each "would be overwritten" heading. Read
 * from the output the panel shows (already redacted), so a caller can name them without running Git again.
 */
export function filesInTheWay(output: string): string[] {
  const files: string[] = []
  let listing = false
  for (const line of output.split(/\r?\n/)) {
    if (LOCAL_CHANGES_IN_THE_WAY.test(line)) { listing = true; continue }
    if (listing && /^\s+\S/.test(line)) { const path = line.trim(); if (!files.includes(path)) files.push(path); continue }
    listing = false
  }
  return files
}
