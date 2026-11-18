import type { DesktopSessionTab } from './types.js'
import type { GitRunResult } from './git-runner.js'
import { redactDiagnosticText } from './desktop-diagnostics.js'

/**
 * Pure decisions around branches: which names the panel will create, what a failed switch means, and whether a Copilot session
 * is working in the project (a switch rewrites files under it).
 */

export const MAX_BRANCH_NAME = 200
export const MAX_BRANCH_TASK_TITLE = 160
const MAX_BRANCH_SLUG = 48
const MAX_BRANCH_SUGGESTION_ATTEMPTS = 20

/** Why a branch name cannot be used, or null. Git's own `check-ref-format` has the last word; this keeps obvious trouble out of its way. */
export function branchNameProblem(name: string): string | null {
  if (typeof name !== 'string' || name.trim() === '') return 'Type a branch name.'
  if (name !== name.trim()) return 'A branch name cannot start or end with a space.'
  if (name.length > MAX_BRANCH_NAME) return `A branch name can be at most ${MAX_BRANCH_NAME} characters.`
  if (name.startsWith('-')) return 'A branch name cannot start with "-".'
  if (name === '@' || name === 'HEAD') return `"${name}" is reserved by Git.`
  if ([...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return 'A branch name cannot contain control characters.'
  if (/[\s~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{')) return 'A branch name cannot contain spaces or any of ~ ^ : ? * [ \\ .. @{'
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock') || name.includes('//')) return 'That is not a valid branch name.'
  return null
}

/** Suggest a local branch name from a task title or the first line of a commit draft. */
export function suggestBranchName(text: string, branches: readonly { name: string }[]): string | null {
  const subject = text.split(/\r\n?|\n/, 1)[0]!.trim()
  const header = /^([a-z][a-z0-9-]*)(?:\([^)]+\))?!?:\s+/i.exec(subject)
  const words = subject.slice(header?.[0].length ?? 0).toLowerCase().normalize('NFC').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)
  const slug = Array.from(words?.join('-') ?? '').slice(0, MAX_BRANCH_SLUG).join('').replace(/-+$/, '')
  if (!slug) return null

  const prefixes = new Set<string>()
  const names = branches.map(({ name }) => {
    // Desktop worktree branches have no slash, so they cannot establish a prefix.
    const slash = name.indexOf('/')
    if (slash > 0) prefixes.add(name.slice(0, slash))
    return name.toLowerCase().normalize('NFC')
  })
  const type = header?.[1]?.toLowerCase()
  const matchingPrefix = [...prefixes].find(prefix => prefix.toLowerCase() === type)
  const prefix = matchingPrefix ?? (prefixes.size === 1 ? prefixes.values().next().value : undefined)
  const search = (base: string): string | null => {
    for (let attempt = 1; attempt <= MAX_BRANCH_SUGGESTION_ATTEMPTS; attempt++) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`
      const key = candidate.toLowerCase().normalize('NFC')
      if (branchNameProblem(candidate) === null && !names.some(name =>
        name === key || name.startsWith(`${key}/`) || key.startsWith(`${name}/`))) return candidate
    }
    return null
  }
  return (prefix ? search(`${prefix}/${slug}`) : null) ?? search(slug)
}

export type SwitchFailureReason = 'local-changes' | 'failed'

/** What a failed `git switch` means for the person. Nothing was changed by it: git refuses before touching a file. */
export function describeSwitchFailure(result: GitRunResult, what: 'switch' | 'create'): { reason: SwitchFailureReason; message: string } {
  const text = result.stderr
  if (/would be overwritten by (checkout|merge)|untracked working tree files would be overwritten|please commit your changes or stash them/i.test(text)) {
    return { reason: 'local-changes', message: 'Your uncommitted changes would be overwritten by that branch, so Git did not switch. Nothing was changed. Commit them or set them aside, then try again.' }
  }
  if (what === 'create' && /already exists/i.test(text)) return { reason: 'failed', message: 'A branch with that name already exists.' }
  const line = redactDiagnosticText(text.split('\n').map(item => item.trim()).find(item => item !== '' && !item.startsWith('hint:')) ?? '')
  return { reason: 'failed', message: line || `git ${what === 'create' ? 'switch --create' : 'switch'} failed (exit ${result.exitCode ?? 'none'})` }
}

export interface ProjectActivity {
  busy: boolean
  /** Plain words naming the session, for the message that blocks a switch. */
  detail: string
}

/** A session with no reliable activity signal that did something this recently is treated as possibly working. */
export const RECENT_ACTIVITY_MS = 60_000

/**
 * Whether a Copilot session in this project may be changing files right now. Observed activity wins; a session that is
 * starting, or waiting for the person to approve something, is mid-task; with no evidence either way, recent output counts.
 */
export function projectActivity(tabs: readonly Pick<DesktopSessionTab, 'title' | 'workspaceProfileId' | 'status' | 'activity' | 'lastActivityAt'>[], profileId: string, now: number): ProjectActivity {
  for (const tab of tabs) {
    if (tab.workspaceProfileId !== profileId) continue
    const title = tab.title || 'A session'
    if (tab.status === 'starting') return { busy: true, detail: `"${title}" is starting` }
    if (tab.status === 'approval-needed') return { busy: true, detail: `"${title}" is waiting for you to approve something` }
    if (tab.status !== 'running') continue
    if (tab.activity === 'working') return { busy: true, detail: `"${title}" is working` }
    if (tab.activity !== 'idle' && now - tab.lastActivityAt < RECENT_ACTIVITY_MS) return { busy: true, detail: `"${title}" was active a moment ago` }
  }
  return { busy: false, detail: '' }
}
