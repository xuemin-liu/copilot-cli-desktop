// Loaded only when a PDF is first opened (see ../file-viewers.ts). The document is parsed in a worker that has no DOM and
// no access to the app's API; this file only draws pages and the text layer that makes them selectable and searchable.
import './pdf-global.js'
import { AnnotationMode, getDocument, PDFWorker } from 'pdfjs-dist'
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import type { PdfHandle, PdfViewer, PdfViewerEvents } from '../file-viewers.js'

/** A page is drawn on a canvas of at most this many pixels, however far it is zoomed; beyond it the canvas is scaled up. */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024
/** An image inside a document larger than this many pixels is not decoded. */
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024
/** Documents with more pages than this are not shown: every page costs layout and memory even before it is drawn. */
const MAX_PAGES = 5_000

/** PDF.js asks for character maps, standard fonts and image decoders by name. They ship with the app and come through
 * the main process, so neither the window nor the worker fetches anything. */
class ShippedData {
  async fetch({ kind, filename }: { kind: 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'; filename: string }): Promise<Uint8Array> {
    return window.copilotDesktop.viewerAsset(kind, filename)
  }
}

function open(container: HTMLDivElement, bytes: Uint8Array, events: PdfViewerEvents, startPage = 1): PdfHandle {
  // Each open document has a worker of its own. Closing the document ends the worker, which stops whatever it was
  // parsing and gives its memory back.
  const thread = new Worker('./viewer-pdf-worker.js')
  const worker = new PDFWorker({ port: thread as unknown as null })
  const pages = document.createElement('div')
  pages.className = 'pdfViewer'
  container.replaceChildren(pages)
  const eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus })
  const findController = new PDFFindController({ eventBus, linkService })
  // Everything PDF.js attaches to the container (its scroll listener, its resize observer, selection listeners) is tied
  // to this signal, so closing the view takes all of it away. A refresh closes one view and opens another on the same
  // container; without this each refresh would leave a set of listeners behind.
  const teardown = new AbortController()
  const viewer = new PDFViewer({
    container, viewer: pages, eventBus, linkService, findController, abortSignal: teardown.signal,
    // Text layer on, so text can be selected and searched. No annotation layer: links, forms and scripts in a document
    // are never made live.
    textLayerMode: 1, annotationMode: AnnotationMode.DISABLE, enableAutoLinking: false,
    maxCanvasPixels: MAX_CANVAS_PIXELS,
  } as ConstructorParameters<typeof PDFViewer>[0])
  linkService.setViewer(viewer)
  let closed = false
  let fitted = true
  const task = getDocument({
    data: bytes, worker, BinaryDataFactory: ShippedData, useWorkerFetch: false, cMapPacked: true,
    enableXfa: false, disableWorkerRendering: true, maxImageSize: MAX_IMAGE_PIXELS, verbosity: 0,
  })
  // A protected document is not asked for its password here; it gets the card instead.
  task.onPassword = () => { if (!closed) events.failed('password'); void task.destroy() }
  eventBus.on('pagesinit', () => {
    viewer.currentScaleValue = 'page-width'
    if (startPage > 1 && startPage <= viewer.pagesCount) viewer.currentPageNumber = startPage
    events.page(viewer.currentPageNumber, viewer.pagesCount)
  })
  eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => events.page(pageNumber, viewer.pagesCount))
  const found = ({ matchesCount }: { matchesCount?: { current: number; total: number } }): void => {
    if (matchesCount) events.found(matchesCount.current, matchesCount.total)
  }
  eventBus.on('updatefindmatchescount', found)
  eventBus.on('updatefindcontrolstate', found)
  task.promise.then(document => {
    if (closed) return
    if (document.numPages > MAX_PAGES) { events.failed('too-large'); void task.destroy(); return }
    viewer.setDocument(document)
    linkService.setDocument(document, null)
  }, (error: unknown) => {
    if (closed) return
    const name = (error as { name?: string } | null)?.name
    if (name !== 'PasswordException') events.failed(name === 'InvalidPDFException' ? 'invalid' : 'failed')
  })
  // Keep the page fitted to the panel as the panel is resized, until the reader zooms.
  const resized = new ResizeObserver(() => { if (!closed && fitted && viewer.pagesCount > 0 && container.clientWidth > 0) viewer.currentScaleValue = 'page-width' })
  resized.observe(container)
  let query = ''
  return {
    zoom(step) {
      if (viewer.pagesCount === 0) return
      if (step === 0) { fitted = true; viewer.currentScaleValue = 'page-width'; return }
      fitted = false
      viewer.updateScale({ steps: step })
    },
    find(text, previous = false) {
      const again = text === query
      query = text
      if (!text) { eventBus.dispatch('findbarclose', { source: this }); events.found(0, 0); return }
      eventBus.dispatch('find', { source: this, type: again ? 'again' : '', query: text, caseSensitive: false, entireWord: false,
        highlightAll: true, findPrevious: previous, matchDiacritics: false })
    },
    shown() { if (!closed && viewer.pagesCount > 0) { if (fitted) viewer.currentScaleValue = 'page-width'; viewer.update() } },
    get page() { return viewer.currentPageNumber },
    close() {
      if (closed) return
      closed = true
      resized.disconnect()
      teardown.abort()
      // Let go of the pages and their canvases before the document itself is destroyed.
      try { viewer.setDocument(null as never); linkService.setDocument(null, null) } catch { /* Already torn down. */ }
      void task.destroy().catch(() => undefined).finally(() => { worker.destroy(); thread.terminate() })
      container.replaceChildren()
    },
  }
}

const viewer: PdfViewer = { open }
window.copilotFileViewers = { ...window.copilotFileViewers, pdf: viewer }
