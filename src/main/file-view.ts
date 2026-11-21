import { constants, watch, type FSWatcher } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { caseInsensitivePaths, hostPath, isSameOrInside, pathKey, samePath } from './host-path.js'
import { isLocalFilesystemPath, isPathWithinRoot } from './external-targets.js'

/** What a File tab shows. `other` is the card for files with no viewer. */
export type FileViewKind = 'text' | 'markdown' | 'csv' | 'notebook' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'other'
/** Why a file gets the card instead of a view. */
export type FileCardReason = 'unsupported' | 'too-large' | 'binary'

interface FileFacts {
  /** Absolute path, for the header and Copy path. */
  path: string
  name: string
  size: number
  mtimeMs: number
  /** Names this version of the file. The panel sends it back so an unchanged file is not read again. */
  revision: string
  /** Whether Open with default app is offered: never for programs and scripts the system would run. */
  openable: boolean
}
export type FileViewResult =
  /** Text kinds. A CSV is shown as a table and a notebook rendered, each with its text as the Source view. */
  | (FileFacts & { status: 'ok'; kind: 'text' | 'markdown' | 'csv' | 'notebook'; text: string; language: string | null })
  /** Word and Excel files. The panel hands these bytes to a worker that reads them. */
  | (FileFacts & { status: 'ok'; kind: 'docx' | 'xlsx'; bytes: Uint8Array })
  /** The whole document. The panel hands these bytes to the PDF viewer, which parses them in a worker. */
  | (FileFacts & { status: 'ok'; kind: 'pdf'; bytes: Uint8Array })
  | (FileFacts & { status: 'ok'; kind: 'image'; dataUrl: string })
  | (FileFacts & { status: 'ok'; kind: 'other'; reason: FileCardReason })
  /** The file is the same as the copy the tab already shows. */
  | { status: 'unchanged' }
  | { status: 'missing' | 'root-missing' | 'outside' | 'directory' }

export type OpenFileResult =
  | { ok: true; revealed?: boolean }
  | { ok: false; reason: 'missing' | 'outside-workspace' | 'limit'; message?: string }

export const FILE_TEXT_LIMIT = 2 * 1024 * 1024
export const FILE_IMAGE_LIMIT = 25 * 1024 * 1024
export const FILE_PDF_LIMIT = 50 * 1024 * 1024
export const FILE_OFFICE_LIMIT = 50 * 1024 * 1024
export const FILE_CSV_LIMIT = 10 * 1024 * 1024
/** Notebooks hold their pictures as text, so they are larger than other text files. */
export const FILE_NOTEBOOK_LIMIT = 20 * 1024 * 1024
const LIMITS: Record<Exclude<FileViewKind, 'other'>, number> = {
  text: FILE_TEXT_LIMIT, markdown: FILE_TEXT_LIMIT, csv: FILE_CSV_LIMIT, notebook: FILE_NOTEBOOK_LIMIT, image: FILE_IMAGE_LIMIT,
  pdf: FILE_PDF_LIMIT, docx: FILE_OFFICE_LIMIT, xlsx: FILE_OFFICE_LIMIT,
}
export const FILE_ASSET_LIMIT = 10 * 1024 * 1024
export const FILE_TAB_LIMIT = 20
const SNIFF_BYTES = 8_192

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
}
/** Extension to highlight.js language name. An extension that is absent is still shown as plain text when it is text. */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json', map: 'json', py: 'python', pyw: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'dos', cmd: 'dos', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml',
  svg: 'xml', xaml: 'xml', csproj: 'xml', vue: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  sql: 'sql', lua: 'lua', pl: 'perl', r: 'r', m: 'objectivec', mm: 'objectivec', diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', gradle: 'kotlin', vb: 'vbnet', wasm: 'wasm',
}
const MARKDOWN = new Set(['md', 'markdown', 'mdx', 'mdown', 'mkd'])
/** Files the system runs when opened. Open with default app is never offered for these, only Reveal in folder. */
const RUNNABLE = new Set(['exe', 'com', 'scr', 'pif', 'msi', 'msix', 'appx', 'msp', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'cpl', 'lnk', 'url', 'reg', 'jar', 'sh', 'bash', 'zsh', 'command', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'run', 'py', 'pyw', 'rb', 'pl',
  'php', 'dll', 'sys', 'scf', 'inf', 'gadget', 'application', 'desktop', 'mjs', 'cjs', 'chm', 'html', 'htm', 'svg', 'xht', 'xhtml', 'mht', 'mhtml',
  // Office files that carry macros.
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppsm'])

function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  // Dockerfile and Makefile carry their type in the whole name.
  return dot <= 0 ? lower : lower.slice(dot + 1)
}

export function canOpenWithDefaultApp(name: string): boolean {
  const lower = name.toLowerCase()
  // No extension at all is how programs are named outside Windows.
  return lower.lastIndexOf('.') > 0 && !RUNNABLE.has(extensionOf(name))
}

/** Text encodings told apart by their byte order mark; without one, bytes are UTF-8 unless they hold a NUL. */
function textEncoding(head: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' | null {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le'
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be'
  return head.includes(0) ? null : 'utf-8'
}

/**
 * Whether a file starts as a PDF does: `%PDF-` and a version such as `1.7`, at the very start (after a byte order mark or
 * blank space at most). Text that merely mentions `%PDF-1.7` is not a PDF. Real documents sometimes carry a little junk
 * before the header; that is accepted only for a file named .pdf, and only with the header at the start of a line.
 */
function isPdfHeader(head: Uint8Array, namedPdf: boolean): boolean {
  const start = Buffer.from(head.subarray(0, 1_024)).toString('latin1')
  if (/^(?:\xef\xbb\xbf)?\s*%PDF-\d\.\d/.test(start)) return true
  return namedPdf && /[\r\n]%PDF-\d\.\d/.test(start)
}

/** Choose the view from the name first, then from the first bytes: a `.md` holding binary data is not shown as text. */
export function classifyFile(name: string, head: Uint8Array): { kind: FileViewKind; language: string | null; mime: string | null; reason?: FileCardReason } {
  const extension = extensionOf(name)
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  const gif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38
  // What the bytes say comes before what the name says: a PNG called .txt is a picture, a PDF called .png is a PDF.
  const signed = png ? 'image/png' : jpeg ? 'image/jpeg' : gif ? 'image/gif' : null
  if (!signed && isPdfHeader(head, extension === 'pdf')) return { kind: 'pdf', language: null, mime: 'application/pdf' }
  const mime = signed ?? IMAGE_TYPES[extension] ?? null
  const text = textEncoding(head) !== null
  // SVG is text; show it as an image only when it really looks like one.
  if (mime === 'image/svg+xml') return text ? { kind: 'image', language: 'xml', mime } : { kind: 'other', language: null, mime: null, reason: 'binary' }
  if (mime) return { kind: 'image', language: null, mime }
  // Word and Excel files are ZIP archives; which of the two is said by the name. Other archives have no viewer.
  if (!text && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    if (extension === 'docx') return { kind: 'docx', language: null, mime: null }
    if (extension === 'xlsx' || extension === 'xlsm') return { kind: 'xlsx', language: null, mime: null }
    return { kind: 'other', language: null, mime: null, reason: 'unsupported' }
  }
  if (!text) return { kind: 'other', language: null, mime: null, reason: 'binary' }
  if (MARKDOWN.has(extension)) return { kind: 'markdown', language: 'markdown', mime: null }
  if (extension === 'csv' || extension === 'tsv' || extension === 'tab') return { kind: 'csv', language: null, mime: null }
  if (extension === 'ipynb') return { kind: 'notebook', language: 'json', mime: null }
  return { kind: 'text', language: LANGUAGES[extension] ?? null, mime: null }
}

export function decodeText(bytes: Uint8Array): string {
  const encoding = textEncoding(bytes.subarray(0, SNIFF_BYTES)) ?? 'utf-8'
  return new TextDecoder(encoding, { ignoreBOM: false }).decode(bytes)
}

/** A saved or requested relative path in one spelling: forward slashes, no `.` or `..` parts, never absolute. Null when unsafe. */
export function normalizeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) return null
  const parts = value.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some(part => part === '..') || /^[A-Za-z]:$/.test(parts[0]!) || value.startsWith('/') || value.startsWith('\\')) return null
  return parts.join('/')
}

/**
 * One key per file for finding its open tab. Nothing is folded to lower case here: `path` must be the spelling the file
 * system itself gives (`resolveInRoot(...).canonical`), so two spellings of one file get one key, and two files whose
 * names differ only by case, where the file system allows that, get two.
 */
export function fileTabKey(root: string, path: string): string {
  return JSON.stringify([hostPath.resolve(root), path])
}

/** Whether two paths are the same folder on disk, told by device and file number, not by how the names are spelled. */
export async function isSameFolder(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })])
    return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino
  } catch { return false }
}

/**
 * Whether `folder` is one of the folders above `path`, told by what the folders are (device and file number), not by how
 * their names are spelled. Both must already be resolved through links. Comparing names would call two folders the same
 * when they differ only by case, which is wrong on a file system that tells such names apart.
 */
export async function isInsideFolder(path: string, folder: string): Promise<boolean> {
  let wanted
  try { wanted = await stat(folder, { bigint: true }) } catch { return false }
  for (let above = hostPath.dirname(path); ; above = hostPath.dirname(above)) {
    const info = await stat(above, { bigint: true }).catch(() => null)
    if (info && info.dev === wanted.dev && info.ino === wanted.ino) return true
    if (above === hostPath.dirname(above)) return false
  }
}

/** `canonical` is the path under the root as the file system spells it, through links: the name a tab is kept under. */
export type ResolvedFile = { ok: true; absolute: string; canonical: string } | { ok: false; reason: 'missing' | 'root-missing' | 'outside' }

/**
 * The real file behind `relative` under `root`. Both are resolved through links first, so a link inside the root that
 * points outside it is refused, while a root that is itself reached through a link still works. This answers "where does
 * the path lead now"; reading goes through `openInRoot`, which ties the answer to the file that is actually read.
 */
export async function resolveInRoot(root: string, relative: string): Promise<ResolvedFile> {
  const path = normalizeRelativePath(relative)
  if (!path || !isLocalFilesystemPath(root) || !hostPath.isAbsolute(root)) return { ok: false, reason: 'outside' }
  const lexical = hostPath.resolve(root, path)
  if (!isPathWithinRoot(root, lexical)) return { ok: false, reason: 'outside' }
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return { ok: false, reason: 'root-missing' } }
  let real: string
  try { real = await realpath(lexical) } catch { return { ok: false, reason: 'missing' } }
  if (!isLocalFilesystemPath(real) || !isSameOrInside(real, realRoot) || !(await isInsideFolder(real, realRoot))) return { ok: false, reason: 'outside' }
  const canonical = normalizeRelativePath(hostPath.relative(realRoot, real))
  if (!canonical) return { ok: false, reason: 'outside' }
  return { ok: true, absolute: lexical, canonical }
}

/** A file opened for reading whose place under its root was checked against the open file itself. */
export interface OpenedFile { handle: FileHandle; absolute: string; size: number; mtimeMs: number; revision: string }
export type OpenResult = { ok: true; file: OpenedFile } | { ok: false; reason: 'missing' | 'root-missing' | 'outside' | 'directory' }

/**
 * Open a file under `root` and prove that the open file is inside the root. Checking the path and then reading the path
 * would be two separate lookups, and a link swapped between them would be read without ever being checked. So the file is
 * opened first, and the check is made about that open file:
 * - on Linux the system reports the real path of the open file, and that path must be inside the root;
 * - elsewhere the path is resolved through links, must be inside the root, must not be a link itself, and must be the very
 *   file that is open (same device and file number), and must still resolve to itself afterwards.
 * Size, time and contents are then read from the open file only. The caller closes `handle`.
 * `hooks` run just before opening and just after; tests use them to swap a link at those moments.
 */
export interface OpenHooks { beforeOpen?(): Promise<void>; afterOpen?(): Promise<void> }
export async function openInRoot(root: string, relative: string, hooks?: OpenHooks): Promise<OpenResult> {
  const first = await resolveInRoot(root, relative)
  if (!first.ok) return first
  await hooks?.beforeOpen?.()
  let handle: FileHandle
  // Without O_NONBLOCK, opening a named pipe waits for a writer and this request would never answer. It makes no
  // difference to a regular file, and Windows has no such flag.
  try { handle = await open(first.absolute, process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK) } catch {
    // A folder cannot be opened for reading on Windows; say what it is instead of calling it missing.
    return { ok: false, reason: await stat(first.absolute).then(info => info.isDirectory() ? 'directory' as const : 'missing' as const, () => 'missing' as const) }
  }
  const refuse = async (reason: 'missing' | 'root-missing' | 'outside' | 'directory'): Promise<OpenResult> => { await handle.close().catch(() => undefined); return { ok: false, reason } }
  try {
    await hooks?.afterOpen?.()
    const opened = await handle.stat({ bigint: true })
    if (opened.isDirectory()) return await refuse('directory')
    if (!opened.isFile()) return await refuse('missing')
    const realRoot = await realpath(root)
    if (process.platform === 'linux') {
      const real = await realpath(`/proc/self/fd/${handle.fd}`)
      if (!(await isInsideFolder(real, realRoot))) return await refuse('outside')
    } else {
      const real = await realpath(first.absolute)
      if (!isLocalFilesystemPath(real) || !isSameOrInside(real, realRoot) || !(await isInsideFolder(real, realRoot))) return await refuse('outside')
      const there = await lstat(real, { bigint: true })
      if (!there.isFile() || there.dev !== opened.dev || there.ino !== opened.ino || !samePath(await realpath(real), real)) return await refuse('outside')
    }
    // The time in nanoseconds: two saves inside one millisecond are still two versions.
    return { ok: true, file: { handle, absolute: first.absolute, size: Number(opened.size), mtimeMs: Number(opened.mtimeMs), revision: `${opened.mtimeNs}-${opened.size}` } }
  } catch { return refuse('missing') }
}

/** Read up to `limit` bytes of an open file, plus one: a result longer than `limit` means the file is over the limit. The
 * buffer starts at the file's size and grows only if the file did, so a small file never costs a limit-sized buffer. */
export async function readOpened(file: OpenedFile, limit: number): Promise<Uint8Array> {
  const most = limit + 1
  let buffer = Buffer.allocUnsafeSlow(Math.max(1, Math.min(most, file.size + 1)))
  let length = 0
  for (;;) {
    const { bytesRead } = await file.handle.read(buffer, length, buffer.length - length, length)
    length += bytesRead
    if (bytesRead === 0 || length >= most) break
    if (length === buffer.length) {
      const grown = Buffer.allocUnsafeSlow(Math.min(most, buffer.length * 2))
      buffer.copy(grown, 0, 0, length)
      buffer = grown
    }
  }
  return buffer.subarray(0, length)
}

/** Read a file for its tab. `known` is the copy the tab already shows: an unchanged file is not read again. */
export async function readFileView(root: string, relative: string, known?: string | null, hooks?: OpenHooks): Promise<FileViewResult> {
  const opened = await openInRoot(root, relative, hooks)
  if (!opened.ok) return { status: opened.reason }
  const file = opened.file
  try {
    if (known && known === file.revision) return { status: 'unchanged' }
    const name = hostPath.basename(file.absolute)
    const head = await readOpened(file, SNIFF_BYTES - 1)
    const type = classifyFile(name, head)
    // Open with default app is for files this panel can show. Anything else, and anything the system would run, is
    // only ever revealed.
    const facts: FileFacts = { path: file.absolute, name, size: file.size, mtimeMs: file.mtimeMs, revision: file.revision, openable: type.kind !== 'other' && canOpenWithDefaultApp(name) }
    if (type.kind === 'other') return { ...facts, status: 'ok', kind: 'other', reason: type.reason ?? 'unsupported' }
    const limit = LIMITS[type.kind]
    if (file.size > limit) return { ...facts, status: 'ok', kind: 'other', reason: 'too-large' }
    const bytes = head.length < SNIFF_BYTES ? head : await readOpened(file, limit)
    if (bytes.length > limit) return { ...facts, status: 'ok', kind: 'other', reason: 'too-large' }
    if (type.kind === 'pdf' || type.kind === 'docx' || type.kind === 'xlsx') return { ...facts, status: 'ok', kind: type.kind, bytes }
    if (type.kind === 'image') return { ...facts, status: 'ok', kind: 'image', dataUrl: `data:${type.mime};base64,${Buffer.from(bytes).toString('base64')}` }
    return { ...facts, status: 'ok', kind: type.kind, text: decodeText(bytes), language: type.language }
  } catch { return { status: 'missing' } } finally { await file.handle.close().catch(() => undefined) }
}

/** Whether Open with default app may start this file: the same answer the panel got when it read the file. */
export async function fileOpenable(root: string, relative: string): Promise<string | null> {
  const opened = await openInRoot(root, relative)
  if (!opened.ok) return null
  try {
    const name = hostPath.basename(opened.file.absolute)
    const type = classifyFile(name, await readOpened(opened.file, SNIFF_BYTES - 1))
    return type.kind !== 'other' && canOpenWithDefaultApp(name) ? opened.file.absolute : null
  } catch { return null } finally { await opened.file.handle.close().catch(() => undefined) }
}

/**
 * A picture a Markdown file refers to, as a `data:` URL. `href` is relative to the Markdown file and must stay inside the
 * same root. Only raster and SVG images are served; null for anything else, including a web address.
 */
export async function readFileAsset(root: string, relative: string, href: string): Promise<string | null> {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2_048 || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null
  let decoded: string
  try { decoded = decodeURIComponent(href.split(/[?#]/)[0]!) } catch { return null }
  const base = normalizeRelativePath(relative)
  if (!base || !decoded) return null
  const folder = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  // A leading slash means "from the root", as on a repository page.
  const joined = hostPath.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : hostPath.posix.join(folder, decoded.replaceAll('\\', '/')))
  const target = normalizeRelativePath(joined)
  if (!target) return null
  const opened = await openInRoot(root, target)
  if (!opened.ok) return null
  try {
    if (opened.file.size > FILE_ASSET_LIMIT) return null
    const bytes = await readOpened(opened.file, FILE_ASSET_LIMIT)
    const type = classifyFile(hostPath.basename(opened.file.absolute), bytes.subarray(0, SNIFF_BYTES))
    if (type.kind !== 'image' || !type.mime || bytes.length > FILE_ASSET_LIMIT) return null
    return `data:${type.mime};base64,${Buffer.from(bytes).toString('base64')}`
  } catch { return null } finally { await opened.file.handle.close().catch(() => undefined) }
}

/** The data files a viewer may ask for, by the kind of request and the folder they are shipped in. */
const VIEWER_ASSET_FOLDERS: Record<string, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }
const VIEWER_ASSET_LIMIT = 8 * 1024 * 1024

/**
 * A data file the PDF viewer needs to show some documents: a character map, a standard font, or an image decoder. They
 * ship with the app under `folder` and are read here, so the window never needs permission to fetch anything. Only a plain
 * file name in one of the known folders is served.
 */
export async function readViewerAsset(folder: string, kind: unknown, filename: unknown): Promise<Uint8Array> {
  const place = typeof kind === 'string' && Object.hasOwn(VIEWER_ASSET_FOLDERS, kind) ? VIEWER_ASSET_FOLDERS[kind] : undefined
  if (!place || typeof filename !== 'string' || !/^[A-Za-z0-9][\w.-]{0,79}$/.test(filename) || filename.includes('..')) throw new Error('Unknown viewer data file')
  const handle = await open(hostPath.join(folder, place, filename), 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > VIEWER_ASSET_LIMIT) throw new Error('Unknown viewer data file')
    const buffer = Buffer.allocUnsafeSlow(info.size)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return buffer.subarray(0, length)
  } finally { await handle.close() }
}

/** Where a clicked path points: the root that holds it, and its path under that root (empty for the root folder itself,
 * which can be revealed but never opened). Null when no root holds it. */
export function locateInRoots(roots: readonly string[], absolute: string): { root: string; path: string } | null {
  for (const root of roots) {
    if (!isPathWithinRoot(root, absolute) || !isSameOrInside(absolute, root)) continue
    if (samePath(root, absolute)) return { root: hostPath.resolve(root), path: '' }
    const path = normalizeRelativePath(hostPath.relative(hostPath.resolve(root), hostPath.resolve(absolute)))
    if (path) return { root: hostPath.resolve(root), path }
  }
  return null
}

interface Watch { path: string; watcher: FSWatcher | null; timer: NodeJS.Timeout | null; retry: NodeJS.Timeout | null; check: NodeJS.Timeout | null; lost: boolean }

/**
 * Tells a tab when its file changes. The folder is watched, not the file: an editor that saves by writing a new file and
 * renaming it over the old one replaces the file, which would end a watch on the file itself.
 */
export class FileWatchers {
  private readonly entries = new Map<string, Watch>()
  constructor(private readonly changed: (id: string) => void, private readonly debounceMs = 300, private readonly retryMs = 2_000) {}

  /** The path a tab's folder watch was asked for, or null when it is not watched. */
  watched(id: string): string | null { return this.entries.get(id)?.path ?? null }

  watch(id: string, path: string): void {
    if (this.entries.get(id)?.path === path) return
    this.unwatch(id)
    const entry: Watch = { path, watcher: null, timer: null, retry: null, check: null, lost: false }
    this.entries.set(id, entry)
    this.attach(id, entry)
  }

  private notify(id: string, entry: Watch): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { entry.timer = null; if (this.entries.get(id) === entry) this.changed(id) }, this.debounceMs)
    entry.timer.unref?.()
  }

  /** The folder went away or cannot be watched. Tell the tab once, then keep looking for the folder. */
  private lose(id: string, entry: Watch): void {
    entry.watcher?.close(); entry.watcher = null
    if (this.entries.get(id) !== entry || entry.retry) return
    if (!entry.lost) this.notify(id, entry)
    entry.lost = true
    entry.retry = setTimeout(() => { entry.retry = null; if (this.entries.get(id) === entry) this.attach(id, entry) }, this.retryMs)
    entry.retry.unref?.()
  }

  /**
   * A removed folder does not always end its watch with an error: the watch can stay open on a folder that no longer
   * exists and never report again. So after any event, while the file is missing, look whether its folder is still there.
   */
  private verify(id: string, entry: Watch, delay: number): void {
    if (entry.check) return
    entry.check = setTimeout(() => {
      entry.check = null
      if (this.entries.get(id) !== entry || !entry.watcher) return
      void stat(entry.path).catch(() => stat(hostPath.dirname(entry.path)).then(
        () => { if (this.entries.get(id) === entry && entry.watcher) this.verify(id, entry, this.retryMs) },
        () => { if (this.entries.get(id) === entry) this.lose(id, entry) }))
    }, delay)
    entry.check.unref?.()
  }

  private attach(id: string, entry: Watch): void {
    const wanted = hostPath.basename(entry.path)
    const same = (name: string): boolean => caseInsensitivePaths ? name.toLowerCase() === wanted.toLowerCase() : name === wanted
    try {
      const watcher = watch(hostPath.dirname(entry.path), { persistent: false }, (_event, filename) => {
        if (filename === null || same(hostPath.basename(String(filename)))) this.notify(id, entry)
        this.verify(id, entry, this.debounceMs)
      })
      watcher.on('error', () => this.lose(id, entry))
      entry.watcher = watcher
      if (entry.lost) { entry.lost = false; this.notify(id, entry) }
    } catch { this.lose(id, entry) }
  }

  unwatch(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.watcher?.close()
    for (const timer of [entry.timer, entry.retry, entry.check]) if (timer) clearTimeout(timer)
  }

  has(id: string): boolean { return this.entries.has(id) }
  stop(): void { for (const id of [...this.entries.keys()]) this.unwatch(id) }
}
