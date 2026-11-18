import { privateKeyLineRanges } from '../main/git-prompt.js'
import type { DiffComment } from '../main/git-prompt.js'
import type { GitDiffView } from '../main/git-types.js'
import { MAX_RENDERED_LINES, numberDiffLines } from './components/GitDiffView.js'
import type { DiffCommentAnchor } from './components/GitDiffView.js'

/** The comments on one file and side, and the diff text the first of them was written against (to warn when it changes). */
export interface DiffCommentBucket {
  repoId: string
  path: string
  staged: boolean
  diffText: string | null
  items: Map<string, DiffComment>
  pending: readonly DiffComment[]
  unanchored: readonly DiffComment[]
}

/** Buckets keyed by `bucketKey`. Each file and side keeps its own comments until it is cleared or the file is no longer
 * changed, so a review that moves between files loses nothing. */
export type DiffCommentBuckets = ReadonlyMap<string, DiffCommentBucket>

export interface BucketTarget {
  repoId: string
  path: string
  staged: boolean
}

export function bucketKey(target: BucketTarget): string {
  return `${target.repoId}:${target.staged ? 'staged' : 'working'}:${target.path}`
}

/** Set (`text`) or remove (`null`) one comment in one bucket; every other bucket is untouched. A bucket with no comments
 * left is dropped. `diffText` is the diff the anchor was taken from: a quote inside one of its private-key blocks is
 * redacted here, at capture, so the stored comment never holds key material whatever diff is current later. The bucket
 * records the first diff as its baseline for the stale warning. */
export function updateCommentBucket(buckets: DiffCommentBuckets, target: BucketTarget, diffText: string, commentKey: string, anchor: DiffCommentAnchor, text: string | null): DiffCommentBuckets {
  const key = bucketKey(target)
  const next = new Map(buckets)
  const current = buckets.get(key)
  const items = new Map(current?.items ?? [])
  if (text === null) items.delete(commentKey)
  else {
    const redacted = privateKeyLineRanges(diffText).some(([first, last]) => anchor.order >= first && anchor.order <= last)
    items.set(commentKey, { side: anchor.side, line: anchor.line, quote: redacted ? '' : anchor.quote, redacted, index: anchor.position, text })
  }
  const pending = current?.pending ?? []
  const unanchored = current?.unanchored ?? []
  if (items.size === 0 && pending.length === 0 && unanchored.length === 0) next.delete(key)
  else next.set(key, { ...target, diffText: current?.diffText ?? diffText, items, pending, unanchored })
  return next
}

export function removeCommentBucket(buckets: DiffCommentBuckets, key: string): DiffCommentBuckets {
  if (!buckets.has(key)) return buckets
  const next = new Map(buckets)
  next.delete(key)
  return next
}

/** Keep drafts together while waiting for the receiving diff. Existing comments keep their own baseline and anchors. */
export function moveCommentBucket(buckets: DiffCommentBuckets, source: DiffCommentBucket): DiffCommentBuckets {
  const target = { repoId: source.repoId, path: source.path, staged: !source.staged }
  const key = bucketKey(target)
  const destination = buckets.get(key)
  const next = new Map(buckets)
  next.delete(bucketKey(source))
  next.set(key, {
    ...target,
    diffText: destination?.diffText ?? null,
    items: destination?.items ?? new Map(),
    pending: [...(destination?.pending ?? []), ...source.items.values(), ...source.pending],
    unanchored: [...(destination?.unanchored ?? []), ...source.unanchored],
  })
  return next
}

/** A complete status tells whether a file moved sides or went clean. Prune clean files so drafts cannot reappear on
 * unrelated future changes. */
export function pruneCommentBuckets(buckets: DiffCommentBuckets, repoId: string, changed: (path: string, staged: boolean) => boolean): DiffCommentBuckets {
  let next = buckets
  for (const [key, bucket] of buckets) {
    if (bucket.repoId !== repoId || changed(bucket.path, bucket.staged)) continue
    next = changed(bucket.path, !bucket.staged) ? moveCommentBucket(next, bucket) : removeCommentBucket(next, key)
  }
  return next
}

/** Re-anchor only a unique exact quote on the same side. A collision, truncated diff, redacted quote, or invisible
 * destination leaves the draft available without a line. */
export function anchorMovedComments(buckets: DiffCommentBuckets, key: string, diff: GitDiffView): DiffCommentBuckets {
  const bucket = buckets.get(key)
  if (!bucket?.pending.length) return buckets
  const anchors = new Map<string, DiffCommentAnchor | null>()
  if (diff.kind === 'text' && !diff.truncated) {
    const privateRanges = privateKeyLineRanges(diff.text)
    const lines = numberDiffLines(diff.text.replace(/\r\n/g, '\n').split('\n'))
    lines.forEach((line, order) => {
      const number = line.newLine ?? line.oldLine
      if (number === null || line.position === null) return
      const side = line.newLine === null ? 'old' : 'new'
      const match = `${side}:${line.text}`
      const visible = order < MAX_RENDERED_LINES && !privateRanges.some(([first, last]) => order >= first && order <= last)
      anchors.set(match, visible && !anchors.has(match) ? { side, line: number, order, position: line.position, quote: line.text } : null)
    })
  }
  const items = new Map(bucket.items)
  const unanchored = [...bucket.unanchored]
  for (const comment of bucket.pending) {
    const anchor = comment.redacted ? null : anchors.get(`${comment.side}:${comment.quote}`)
    const anchorKey = anchor && `${anchor.side}:${anchor.line}`
    if (anchor && anchorKey && !items.has(anchorKey)) {
      items.set(anchorKey, { ...comment, line: anchor.line, index: anchor.position })
    } else {
      unanchored.push({ ...comment, line: null, quote: '' })
    }
  }
  const next = new Map(buckets)
  next.set(key, { ...bucket, diffText: bucket.diffText ?? diff.text, items, pending: [], unanchored })
  return next
}

/** Comments in the order they appear in the diff: by position, then a run of deleted lines by old line number. */
export function orderedComments(bucket: DiffCommentBucket): DiffComment[] {
  const anchored = [...bucket.items.values()].sort((left, right) => left.index - right.index || (left.line ?? 0) - (right.line ?? 0))
  return [...anchored, ...bucket.unanchored]
}
