import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

/**
 * Node's file system as it is, without Electron's `.asar` handling.
 *
 * Inside Electron, `fs` treats a file named `*.asar` as a folder: a single `lstat`, `stat` or `readdir` of it opens the
 * archive and keeps it open for the life of the process, and a recursive `rm` of a folder that contains one first
 * waits on it, then fails with EBUSY, and leaves the file locked by the desktop itself, so nothing can delete it any
 * more. A checkout in which `pnpm install` ran has one (`electron/dist/resources/default_app.asar`). Code that walks
 * or deletes a folder it did not make the contents of uses this instead. Outside Electron (the tests) it is Node's own.
 */
function load(): typeof nodeFs {
  if (!process.versions.electron) return nodeFs
  try { return createRequire(import.meta.url)('original-fs') as typeof nodeFs } catch { return nodeFs }
}

export const plainFs: typeof nodeFs = load()
