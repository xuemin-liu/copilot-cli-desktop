import type { SessionHistoryEntry } from '../main/types.js'

/** The folder's last segment, for a short project label. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/')) + 1) || trimmed
}

/** The line a session is known by: its name, unless that only repeats the project's folder, then its first prompt. */
export function historyTitle(entry: SessionHistoryEntry): string {
  const generic = !entry.name || (entry.cwd !== null && entry.name.toLowerCase() === folderName(entry.cwd).toLowerCase())
  return (generic ? entry.firstPrompt ?? entry.name : entry.name) ?? entry.sessionId
}

/** Every word of the query must appear somewhere in what the row shows. */
export function filterSessionHistory(entries: SessionHistoryEntry[], query: string): SessionHistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return entries
  return entries.filter((entry) => {
    const text = [entry.name, entry.firstPrompt, entry.lastPrompt, entry.branch, entry.cwd, entry.repository, entry.projectName, entry.sessionId]
      .filter(Boolean).join('\n').toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** When a session was last used, in words: minutes and hours today, then days, then the date. */
export function formatLastUsed(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(at).toLocaleDateString()
}
