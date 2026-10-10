/** Pure parsers for git output. Nothing here starts a process or touches the disk. */

export interface GitVersion {
  major: number
  minor: number
  patch: number
  text: string
}

/** Oldest git the panel supports. `--pathspec-from-file` and `--pathspec-file-nul` arrived in 2.25. */
export const MIN_GIT_VERSION: Readonly<Pick<GitVersion, 'major' | 'minor' | 'patch'>> = { major: 2, minor: 30, patch: 0 }

export function parseGitVersion(output: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)\.(\d+)/m.exec(output.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: output.trim().split(/\r?\n/, 1)[0] ?? '' }
}

export function isSupportedGitVersion(version: Pick<GitVersion, 'major' | 'minor' | 'patch'>): boolean {
  const a = [version.major, version.minor, version.patch]
  const b = [MIN_GIT_VERSION.major, MIN_GIT_VERSION.minor, MIN_GIT_VERSION.patch]
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return true
}

/** One letter from porcelain v2: `.` unchanged, `?` untracked, `!` ignored, otherwise a git status letter. */
export type GitStatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!'

export type GitEntryKind = 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored'

export interface GitStatusEntry {
  kind: GitEntryKind
  path: string
  /** Source path of a rename or copy. */
  originalPath: string | null
  /** Staged side (index compared with HEAD). */
  index: GitStatusCode
  /** Unstaged side (working tree compared with the index). */
  worktree: GitStatusCode
  submodule: boolean
  /** An untracked directory collapsed into one entry (`dir/`). */
  isDirectory: boolean
  /**
   * The object id of the staged version (null for entries with nothing staged or no single version). It is part of what the
   * file-list version covers, so re-staging different content under the same name is a different list.
   */
  indexOid: string | null
}

export interface GitBranchInfo {
  /** Commit id, or null before the first commit. */
  oid: string | null
  /** Branch name, or null while detached. */
  head: string | null
  detached: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
}

export interface GitStatus {
  branch: GitBranchInfo
  entries: GitStatusEntry[]
  /** Entries seen, including any past the cap. */
  totalEntries: number
  truncated: boolean
  /** Records that did not match any known porcelain shape. */
  malformed: number
  /** True when a path was not valid UTF-8 and was decoded lossily. */
  lossyPaths: boolean
}

export const DEFAULT_MAX_STATUS_ENTRIES = 5_000

const STATUS_CODES = new Set(['.', 'M', 'T', 'A', 'D', 'R', 'C', 'U'])

/** The staged object id from a porcelain v2 record, or null when nothing is staged for the file. */
function indexOid(field: string | undefined, indexCode: string | undefined): string | null {
  return field !== undefined && /^[0-9a-f]{40,64}$/.test(field) && indexCode !== undefined && indexCode !== '.' ? field : null
}

function statusCode(value: string | undefined): GitStatusCode {
  return value !== undefined && STATUS_CODES.has(value) ? value as GitStatusCode : '.'
}

/** Split a NUL-terminated record stream. A trailing terminator does not produce an empty record. */
export function splitNul(output: string): string[] {
  const records = output.split('\0')
  if (records.at(-1) === '') records.pop()
  return records
}

/** The first `count` space-separated fields, and the rest of the line untouched (a path may contain spaces). */
function leadingFields(record: string, count: number): { fields: string[]; rest: string } | null {
  const fields: string[] = []
  let position = 0
  for (let index = 0; index < count; index++) {
    const space = record.indexOf(' ', position)
    if (space < 0) return null
    fields.push(record.slice(position, space))
    position = space + 1
  }
  return { fields, rest: record.slice(position) }
}

/** Parse `git status --porcelain=v2 -z --branch` output. */
export function parseStatusV2(output: string, maxEntries = DEFAULT_MAX_STATUS_ENTRIES): GitStatus {
  const branch: GitBranchInfo = { oid: null, head: null, detached: false, upstream: null, ahead: null, behind: null }
  const entries: GitStatusEntry[] = []
  let totalEntries = 0
  let malformed = 0
  const records = splitNul(output)
  const add = (entry: GitStatusEntry): void => {
    totalEntries++
    if (entries.length < maxEntries) entries.push(entry)
  }
  for (let position = 0; position < records.length; position++) {
    const record = records[position] ?? ''
    if (record.startsWith('# ')) {
      const header = leadingFields(record, 2)
      const name = header?.fields[1]
      const value = header?.rest ?? record.slice(2).split(' ').slice(1).join(' ')
      if (name === 'branch.oid') branch.oid = value === '(initial)' ? null : value
      else if (name === 'branch.head') { branch.detached = value === '(detached)'; branch.head = branch.detached ? null : value }
      else if (name === 'branch.upstream') branch.upstream = value
      else if (name === 'branch.ab') {
        const ab = /^\+(\d+) -(\d+)$/.exec(value)
        if (ab) { branch.ahead = Number(ab[1]); branch.behind = Number(ab[2]) }
      }
      continue
    }
    const type = record[0]
    if (type === '1') {
      const parsed = leadingFields(record, 8)
      if (!parsed || parsed.rest === '') { malformed++; continue }
      const xy = parsed.fields[1] ?? '..'
      add({ kind: 'changed', indexOid: indexOid(parsed.fields[7], xy[0]), path: parsed.rest, originalPath: null, index: statusCode(xy[0]), worktree: statusCode(xy[1]), submodule: parsed.fields[2]?.startsWith('S') ?? false, isDirectory: false })
    } else if (type === '2') {
      const parsed = leadingFields(record, 9)
      const original = records[++position]
      if (!parsed || parsed.rest === '' || original === undefined) { malformed++; continue }
      const xy = parsed.fields[1] ?? '..'
      add({ kind: 'renamed', indexOid: indexOid(parsed.fields[7], xy[0]), path: parsed.rest, originalPath: original, index: statusCode(xy[0]), worktree: statusCode(xy[1]), submodule: parsed.fields[2]?.startsWith('S') ?? false, isDirectory: false })
    } else if (type === 'u') {
      const parsed = leadingFields(record, 10)
      if (!parsed || parsed.rest === '') { malformed++; continue }
      add({ kind: 'unmerged', indexOid: null, path: parsed.rest, originalPath: null, index: 'U', worktree: 'U', submodule: parsed.fields[2]?.startsWith('S') ?? false, isDirectory: false })
    } else if ((type === '?' || type === '!') && record[1] === ' ' && record.length > 2) {
      const path = record.slice(2)
      add({ kind: type === '?' ? 'untracked' : 'ignored', indexOid: null, path, originalPath: null, index: '.', worktree: type, submodule: false, isDirectory: path.endsWith('/') })
    } else if (record !== '') malformed++
  }
  return { branch, entries, totalEntries, truncated: totalEntries > entries.length, malformed, lossyPaths: output.includes('�') }
}

export interface GroupedStatus {
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
  conflicted: GitStatusEntry[]
}

/** One file can appear in both `staged` and `unstaged`. Ignored files are left out. */
export function groupStatusEntries(entries: readonly GitStatusEntry[]): GroupedStatus {
  const grouped: GroupedStatus = { staged: [], unstaged: [], untracked: [], conflicted: [] }
  for (const entry of entries) {
    if (entry.kind === 'unmerged') grouped.conflicted.push(entry)
    else if (entry.kind === 'untracked') grouped.untracked.push(entry)
    else if (entry.kind === 'changed' || entry.kind === 'renamed') {
      if (entry.index !== '.') grouped.staged.push(entry)
      if (entry.worktree !== '.') grouped.unstaged.push(entry)
    }
  }
  return grouped
}

export interface GitNumstatEntry {
  path: string
  originalPath: string | null
  added: number | null
  deleted: number | null
  binary: boolean
}

/** Parse `git diff --numstat -z`. Binary files report `-` for both counts. */
export function parseNumstat(output: string): GitNumstatEntry[] {
  const result: GitNumstatEntry[] = []
  const records = splitNul(output)
  for (let position = 0; position < records.length; position++) {
    const record = records[position] ?? ''
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record)
    if (!match) continue
    const binary = match[1] === '-' && match[2] === '-'
    let path = match[3] ?? ''
    let originalPath: string | null = null
    if (path === '') {
      originalPath = records[++position] ?? null
      path = records[++position] ?? ''
    }
    if (path === '') continue
    result.push({ path, originalPath, added: binary ? null : Number(match[1]), deleted: binary ? null : Number(match[2]), binary })
  }
  return result
}

export interface BoundedText {
  text: string
  truncated: boolean
  totalBytes: number
}

/** Keep at most `maxBytes` of `data`, cut at a line break when one exists, never inside a UTF-8 character. */
export function boundText(data: Buffer, maxBytes: number): BoundedText {
  if (data.length <= maxBytes) return { text: data.toString('utf8'), truncated: false, totalBytes: data.length }
  let end = maxBytes
  const lineBreak = data.lastIndexOf(0x0a, end - 1)
  if (lineBreak > 0) end = lineBreak + 1
  else while (end > 0 && ((data[end] ?? 0) & 0xc0) === 0x80) end--
  return { text: data.subarray(0, end).toString('utf8'), truncated: true, totalBytes: data.length }
}

export interface GitLogEntry {
  hash: string
  parents: string[]
  author: string
  /** Strict ISO 8601 author date. */
  date: string
  subject: string
  refs: string[]
}

/** Format string for `git log -z`; fields are separated by U+001F. */
export const GIT_LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D'

export function parseLog(output: string): GitLogEntry[] {
  const result: GitLogEntry[] = []
  for (const record of splitNul(output)) {
    const fields = record.replace(/^\n+/, '').split('\x1f')
    if (fields.length < 6 || !/^[0-9a-f]{40,64}$/.test(fields[0] ?? '')) continue
    result.push({
      hash: fields[0] ?? '',
      parents: (fields[1] ?? '').split(' ').filter(Boolean),
      author: fields[2] ?? '',
      date: fields[3] ?? '',
      subject: fields[4] ?? '',
      refs: (fields[5] ?? '').split(', ').filter(Boolean),
    })
  }
  return result
}

export interface GitStagedRawEntry {
  path: string
  oldMode: string
  newMode: string
}

/** Parse `git diff --cached --raw -z --no-renames`: `:oldmode newmode oldoid newoid status NUL path NUL`. */
export function parseStagedRaw(output: string): GitStagedRawEntry[] {
  const result: GitStagedRawEntry[] = []
  const records = splitNul(output)
  for (let position = 0; position < records.length; position++) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/.exec(records[position] ?? '')
    if (!match) continue
    const path = records[++position] ?? ''
    if (path !== '') result.push({ path, oldMode: match[1] ?? '', newMode: match[2] ?? '' })
  }
  return result
}

export interface GitBranchEntry {
  name: string
  current: boolean
  oid: string
  upstream: string | null
  ahead: number | null
  behind: number | null
  /** The upstream is configured but no longer exists on the remote. */
  upstreamGone: boolean
  subject: string
  /** Seconds since the epoch of the branch's last commit. */
  committedAt: number | null
}

/** Parse `branchListArgs()` output: one branch per line, fields separated by the unit separator (code 31). */
export function parseBranches(output: string, max = 500): GitBranchEntry[] {
  const result: GitBranchEntry[] = []
  const separator = String.fromCharCode(31)
  for (const line of output.split(String.fromCharCode(10))) {
    if (result.length >= max) break
    const fields = line.replace(String.fromCharCode(13), '').split(separator)
    if (fields.length !== 7) continue
    const [head = '', ref = '', oid = '', upstream = '', track = '', committed = '', subject = ''] = fields
    // The full ref, so a tag or other ref with the same name cannot change what the branch is called.
    const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ''
    if (name === '' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)) continue
    result.push({
      name, current: head === '*', oid, upstream: upstream === '' ? null : upstream,
      ahead: /ahead (\d+)/.exec(track) ? Number(/ahead (\d+)/.exec(track)?.[1]) : upstream === '' || track.includes('gone') ? null : 0,
      behind: /behind (\d+)/.exec(track) ? Number(/behind (\d+)/.exec(track)?.[1]) : upstream === '' || track.includes('gone') ? null : 0,
      upstreamGone: track.includes('gone'), subject, committedAt: /^\d+$/.test(committed) ? Number(committed) : null,
    })
  }
  return result
}

/**
 * The remote branches named by `publishedRefsArgs()` output, as `origin/main`. A remote's `HEAD` (`origin/HEAD`) only points at one of
 * its branches, so it is not a branch of its own and is left out.
 */
export function parsePublishedRefs(output: string, max = 20): string[] {
  const names: string[] = []
  for (const line of output.split(String.fromCharCode(10))) {
    const ref = line.trim()
    if (!ref.startsWith('refs/remotes/')) continue
    const name = ref.slice('refs/remotes/'.length)
    if (name === '' || name.endsWith('/HEAD')) continue
    if (!names.includes(name)) names.push(name)
    if (names.length >= max) break
  }
  return names
}
