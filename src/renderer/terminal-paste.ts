export const MAX_PASTE_CHARS = 1_000_000

export function isNativePasteKey(event: Pick<KeyboardEvent, 'type' | 'ctrlKey' | 'altKey' | 'metaKey' | 'key'>): boolean {
  return event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'v'
}

// Capture before xterm: ordinary text stays on its native paste path. Only
// image-only, empty, and oversized pastes need special treatment.
export function handleTerminalPaste(event: ClipboardEvent, terminal: { input(data: string, wasUserInput?: boolean): void; paste(data: string): void }): void {
  const clipboard = event.clipboardData
  if (!clipboard) return
  const text = clipboard.getData('text/plain')
  if (text.length > 0 && text.length <= MAX_PASTE_CHARS) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (text.length > MAX_PASTE_CHARS) {
    // Bound before IPC, preserving xterm's newline and bracketed-paste framing.
    let end = MAX_PASTE_CHARS
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
    terminal.paste(text.slice(0, end))
  } else if (Array.from(clipboard.items).some(item => item.type.startsWith('image/'))) {
    // Copilot owns clipboard image reading/storage. This is its Alt+V shortcut;
    // it works independently of xterm's DECSET 2004 bracketed-paste state.
    terminal.input('\u001bv', true)
  }
}
