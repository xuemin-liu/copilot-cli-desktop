export const FILTER_PRESETS = [
  { label: 'Error',   color: '#ff7b72', pattern: 'error|errors|failed|failure|fatal|exception|traceback|critical' },
  { label: 'Warning', color: '#d29922', pattern: 'warning|warnings|warn|deprecated|caution' },
  { label: 'Info',    color: '#39c5cf', pattern: 'info|note|hint|notice' },
  { label: 'Success', color: '#3fb950', pattern: 'success|succeeded|done|ok|passed|complete|completed' },
]

export function parseFilter(text, isRegex) {
  if (!text.trim()) return { includeRe: null, excludeRe: null, error: null }
  const terms = text.split('|').map((t) => t.trim()).filter(Boolean)
  const includeTerms = []
  const excludeTerms = []
  for (const term of terms) {
    if ((term.startsWith('-') || term.startsWith('!')) && term.length > 1) {
      excludeTerms.push(term.slice(1))
    } else {
      includeTerms.push(term)
    }
  }
  const toPattern = (t) => isRegex ? t : t.replace(/[.*+?^${}()[\]\\]/g, '\\$&')
  try {
    const includeRe = includeTerms.length ? new RegExp(includeTerms.map(toPattern).join('|'), 'i') : null
    const excludeRe = excludeTerms.length ? new RegExp(excludeTerms.map(toPattern).join('|'), 'i') : null
    return { includeRe, excludeRe, error: null }
  } catch (e) {
    return { includeRe: null, excludeRe: null, error: e.message }
  }
}

export function matchesFilter(line, includeRe, excludeRe) {
  if (!includeRe && !excludeRe) return false
  if (includeRe && !includeRe.test(line)) return false
  if (excludeRe && excludeRe.test(line)) return false
  return true
}

export function colorizeOutput(text) {
  const parts = text.split(/(\x1b\[[0-9;]*m)/)
  let insideColor = false
  return parts.map((part) => {
    if (/^\x1b\[/.test(part)) {
      insideColor = part !== '\x1b[0m' && part !== '\x1b[m'
      return part
    }
    if (insideColor) return part
    return part
      .replace(/\b(error|errors|failed|failure|fatal|exception|traceback|critical)\b/gi, '\x1b[1;31m$1\x1b[0m')
      .replace(/\b(warning|warnings|warn|deprecated|caution)\b/gi, '\x1b[1;33m$1\x1b[0m')
      .replace(/\b(info|note|hint|notice)\b/gi, '\x1b[36m$1\x1b[0m')
      .replace(/\b(success|succeeded|done|ok|passed|complete|completed)\b/gi, '\x1b[32m$1\x1b[0m')
  }).join('')
}

export const stripAnsi = (s) => s
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  .replace(/\x1b[()][0-9A-Z]/g, '')
