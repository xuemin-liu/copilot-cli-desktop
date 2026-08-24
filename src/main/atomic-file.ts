import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

/** Atomically replace a UTF-8 file, retrying transient Windows rename locks. */
export async function writeFileAtomic(filename: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, filename)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= 4) throw error
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)))
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Move a corrupt file aside without allowing quarantine failure to mask recovery. */
export async function quarantineCorruptFile(filename: string): Promise<void> {
  try {
    await rename(filename, `${filename}.corrupt-${Date.now()}`)
  } catch {
    // Best effort: callers can still recover with a clean in-memory document.
  }
}
