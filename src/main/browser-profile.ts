import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export function normalizeBrowserProfileId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase() : undefined
}

/** The browser profile every session's browser uses when the shared browser profile is selected. It is never a tab's own. */
export const SHARED_BROWSER_PROFILE_ID = '00000000-0000-4000-8000-000000000000'

/** Saved terminal tabs retain their browser profile; new or duplicated tabs get their own. */
export function selectBrowserProfileId(saved: unknown, used: Iterable<string | undefined>): string {
  const reserved = new Set([...used, SHARED_BROWSER_PROFILE_ID])
  const id = normalizeBrowserProfileId(saved)
  if (id && !reserved.has(id)) return id
  let fresh: string
  do { fresh = randomUUID() } while (reserved.has(fresh))
  return fresh
}

export function browserProfilePaths(userData: string, profileId: string): { settings: string; partition: string; devtoolsPartition: string } {
  const id = normalizeBrowserProfileId(profileId)
  if (!id) throw new Error('Invalid browser profile')
  return { settings: join(userData, 'browser-profiles', id, 'settings.json'), partition: `persist:browser-debug:${id}`,
    // A session with Local Overrides of its own runs DevTools here, so the folders it adds stay its own.
    devtoolsPartition: `persist:browser-devtools:${id}` }
}
