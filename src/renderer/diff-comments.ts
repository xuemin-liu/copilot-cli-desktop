import { privateKeyLineRanges } from '../main/git-prompt.js'
import type { DiffComment } from '../main/git-prompt.js'
import type { DiffCommentAnchor } from './components/GitDiffView.js'

/** The comments on one file and side, and the diff text the first of them was written against (to warn when it changes). */
export interface DiffCommentBucket {
  repoId: string
  path: string
  staged: boolean
  diffText: string
  items: Map<string, DiffComment>
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
    items.set(commentKey, { side: anchor.side, line: anchor.line, quote: redacted ? '' : anchor.quote, redacted, index: anchor.order, text })
  }
  if (items.size === 0) next.delete(key)
  else next.set(key, { ...target, diffText: current?.diffText ?? diffText, items })
  return next
}

export function removeCommentBucket(buckets: DiffCommentBuckets, key: string): DiffCommentBuckets {
  if (!buckets.has(key)) return buckets
  const next = new Map(buckets)
  next.delete(key)
  return next
}

/** Drop every bucket of `repoId` whose file is no longer in the changed list for its side, so comments on a reverted or
 * committed change never come back when the file changes again later. `changed` answers for a complete status only;
 * the caller skips this for a cut-off list, where absence proves nothing. */
export function pruneCommentBuckets(buckets: DiffCommentBuckets, repoId: string, changed: (path: string, staged: boolean) => boolean): DiffCommentBuckets {
  let next: Map<string, DiffCommentBucket> | null = null
  for (const [key, bucket] of buckets) {
    if (bucket.repoId !== repoId || changed(bucket.path, bucket.staged)) continue
    next ??= new Map(buckets)
    next.delete(key)
  }
  return next ?? buckets
}

/** Comments in the order they appear in the diff. */
export function orderedComments(bucket: DiffCommentBucket): DiffComment[] {
  return [...bucket.items.values()].sort((left, right) => left.index - right.index)
}
