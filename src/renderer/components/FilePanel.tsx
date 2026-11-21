import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { FileViewResult } from '../../main/file-view.js'
import type { ToolTab } from '../../main/tool-tabs.js'
import { errorMessage } from '../errors.js'
import { findRanges, formatFileSize, loadViewer, type PdfHandle, type TextViewer } from '../file-viewers.js'
import { convertOffice, guessDelimiter, parseDelimited, sheetHtml, type OfficeProblem, type SheetData } from '../file-documents.js'
import { sourceWindow } from '../file-source-lines.js'

type Shown = Extract<FileViewResult, { status: 'ok' }>
const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** Watch requests of one tab reach the main process in the order they were made, so a quick hide and show ends watching. */
const watchQueue = new Map<string, Promise<void>>()
function setWatching(profileId: string, tabId: string, on: boolean): void {
  const next = (watchQueue.get(tabId) ?? Promise.resolve()).then(() => window.copilotDesktop.fileWatch(profileId, tabId, on)).catch(() => undefined)
  watchQueue.set(tabId, next)
  void next.then(() => { if (watchQueue.get(tabId) === next) watchQueue.delete(tabId) })
}

/** Different pictures one Markdown file may load, and how many are read at the same time. */
const MARKDOWN_PICTURES = 200
const MARKDOWN_PICTURE_READS = 3

const PDF_PROBLEM = {
  password: 'This document is protected with a password, so it is not shown here.',
  invalid: 'This file is not a readable PDF.',
  'too-large': 'This document has too many pages to show here.',
  failed: 'This document could not be shown.',
} as const
const NO_BYTES = new Uint8Array(0)
const OFFICE_PROBLEM: Record<OfficeProblem, string> = {
  invalid: 'This file could not be read as a document of its kind.',
  'too-large': 'This document is too large, or took too long, to show here.',
  protected: 'This document is protected with a password, so it is not shown here.',
  failed: 'This document could not be shown.',
}
/** What a Word or Excel file became: HTML for a document, sheets for a workbook, or why it could not be read. */
type OfficeView = { html: string } | { sheets: SheetData[] } | { problem: OfficeProblem }

const CARD_REASON = {
  unsupported: 'There is no viewer for this kind of file.',
  binary: 'This file is not text, so it is not shown.',
  'too-large': 'This file is too large to show here.',
} as const
const GONE = {
  missing: 'This file no longer exists.',
  'root-missing': 'The folder this file was in is no longer part of this workspace.',
  outside: 'This file is outside the workspace, so it is not shown.',
  directory: 'This is a folder, not a file.',
} as const

interface Props { profileId: string; tab: ToolTab; active: boolean; onClose(): void }

/** Shows one file in the right panel: rendered Markdown, colored code, a picture, or a card for anything else. */
export function FilePanel({ profileId, tab, active, onClose }: Props): JSX.Element {
  const [view, setView] = useState<FileViewResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [source, setSource] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  const [viewer, setViewer] = useState<TextViewer | null>(() => window.copilotFileViewers?.text ?? null)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState({ index: 0, count: 0 })
  const request = useRef(0)
  const shown = useRef<string | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const ranges = useRef<Range[]>([])
  const [pdfPage, setPdfPage] = useState<{ current: number; total: number } | null>(null)
  const [pdfProblem, setPdfProblem] = useState<keyof typeof PDF_PROBLEM | null>(null)
  // A PDF's bytes are kept out of React state: they are handed to the viewer once and not held twice.
  const pdfBytes = useRef<Uint8Array | null>(null)
  // Counts accepted reads of a PDF. The view is opened once for each, so Reload opens the fresh bytes even when the
  // file's time and size are what they were, and a view that failed to open is tried again.
  const [pdfRead, setPdfRead] = useState(0)
  // Counts views that became ready. An open find is run again in each new view, which starts with no matches.
  const [pdfReady, setPdfReady] = useState(0)
  const [office, setOffice] = useState<OfficeView | null>(null)
  const [sheet, setSheet] = useState(0)
  const pdfBox = useRef<HTMLDivElement>(null)
  const pdfView = useRef<PdfHandle | null>(null)
  const jumped = useRef(0)

  const load = useCallback(async (force: boolean): Promise<void> => {
    const current = ++request.current
    try {
      const result = await window.copilotDesktop.fileRead(profileId, tab.id, force ? null : shown.current)
      // A read that finishes after a newer one started would put old content back.
      if (current !== request.current || result.status === 'unchanged') return
      shown.current = result.status === 'ok' ? result.revision : null
      if (result.status === 'ok' && (result.kind === 'pdf' || result.kind === 'docx' || result.kind === 'xlsx')) { pdfBytes.current = result.bytes; setPdfRead(count => count + 1); setView({ ...result, bytes: NO_BYTES }) }
      else { pdfBytes.current = null; setView(result) }
      setFailure(null)
    } catch (error) { if (current === request.current) setFailure(errorMessage(error)) }
  }, [profileId, tab.id])

  // Read when shown, and again every time the tab is shown: nothing watches the file while it is hidden.
  useEffect(() => {
    if (!active) return
    void load(false)
    setWatching(profileId, tab.id, true)
    // Told to read again: also ask to be watched again. A change of Settings > File links can have stopped the watch of
    // this tab while it stayed on screen; the main process watches only a file it allows, and the same path is kept as is.
    const stop = window.copilotDesktop.onFileChanged(id => { if (id === tab.id) { void load(false); setWatching(profileId, tab.id, true) } })
    return () => { stop(); setWatching(profileId, tab.id, false) }
  }, [active, load, profileId, tab.id])

  const file = view?.status === 'ok' ? view : null
  const text = file && (file.kind === 'text' || file.kind === 'markdown' || file.kind === 'csv' || file.kind === 'notebook') ? file : null
  // Markdown, CSV and notebooks have a rendered view and their text as the Source view.
  const rendered = text !== null && text.kind !== 'text' && !source
  const binary = file && (file.kind === 'docx' || file.kind === 'xlsx') ? file : null
  const officeRevision = binary?.revision ?? null
  const officeKind = binary?.kind ?? null

  // Word and Excel files are read in a worker, once for each read of the file. Leaving the tab, or a newer read, ends
  // the worker whatever it is doing.
  useEffect(() => {
    const bytes = pdfBytes.current
    if (!officeRevision || !officeKind) { setOffice(null); return }
    if (!bytes) return
    pdfBytes.current = null
    let current = true
    const job = convertOffice(officeKind, bytes)
    void job.result.then(reply => {
      if (!current) return
      setOffice(reply.ok ? reply.kind === 'docx' ? { html: reply.html } : { sheets: reply.sheets } : { problem: reply.problem })
      if (reply.ok && reply.kind === 'xlsx') setSheet(shown => Math.min(shown, Math.max(0, reply.sheets.length - 1)))
    })
    return () => { current = false; job.cancel() }
  }, [officeRevision, officeKind, pdfRead])
  const pdf = file?.kind === 'pdf' ? file : null
  const pdfRevision = pdf?.revision ?? null

  // Open the document when it is first read and again whenever the file changes, staying on the page in view.
  useEffect(() => {
    const container = pdfBox.current, bytes = pdfBytes.current
    if (!pdfRevision) { pdfView.current?.close(); pdfView.current = null; setPdfPage(null); setPdfProblem(null); return }
    if (!container || !bytes) return
    pdfBytes.current = null
    let current = true
    loadViewer('pdf').then(loaded => {
      if (!current) return
      const page = pdfView.current?.page ?? 1
      pdfView.current?.close()
      setPdfProblem(null)
      // The old view's matches belong to the old document.
      setMatch({ index: 0, count: 0 })
      pdfView.current = loaded.open(container, bytes, {
        ready: () => { if (current) setPdfReady(count => count + 1) },
        page: (now, total) => { if (current) setPdfPage({ current: now, total }) },
        found: (now, total) => { if (current) setMatch({ index: Math.max(0, now - 1), count: total }) },
        failed: reason => { if (current) { setPdfProblem(reason); setPdfPage(null) } },
      }, page)
    }, error => { if (current) { setPdfProblem('failed'); setNotice(errorMessage(error)) } })
    return () => { current = false }
  }, [pdfRevision, pdfRead])
  useEffect(() => () => { pdfView.current?.close(); pdfView.current = null }, [])
  // Pages cannot be laid out while the tab is hidden; do it when the tab is shown.
  useEffect(() => { if (active) pdfView.current?.shown() }, [active])
  useEffect(() => {
    if ((!text && officeKind !== 'docx') || viewer) return
    let current = true
    loadViewer('text').then(loaded => { if (current) setViewer(loaded) }, error => { if (current) setNotice(errorMessage(error)) })
    return () => { current = false }
  }, [text, officeKind, viewer])

  // A click on a path with a line shows that line, in the source view; clicking the same line again shows it again.
  const jump = tab.file?.jump ?? 0, line = tab.file?.line
  const target = jump > 0 ? line : undefined
  useEffect(() => { if (jump > 0 && line) setSource(true) }, [jump, line])
  const codeHtml = useMemo(() => {
    if (!text || rendered) return ''
    const lines = viewer ? viewer.highlight(text.text, text.language) : text.text.replace(/\r\n?/g, '\n').split('\n').map(escapeHtml)
    // A very long file is drawn in part: see `sourceWindow`. Line numbers stay the file's own.
    const shown = sourceWindow(lines.length, target)
    const note = shown.note ? `<div class="file-line-note" role="status">${escapeHtml(shown.note)}</div>` : ''
    // The line a click pointed at is marked in the HTML itself, so it is still marked after the file is read again.
    return note + lines.slice(shown.start, shown.end).map((line, offset) => {
      const number = shown.start + offset + 1
      return `<div class="file-line${number === target ? ' file-line-target' : ''}"><span class="file-ln">${number}</span><span class="file-lc">${line || ' '}</span></div>`
    }).join('') + note
  }, [text, rendered, viewer, target])
  // The rendered view as HTML; null while it is not ready. A notebook that cannot be rendered is shown as its source.
  const [renderProblem, setRenderProblem] = useState<string | null>(null)
  const sheets = office && 'sheets' in office ? office.sheets : null
  // A notebook is rendered once for each read of its text: its HTML, or why it could not be rendered.
  const notebookView = useMemo(() => {
    if (!viewer || text?.kind !== 'notebook') return null
    try { return { html: viewer.notebook(text.text), problem: null } } catch (error) { return { html: null, problem: errorMessage(error) } }
  }, [viewer, text])
  const markdownHtml = useMemo(() => {
    if (office && !('problem' in office)) return 'html' in office ? viewer ? viewer.document(office.html) : null : sheetHtml(office.sheets[sheet] ?? office.sheets[0]!, false)
    if (!rendered || !text) return null
    if (text.kind === 'csv') return sheetHtml(parseDelimited(text.text, /\.(?:tsv|tab)$/i.test(text.name) ? '\t' : guessDelimiter(text.text)), true)
    if (text.kind === 'notebook') return notebookView?.html ?? null
    return viewer ? viewer.markdown(text.text) : null
  }, [rendered, viewer, text, office, sheet, notebookView])
  // A notebook that cannot be rendered (not JSON, not a notebook, too large) is shown as its text, with the reason.
  useEffect(() => {
    const problem = notebookView?.problem ?? null
    setRenderProblem(problem ? `${problem} Showing its source.` : null)
    if (problem) setSource(true)
  }, [notebookView])

  // Pictures in Markdown: local ones come through the main process; remote ones are never fetched.
  useEffect(() => {
    const root = body.current
    if (markdownHtml === null || !root) return
    let current = true
    const wanted = new Map<string, ((dataUrl: string | null) => void)[]>()
    for (const image of root.querySelectorAll<HTMLImageElement>('img[data-file-src]')) {
      const href = image.dataset.fileSrc ?? ''
      const remote = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)
      const replace = (label: string): void => {
        const note = document.createElement(remote && /^https?:/i.test(href) ? 'a' : 'span')
        note.className = 'file-image-note'
        note.textContent = `${image.alt || 'Picture'} (${label})`
        if (note instanceof HTMLAnchorElement) note.href = href
        image.replaceWith(note)
      }
      if (remote) { replace('picture on the web, not loaded'); continue }
      const show = (dataUrl: string | null): void => {
        if (!image.isConnected) return
        if (dataUrl) image.src = dataUrl
        else replace('picture not found')
      }
      const waiting = wanted.get(href)
      if (waiting) waiting.push(show)
      else if (wanted.size < MARKDOWN_PICTURES) wanted.set(href, [show])
      else replace('picture not loaded: too many in this file')
    }
    // Each picture is read once however often the file shows it, and only a few are read at a time: every read holds
    // the whole picture in memory in both processes.
    const queue = [...wanted]
    const next = (): void => {
      const entry = current ? queue.shift() : undefined
      if (!entry) return
      const [href, shows] = entry
      void window.copilotDesktop.fileAsset(profileId, tab.id, href).catch(() => null).then(dataUrl => {
        if (current) for (const show of shows) show(dataUrl)
        next()
      })
    }
    for (let reader = 0; reader < MARKDOWN_PICTURE_READS; reader++) next()
    return () => { current = false }
  }, [markdownHtml, profileId, tab.id])

  // Scroll once for each click. A refresh after an edit keeps the mark but leaves the view where it is.
  useEffect(() => {
    if (!codeHtml || !active || jump === 0 || jumped.current === jump) return
    const marked = body.current?.querySelector('.file-line-target')
    if (!marked) return
    marked.scrollIntoView({ block: 'center' })
    jumped.current = jump
  }, [codeHtml, jump, active])

  // Find: marks are drawn with the CSS highlight registry, so the file's own HTML is never changed.
  const richView = rendered || (office !== null && !('problem' in office))
  const content = richView ? markdownHtml : codeHtml
  useEffect(() => {
    const root = body.current
    const registry = typeof CSS === 'undefined' ? undefined : CSS.highlights
    // A PDF marks its own matches, in its text layer.
    if (!registry || pdfRevision) return
    // Every File tab draws with the same two names, so only the tab that is shown may touch them: a hidden tab with its
    // own find open would otherwise wipe the marks the shown tab has just drawn.
    if (!active) { ranges.current = []; setMatch({ index: 0, count: 0 }); return }
    registry.delete('file-find'); registry.delete('file-find-current')
    ranges.current = []
    if (!root || !finding || !query || !content) { setMatch({ index: 0, count: 0 }); return }
    const found = findRanges(richView ? [root] : root.querySelectorAll('.file-lc'), query, '.file-ln, .file-row-number')
    ranges.current = found
    if (found.length) registry.set('file-find', new Highlight(...found))
    setMatch({ index: 0, count: found.length })
    return () => { registry.delete('file-find'); registry.delete('file-find-current') }
  }, [active, finding, query, content, richView, pdfRevision])
  useEffect(() => {
    if (!pdfRevision || pdfProblem) return
    const timer = setTimeout(() => pdfView.current?.find(finding ? query : ''), 150)
    return () => clearTimeout(timer)
  }, [pdfRevision, pdfProblem, pdfReady, finding, query])
  useEffect(() => {
    const registry = typeof CSS === 'undefined' ? undefined : CSS.highlights
    const range = ranges.current[match.index]
    if (!registry || pdfRevision || !active) return
    registry.delete('file-find-current')
    if (!range || !finding) return
    registry.set('file-find-current', new Highlight(range))
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [match, finding, pdfRevision, active])
  const step = (by: number): void => pdfRevision ? pdfView.current?.find(query, by < 0) : setMatch(current => current.count ? { ...current, index: (current.index + by + current.count) % current.count } : current)
  const openFind = (): void => { setFinding(true); requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select() }) }
  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && (text || pdf || richView || finding)) { event.preventDefault(); event.stopPropagation(); openFind() }
    else if (event.key === 'Escape' && finding) { event.preventDefault(); setFinding(false); (pdf ? pdfBox : body).current?.focus() }
  }

  const command = (name: 'reveal' | 'open' | 'copy-path'): void => {
    setNotice(null)
    void window.copilotDesktop.fileCommand(profileId, tab.id, name).then(() => { if (name === 'copy-path') setNotice('Path copied') }, error => setNotice(errorMessage(error)))
  }
  // Links never navigate this window: web links go to the system browser, links to other files open in a File tab.
  const onLink = (event: ReactMouseEvent): void => {
    const anchor = (event.target as Element).closest?.('a')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (event.type !== 'click' || !href) return
    if (href.startsWith('#')) {
      let id = href.slice(1)
      try { id = decodeURIComponent(id) } catch { /* Keep the raw anchor. */ }
      body.current?.querySelector(`#${CSS.escape(`user-content-${id}`)}`)?.scrollIntoView({ block: 'start' })
    } else if (/^https?:/i.test(href)) void window.copilotDesktop.openExternalUrl(href).catch(error => setNotice(errorMessage(error)))
    else if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
      let path = href.split(/[?#]/)[0] ?? ''
      try { path = decodeURIComponent(path) } catch { /* Keep the raw path. */ }
      if (!path) return
      void window.copilotDesktop.openFile({ profileId, fileTabId: tab.id }, path).then(result => {
        if (!result.ok) setNotice(result.reason === 'missing' ? `File not found: ${path}` : result.reason === 'limit' ? result.message ?? 'Too many files are open.' : `Only files in the workspace can be opened: ${path}`)
      }, error => setNotice(errorMessage(error)))
    }
  }

  const path = tab.file?.path ?? tab.title
  return <div className="file-panel" onKeyDown={onKeyDown}>
    <div className="file-panel-header">
      <div className="file-panel-title" title={file?.path ?? path}>
        <strong>{tab.title}</strong>
        <span>{path}{file ? ` · ${formatFileSize(file.size)}` : ''}{pdf && pdfPage ? ` · page ${pdfPage.current} of ${pdfPage.total}` : ''}</span>
      </div>
      <div className="file-panel-actions">
        {text && text.kind !== 'text' && !renderProblem && <button type="button" aria-pressed={source} title={source ? 'Show the rendered view' : 'Show the text of the file'} onClick={() => setSource(value => !value)}>{source ? text.kind === 'csv' ? 'Table' : 'Rendered' : 'Source'}</button>}
        {text && !rendered && <button type="button" aria-pressed={wrap} title="Wrap long lines" onClick={() => setWrap(value => !value)}>Wrap</button>}
        {file?.kind === 'image' && <button type="button" aria-pressed={actualSize} title={actualSize ? 'Fit the picture to the panel' : 'Show the picture at its own size'} onClick={() => setActualSize(value => !value)}>{actualSize ? 'Fit' : 'Actual size'}</button>}
        {pdf && !pdfProblem && <>
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => pdfView.current?.zoom(-1)}>−</button>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => pdfView.current?.zoom(1)}>+</button>
          <button type="button" title="Fit the page to the panel's width" onClick={() => pdfView.current?.zoom(0)}>Fit width</button>
        </>}
        {(text || richView || (pdf && !pdfProblem)) && <button type="button" title="Find in this file (Ctrl+F)" onClick={openFind}>Find</button>}
        <button type="button" title="Read the file again" onClick={() => { setNotice(null); void load(true) }}>Reload</button>
        {file && <button type="button" title={file.path} onClick={() => command('copy-path')}>Copy path</button>}
        {file && <button type="button" onClick={() => command('reveal')}>Reveal in folder</button>}
        {file?.openable && <button type="button" onClick={() => command('open')}>Open with default app</button>}
      </div>
    </div>
    {finding && (text || richView || (pdf && !pdfProblem)) && <div className="file-find" role="search">
      <input ref={findInput} aria-label="Find in file" placeholder="Find" value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1) } }} />
      <span role="status">{query ? match.count ? `${match.index + 1} of ${match.count}${match.count >= 2_000 ? '+' : ''}` : 'No results' : ''}</span>
      <button type="button" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!match.count} onClick={() => step(-1)}>↑</button>
      <button type="button" aria-label="Next match" title="Next (Enter)" disabled={!match.count} onClick={() => step(1)}>↓</button>
      <button type="button" aria-label="Close find" onClick={() => setFinding(false)}>×</button>
    </div>}
    {(notice || failure || renderProblem) && <div className="file-panel-notice" role="status">{failure ?? notice ?? renderProblem}</div>}
    {view === null && !failure && <div className="file-panel-status" role="status">Opening…</div>}
    {view && view.status !== 'ok' && view.status !== 'unchanged' && <div className="file-panel-status" role="status">
      <p>{GONE[view.status]}</p><p className="file-panel-path">{path}</p>
      <div><button type="button" onClick={() => { void load(true) }}>Try again</button><button type="button" onClick={onClose}>Close tab</button></div>
    </div>}
    {file?.kind === 'other' && <div className="file-card">
      <strong>{file.name}</strong>
      <dl><dt>Size</dt><dd>{formatFileSize(file.size)}</dd><dt>Changed</dt><dd>{new Date(file.mtimeMs).toLocaleString()}</dd></dl>
      <p>{CARD_REASON[file.reason]}</p>
      <div><button type="button" onClick={() => command('reveal')}>Reveal in folder</button>
        {file.openable && <button type="button" onClick={() => command('open')}>Open with default app</button>}</div>
    </div>}
    {binary && office === null && <div className="file-panel-status" role="status">Opening…</div>}
    {binary && office && 'problem' in office && <div className="file-card">
      <strong>{binary.name}</strong>
      <p>{OFFICE_PROBLEM[office.problem]}</p>
      <div><button type="button" onClick={() => command('reveal')}>Reveal in folder</button>
        {binary.openable && <button type="button" onClick={() => command('open')}>Open with default app</button>}</div>
    </div>}
    {sheets && sheets.length > 1 && <div className="file-sheet-tabs" role="tablist" aria-label="Sheets">
      {sheets.map((entry, index) => <button type="button" role="tab" key={index} aria-selected={index === sheet} onClick={() => setSheet(index)}>{entry.name}</button>)}
    </div>}
    {binary && office && !('problem' in office) && (markdownHtml === null
      ? <div className="file-panel-status" role="status">Opening…</div>
      : <div className={`file-markdown ${sheets ? 'file-table-view' : 'file-document'}`} tabIndex={0} ref={body} onClick={onLink} onAuxClick={onLink} dangerouslySetInnerHTML={{ __html: markdownHtml }} />)}
    {pdf && pdfProblem && <div className="file-card">
      <strong>{pdf.name}</strong>
      <p>{PDF_PROBLEM[pdfProblem]}</p>
      <div><button type="button" onClick={() => command('reveal')}>Reveal in folder</button>
        {pdf.openable && <button type="button" onClick={() => command('open')}>Open with default app</button>}</div>
    </div>}
    {pdf && <div className="file-pdf" hidden={pdfProblem !== null}>
      <div className="file-pdf-pages" ref={pdfBox} tabIndex={0} role="region" aria-label={`Pages of ${tab.title}`} />
    </div>}
    {file?.kind === 'image' && <div className={`file-image${actualSize ? ' file-image-actual' : ''}`} tabIndex={0} ref={body}>
      <img src={file.dataUrl} alt={file.name} draggable={false} />
    </div>}
    {text && rendered && (markdownHtml === null
      ? <div className="file-panel-status" role="status">Opening…</div>
      : <div className={`file-markdown${text.kind === 'csv' ? ' file-table-view' : text.kind === 'notebook' ? ' file-notebook' : ''}`} tabIndex={0} ref={body} onClick={onLink} onAuxClick={onLink} dangerouslySetInnerHTML={{ __html: markdownHtml }} />)}
    {text && !rendered && <div className={`file-code${wrap ? ' file-code-wrap' : ''}`} tabIndex={0} ref={body} role="region" aria-label={`Contents of ${tab.title}`}
      dangerouslySetInnerHTML={{ __html: codeHtml }} />}
  </div>
}
