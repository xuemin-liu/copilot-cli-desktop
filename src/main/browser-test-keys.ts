export type KeyInfo = { key: string; code: string; windowsVirtualKeyCode: number; text: string }
const NAMED_KEYS: Record<string, [number, string]> = { Enter: [13, '\r'], Tab: [9, ''], Escape: [27, ''], Space: [32, ' '], Backspace: [8, ''], Delete: [46, ''],
  ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''], Home: [36, ''], End: [35, ''], PageUp: [33, ''], PageDown: [34, ''] }
/** CDP key fields for a plan key. A letter or digit types its character only without Alt, Control or Meta,
 * so a chord such as Control+S is a shortcut and never inserts text. Shift changes letters only. */
export function testKey(name: string, modifiers: number): KeyInfo {
  const named = NAMED_KEYS[name]
  if (named) return { key: name === 'Space' ? ' ' : name, code: name, windowsVirtualKeyCode: named[0], text: named[1] }
  const upper = name.toUpperCase(); const letter = /^[a-z]$/.test(name)
  const key = letter && modifiers & 8 ? upper : name
  return { key, code: letter ? `Key${upper}` : `Digit${name}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: modifiers & 7 ? '' : key }
}
