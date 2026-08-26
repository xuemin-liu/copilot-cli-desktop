export interface DetectedLink {
  type: 'url' | 'path'
  text: string
  start: number
  end: number
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g
// Matches an absolute Windows/UNC path or an explicit relative path (./, ../),
// or a bare relative path that has at least one separator and a file
// extension (the common shape of paths CLI tools print, e.g. "dist\app.js").
const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\[\w.-]+[\\/]|\.{1,2}[\\/])[^\s<>"'`|]+|(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,10}/g

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[).,;:!?'"\]]+$/, '')
}

export function scanLineForLinks(line: string): DetectedLink[] {
  const links: DetectedLink[] = []
  for (const match of line.matchAll(URL_PATTERN)) {
    const text = trimTrailingPunctuation(match[0])
    if (text.length > 0) links.push({ type: 'url', text, start: match.index, end: match.index + text.length })
  }
  for (const match of line.matchAll(PATH_PATTERN)) {
    const text = trimTrailingPunctuation(match[0])
    const start = match.index
    const end = start + text.length
    if (text.length < 3) continue
    if (links.some((existing) => start < existing.end && end > existing.start)) continue
    links.push({ type: 'path', text, start, end })
  }
  return links.sort((left, right) => left.start - right.start)
}

export function linkAtColumn(line: string, column: number): DetectedLink | null {
  return scanLineForLinks(line).find((link) => column >= link.start && column < link.end) ?? null
}
