// No imports: the renderer bundles this file, so it must not reach Node modules.
export const MAX_PICKED_ELEMENTS = 10

/** The `<tag#id.class>` part of a picked element's first line, for a short chip label. */
export function pickedElementLabel(block: string): string {
  const match = /^\[Browser element\] <([^>\n]{1,160})>/.exec(block)
  return match ? match[1]! : 'element'
}

/** Prompt text for one or more picked elements and an optional comment about them. */
export function composeElementSelection(blocks: string[], note: string): string {
  const comment = note.replace(/\s+/g, ' ').trim().slice(0, 500)
  const elements = blocks.slice(0, MAX_PICKED_ELEMENTS)
  const body = elements.length === 1 ? elements[0]! : elements.map((block, index) => `Element ${index + 1} of ${elements.length}:\n${block}`).join('\n\n')
  return (comment ? `Comment: ${comment}${elements.length ? '\n\n' : ''}` : '') + body
}
