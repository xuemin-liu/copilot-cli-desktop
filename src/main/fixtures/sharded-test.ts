import test from 'node:test'

/**
 * Splits one large, slow test module across several test files so the runner can execute them in parallel processes.
 * Node runs the top-level tests of a file one after another, so a file of 130 tests that each start real `git` processes
 * becomes the long pole of the whole suite. A shard file calls `setTestShard` and then imports the module; the module
 * declares its tests with `shardedTest`, which registers only every `count`-th test starting at `index`.
 * Without a shard set (the module imported on its own), every test registers.
 */

interface Shard { index: number; count: number }

let shard: Shard | null = null
let declared = 0

export function setTestShard(index: number, count: number): void {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) throw new Error(`Invalid test shard ${index} of ${count}`)
  shard = { index, count }
  declared = 0
}

/** `test` from node:test, registered only when the next declaration belongs to this process's shard. */
export const shardedTest = ((...args: Parameters<typeof test>) => {
  const position = declared++
  if (shard && position % shard.count !== shard.index) return undefined
  return test(...args)
}) as typeof test
