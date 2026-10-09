/**
 * How the trust-review card shows a repository's own settings. Trusting accepts the hash of the *whole* setting, so
 * everything that goes into that hash has to be visible: nothing is cut short, and characters that can hide text
 * (long runs of spaces, newlines, zero-width and direction-changing characters) are spelled out.
 */

/**
 * The longest single setting the card will show in full. A longer one cannot be reviewed properly, so it cannot be
 * trusted from the panel (the main process enforces this too).
 */
export const MAX_REVIEW_VALUE_CHARS = 8_000

/**
 * Code point ranges with no visible form of their own: control characters, no-break and other unusual spaces, soft hyphen,
 * zero-width and direction-changing characters, line and paragraph separators, filler characters, variation selectors,
 * the byte-order mark and the tag characters. Written as numbers, never as escapes or literal characters in a pattern,
 * so this file itself holds nothing invisible.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x00a0], [0x00ad, 0x00ad], [0x034f, 0x034f],
  [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x2000, 0x200f], [0x2028, 0x202f],
  [0x205f, 0x206f], [0x3000, 0x3000], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff9, 0xfffb], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
]

const NAMED = new Map<number, string>([[0x09, 'tab'], [0x0a, 'newline'], [0x0d, 'return']])

const isInvisible = (code: number): boolean => INVISIBLE_RANGES.some(([first, last]) => code >= first && code <= last)

const codePointLabel = (code: number): string => `⟦U+${code.toString(16).toUpperCase().padStart(4, '0')}⟧`

export function formatReviewText(text: string): string {
  let spelled = ''
  for (const character of text) {
    const code = character.codePointAt(0)!
    const name = NAMED.get(code)
    spelled += name ? `⟦${name}⟧` : isInvisible(code) ? codePointLabel(code) : character
  }
  // A single space is ordinary; a long run is how a payload gets pushed out of sight.
  return spelled.replace(/ {4,}/g, run => `⟦${run.length} spaces⟧`)
}

export interface ReviewSetting {
  key: string
  value: string
}

/** True when every setting is short enough to be shown in full. */
export function isReviewable(items: readonly ReviewSetting[]): boolean {
  return items.every(item => item.value.length <= MAX_REVIEW_VALUE_CHARS && item.key.length <= MAX_REVIEW_VALUE_CHARS)
}
