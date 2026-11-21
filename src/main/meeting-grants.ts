import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'
import { pathKey } from './host-path.js'

/**
 * What a person is asked when an outside agent wants something it could take on its own word otherwise: to attach the
 * uncommitted changes of a folder it named, or to read the changes a meeting shares after joining with only the
 * meeting's id. The meeting tools need no invitation and no sign-in, so any program on this computer can call them;
 * these two are the places where that reaches a person's work.
 */
export interface GrantQuestion {
  kind: 'attach-changes' | 'read-changes'
  /** The agent, by the name it gave. A name is not proof of who is asking, and the question says so. */
  agent: string
  /** For `attach-changes`: the folder, as the system names it. */
  folder: string | null
  /** For `read-changes`: the meeting. */
  meetingId: string | null
}

export type GrantAnswer = 'deny' | 'once' | 'always'

export interface MeetingGrantOptions {
  /** Where "always for this folder" is kept. */
  file: string
  /** Shows the question and waits for the person. `always` is offered only for a folder. Throws or denies when nobody can be asked. */
  ask(question: GrantQuestion): Promise<GrantAnswer>
  /** The folder as the system names it, so two spellings of one folder are one answer. */
  canonical(folder: string): Promise<string>
  now?: () => number
}

/** After a "no", the same question is not put again for this long: a program must not be able to wear a person down. */
export const GRANT_DENIAL_MS = 5 * 60_000
const MAX_REMEMBERED = 200

export class MeetingGrants {
  private remembered: Set<string> | null = null
  private asking = false
  private readonly denied = new Map<string, number>()
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly options: MeetingGrantOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now() }

  private async load(): Promise<Set<string>> {
    if (!this.remembered) {
      // A file that is missing or damaged remembers nothing; it never counts as a yes.
      const saved = await readFile(this.options.file, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => null)
      const folders = saved && typeof saved === 'object' && !Array.isArray(saved) && Array.isArray((saved as { folders?: unknown }).folders) ? (saved as { folders: unknown[] }).folders : []
      this.remembered = new Set(folders.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096).slice(0, MAX_REMEMBERED))
    }
    return this.remembered
  }

  /** One question at a time, and none again soon after a "no". Anything that goes wrong is a "no". */
  private async put(key: string, question: GrantQuestion): Promise<GrantAnswer> {
    const refusedAt = this.denied.get(key)
    if (refusedAt !== undefined && this.now() - refusedAt < GRANT_DENIAL_MS) return 'deny'
    if (this.asking) return 'deny'
    this.asking = true
    try {
      const answer = await this.options.ask(question).catch(() => 'deny' as const)
      if (answer === 'deny') {
        this.denied.set(key, this.now())
        if (this.denied.size > 500) this.denied.delete(this.denied.keys().next().value as string)
      } else this.denied.delete(key)
      return answer
    } finally { this.asking = false }
  }

  /** May this agent attach the uncommitted changes of the folder it named? */
  async attachChanges(agent: string, folder: string): Promise<boolean> {
    let canonical: string
    try { canonical = await this.options.canonical(folder) } catch { return false }
    const key = pathKey(canonical)
    const remembered = await this.load()
    if (remembered.has(key)) return true
    const answer = await this.put(`attach\0${key}`, { kind: 'attach-changes', agent, folder: canonical, meetingId: null })
    if (answer === 'always') {
      remembered.add(key)
      while (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.values().next().value as string)
      const body = JSON.stringify({ version: 1, folders: [...remembered] }, null, 2)
      this.writes = this.writes.then(() => writeFileAtomic(this.options.file, body)).catch(() => undefined)
      await this.writes
    }
    return answer !== 'deny'
  }

  /** May this agent, which joined with only the meeting's id, read the changes the meeting shares? */
  async readChanges(agent: string, seatId: string, meetingId: string): Promise<boolean> {
    const answer = await this.put(`read\0${seatId}`, { kind: 'read-changes', agent, folder: null, meetingId })
    return answer !== 'deny'
  }

  /** Folders whose changes may always be attached, for a settings view or a test. */
  async rememberedFolders(): Promise<string[]> { return [...await this.load()] }
}
