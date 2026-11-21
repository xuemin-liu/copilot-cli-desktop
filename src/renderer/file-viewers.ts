/** Turns text into HTML for the File tab. Lives in its own script (viewer-text.js), loaded when first needed. */
export interface TextViewer {
  /** One HTML string per line, escaped and colored for `language` (a highlight.js name) when it is known. */
  highlight(text: string, language: string | null): string[]
  /** Markdown as sanitized HTML: no scripts, forms, styles or frames; pictures carry `data-file-src` and no `src`. */
  markdown(text: string): string
}
export interface FileViewers { text?: TextViewer }
declare global {
  interface Window { copilotFileViewers?: FileViewers }
}

const loading = new Map<string, Promise<unknown>>()

/**
 * Load a viewer's script once and return what it registered. The scripts sit next to app.js, so `script-src 'self'`
 * covers them and nothing is fetched from the network. A failed load can be tried again.
 */
export function loadViewer<Name extends keyof FileViewers>(name: Name): Promise<NonNullable<FileViewers[Name]>> {
  const ready = window.copilotFileViewers?.[name]
  if (ready) return Promise.resolve(ready)
  let pending = loading.get(name) as Promise<NonNullable<FileViewers[Name]>> | undefined
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = `./viewer-${name}.js`
      script.onload = () => {
        const viewer = window.copilotFileViewers?.[name]
        if (viewer) resolve(viewer)
        else { loading.delete(name); reject(new Error('The file viewer did not start')) }
      }
      script.onerror = () => { loading.delete(name); script.remove(); reject(new Error('The file viewer could not be loaded')) }
      document.head.append(script)
    })
    loading.set(name, pending)
  }
  return pending
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Ranges of every place `query` occurs under each scope, ignoring case. Text is searched across element borders inside a
 * scope (a word split by coloring still matches) but never across two scopes. Elements matching `skip` are left out. */
export function findRanges(scopes: Iterable<Element>, query: string, skip: string, limit = 2_000): Range[] {
  const needle = query.toLowerCase()
  const ranges: Range[] = []
  if (!needle) return ranges
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    const nodes: { node: Text; start: number }[] = []
    let text = ''
    for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push({ node: node as Text, start: text.length }); text += (node as Text).data }
    const haystack = text.toLowerCase()
    // Lower-casing can change a string's length (a few letters only); then offsets would not line up, so skip the scope.
    if (haystack.length !== text.length) continue
    let cursor = 0
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      const end = at + needle.length
      while (cursor + 1 < nodes.length && nodes[cursor + 1]!.start <= at) cursor++
      let last = cursor
      while (last + 1 < nodes.length && nodes[last + 1]!.start < end) last++
      const range = document.createRange()
      range.setStart(nodes[cursor]!.node, at - nodes[cursor]!.start)
      range.setEnd(nodes[last]!.node, end - nodes[last]!.start)
      ranges.push(range)
      if (ranges.length >= limit) return ranges
    }
  }
  return ranges
}
