// Electron cannot round-trip arbitrary Windows clipboard formats via write().
// Refuse before touching files/custom formats, and never overwrite a newer copy.
export function preserveClipboard(clipboard, warn = console.warn) {
  const fields = { 'text/plain': 'text', 'text/html': 'html', 'text/rtf': 'rtf', 'image/png': 'image' }
  const formats = clipboard.availableFormats()
  const unsupported = formats.filter(format => !Object.hasOwn(fields, format))
  if (unsupported.length) throw new Error(`Clipboard contains formats this check cannot restore (${unsupported.join(', ')}). Copy plain text before running the check. Clipboard was not changed.`)
  const original = {}
  const readers = { text: () => clipboard.readText(), html: () => clipboard.readHTML(), rtf: () => clipboard.readRTF(), image: () => clipboard.readImage() }
  for (const format of formats) {
    const field = fields[format]
    original[field] = readers[field]()
  }
  let owned
  const snapshot = () => clipboard.availableFormats().sort().map(format => ({ format, data: clipboard.readBuffer(format) }))
  return {
    claim() { owned = snapshot() },
    restore() {
      if (!owned) return
      const current = snapshot()
      if (current.length !== owned.length || current.some((item, i) => item.format !== owned[i].format || !item.data.equals(owned[i].data))) {
        warn('[native-paste] Clipboard changed during the check; preserving its newer contents instead of restoring the original.')
        return
      }
      if (formats.length) clipboard.write(original)
      else clipboard.clear()
    },
  }
}
