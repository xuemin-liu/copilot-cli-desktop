// The worker PDF.js parses documents in. PDF.js is given everything it needs through messages (the document's bytes, and
// the app's data files by way of the main process), so the worker's ways to the network are removed before it loads.
import './worker-lockdown.js'

// Loaded after the line above has run: a static import of the parser could be hoisted above it by a bundler.
void import('pdfjs-dist/build/pdf.worker.mjs')
