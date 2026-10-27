/** Lower-cased words of a settings search; empty when the query is blank. */
export function searchTerms(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

/** Text matches when it contains every term, in any order, so "tray close" finds "When the main window closes … tray". */
export function matchesSearch(text: string, terms: readonly string[]): boolean {
  const haystack = text.toLocaleLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** Where each term occurs in text, for highlighting. Hits of different terms may overlap. */
export function searchHits(text: string, terms: readonly string[]): Array<{ start: number; end: number }> {
  const haystack = text.toLocaleLowerCase()
  const hits: Array<{ start: number; end: number }> = []
  for (const term of terms) {
    for (let start = haystack.indexOf(term); start !== -1; start = haystack.indexOf(term, start + term.length)) {
      hits.push({ start, end: start + term.length })
    }
  }
  return hits
}
