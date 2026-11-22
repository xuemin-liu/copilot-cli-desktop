import { createHash } from 'node:crypto'
import type { GithubApi } from './workflow-github.js'

const PAGE_BYTES = 12_000
const GROUP_SIZE = 4
const cursorPattern = /^([1-9]\d{0,7})(?:-(\d{1,2})-(\d{1,7})-([a-f0-9]{16}))?$/
type Kind = 'reviews' | 'inline' | 'conversation'
interface Entry { kind: Kind; item: { id: number; body: string; [field: string]: unknown } }

/** The cursor selects a GitHub page and, for a split page, a versioned comment and UTF-16 body offset. */
export async function readPrFeedbackPage(api: GithubApi, repository: string, number: number, cursor = '1'): Promise<string> {
  const match = cursorPattern.exec(cursor)
  if (!match) throw new Error('Invalid feedback page')
  const page = Number(match[1]), root = `repos/${repository}`, path = `${root}/pulls/${number}`
  async function rows(route: string): Promise<Record<string, any>[]> {
    const value = await api(`${route}?per_page=${GROUP_SIZE}&page=${page}`)
    if (!Array.isArray(value) || !value.every(item => item && Number.isSafeInteger(item.id))) throw new Error('Invalid GitHub page')
    return value
  }
  const [pull, inline, conversation, reviews] = await Promise.all([
    api(path) as Promise<Record<string, any>>, rows(path + '/comments'), rows(root + '/issues/' + number + '/comments'), rows(path + '/reviews'),
  ])
  const entries: Entry[] = []
  for (const r of reviews) entries.push({ kind:'reviews', item:{id:r.id, user:r.user?.login, state:r.state, commit:r.commit_id, body:r.body??''} })
  for (const c of inline) entries.push({ kind:'inline', item:{id:c.id, user:c.user?.login, path:c.path, line:c.line??c.original_line,
    inReplyTo:c.in_reply_to_id??null, commit:c.commit_id, body:c.body??''} })
  for (const c of conversation) entries.push({ kind:'conversation', item:{id:c.id, user:c.user?.login, body:c.body??''} })
  const version = createHash('sha256').update(JSON.stringify([pull.head?.sha, pull.base?.sha, entries])).digest('hex').slice(0,16)
  const start = Number(match[2]??0)
  let offset = Number(match[3]??0)
  if (match[4] && (version !== match[4] || start >= entries.length || offset > entries[start]!.item.body.length))
    throw new Error('Feedback changed during this read. Restart pr-read from page one.')
  const chunks: Record<Kind, Entry['item'][]> = { reviews:[], inline:[], conversation:[] }
  const result = { repository, number, state:pull.state, title:pull.title, author:pull.user?.login,
    head:pull.head?.sha, base:pull.base?.sha, baseRef:pull.base?.ref, ...chunks }
  const encode = (nextPage: string | number | null) => JSON.stringify({ ...result, nextPage })
  const nextGroup = [reviews,inline,conversation].some(items => items.length === GROUP_SIZE) ? page + 1 : null

  for (let index = start; index < entries.length; index++) {
    const { kind, item } = entries[index]!
    const bucket = chunks[kind]
    const next = (at: number) => `${page}-${index}-${at}-${version}`
    const remaining = item.body.slice(offset)
    const part = { ...item, body:remaining, ...(offset ? { bodyOffset:offset } : {}) }
    bucket.push(part)
    // Reserve space for the longest continuation cursor before accepting another whole item.
    if (Buffer.byteLength(encode('9'.repeat(48))) <= PAGE_BYTES) { offset = 0; continue }

    // Measure the encoded bytes: quotes, control characters and multibyte text have different wire sizes.
    let low = 0, high = Math.max(0, remaining.length - 1)
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      part.body = remaining.slice(0,middle)
      if (Buffer.byteLength(encode(next(offset + middle))) <= PAGE_BYTES) low = middle
      else high = middle - 1
    }
    if (low > 0) { part.body = remaining.slice(0,low); return encode(next(offset + low)) }
    bucket.pop()
    if (index === start) throw new Error('A feedback record has more metadata than the output limit.')
    return encode(next(offset))
  }
  return encode(nextGroup)
}
