import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A general workspace is for work with no project behind it, such as investigating this computer. A workspace is still a
 * folder, so the desktop makes one from the name the person gives, and each name gets a folder of its own.
 */

export const GENERAL_WORKSPACES_FOLDER = 'Copilot Workspaces'
export const MAX_GENERAL_WORKSPACE_NAME_CHARS = 60
const MAX_NAME_ATTEMPTS = 100
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** A folder name that is valid on every platform; a name with nothing usable in it is refused, not guessed at. */
export function generalWorkspaceFolderName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_GENERAL_WORKSPACE_NAME_CHARS)
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (!cleaned) throw new Error('Enter a workspace name with at least one letter or number.')
  return WINDOWS_RESERVED.test(cleaned) ? `General ${cleaned}` : cleaned
}

/** Makes a new empty folder under `root`. A name already taken gets a number, so a workspace never shares another's folder. */
export async function createGeneralWorkspaceFolder(root: string, name: string): Promise<string> {
  const base = generalWorkspaceFolderName(name)
  await mkdir(root, { recursive: true })
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const folder = join(root, attempt === 1 ? base : `${base} ${attempt}`)
    try {
      await mkdir(folder)
      return folder
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Too many workspaces are named "${base}". Choose another name.`)
}
