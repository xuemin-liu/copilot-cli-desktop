import type { DiffComment } from '../main/git-prompt.js'
import type { DiffCommentAnchor } from './components/GitDiffView.js'

/** The comments on one file and side, and the diff text they were written against (to warn when it changes). */
export interface DiffCommentBucket {
  diffText: string
  items: Map<string, DiffComment>
}

/** Buckets keyed by `${repoId}:${path}:${staged}`. Each file and side keeps its own comments until it is cleared or the
 * file is no longer changed, so a review that moves between files loses nothing. */
export type DiffCommentBuckets = ReadonlyMap<string, DiffCommentBucket>

export function bucketKey(repoId: string, path: string, staged: boolean): string {
  return `${repoId}:${path}:${staged}`
}

/** Set (`text`) or remove (`null`) one comment in one bucket; every other bucket is untouched. A bucket with no comments
 * left is dropped. The diff text is recorded when the bucket is created and kept afterwards: it is the baseline. */
export function updateCommentBucket(buckets: DiffCommentBuckets, key: string, diffText: string, commentKey: string, anchor: DiffCommentAnchor, text: string | null): DiffCommentBuckets {
  const next = new Map(buckets)
  const current = buckets.get(key)
  const items = new Map(current?.items ?? [])
  if (text === null) items.delete(commentKey)
  else items.set(commentKey, { side: anchor.side, line: anchor.line, quote: anchor.quote, index: anchor.order, text })
  if (items.size === 0) next.delete(key)
  else next.set(key, { diffText: current?.diffText ?? diffText, items })
  return next
}

export function removeCommentBucket(buckets: DiffCommentBuckets, key: string): DiffCommentBuckets {
  if (!buckets.has(key)) return buckets
  const next = new Map(buckets)
  next.delete(key)
  return next
}

/** Comments in the order they appear in the diff. */
export function orderedComments(bucket: DiffCommentBucket): DiffComment[] {
  return [...bucket.items.values()].sort((left, right) => left.index - right.index)
}
