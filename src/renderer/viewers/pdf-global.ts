// PDF.js's viewer components read the core library from `globalThis.pdfjsLib` when they are loaded, so this module must
// be imported before them.
import * as pdfjsLib from 'pdfjs-dist'

;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib
