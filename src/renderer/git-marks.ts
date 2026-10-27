/** Which list a file was picked from: the staged files, or the working tree (changed and untracked). */
export type MarkSide = 'staged' | 'working'

/** Files picked together for one Stage, Unstage or Discard, all from one side. A Shift+click range starts at `anchor`. */
export interface Marks { side: MarkSide; paths: readonly string[]; anchor: string }

/** A plain click, a Ctrl+click (Cmd on macOS), or a Shift+click. */
export type MarkMode = 'only' | 'toggle' | 'range'

/**
 * The marks after a click on `path` in `list` (the group it is shown in). A plain click picks only that file, Ctrl adds or removes
 * it, and Shift picks every file from the anchor to it when both are in that group. A click on the other side starts again there.
 */
export function nextMarks(marks: Marks | null, side: MarkSide, path: string, list: readonly string[], mode: MarkMode): Marks {
  if (mode === 'only' || marks === null || marks.side !== side) return { side, paths: [path], anchor: path }
  if (mode === 'toggle') {
    const paths = marks.paths.includes(path) ? marks.paths.filter(item => item !== path) : [...marks.paths, path]
    return { side, paths, anchor: path }
  }
  const from = list.indexOf(marks.anchor)
  const to = list.indexOf(path)
  if (from === -1 || to === -1) return { side, paths: [path], anchor: path }
  return { side, paths: list.slice(Math.min(from, to), Math.max(from, to) + 1), anchor: marks.anchor }
}

/** The entries on `side` that the marks still name, in list order: a file staged, unstaged or gone since is left out. */
export function markedEntries<T extends { path: string }>(marks: Marks | null, side: MarkSide, entries: readonly T[]): T[] {
  if (marks === null || marks.side !== side) return []
  const paths = new Set(marks.paths)
  return entries.filter(entry => paths.has(entry.path))
}
