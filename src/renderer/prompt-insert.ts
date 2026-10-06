export const INSERT_PROMPT_EVENT = 'copilot-desktop:insert-prompt'
const MAX_INSERT_CHARS = 4000

/** Text for the prompt box of one session. It is pasted, never submitted: the user reviews it and presses Enter. */
export function promptInsertText(text: string, bracketedPaste: boolean): string {
  const bounded = text.slice(0, MAX_INSERT_CHARS).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  // Without bracketed paste the terminal turns a line break into Enter, which would send a half-written prompt.
  return bracketedPaste ? bounded.replace(/\r\n?/g, '\n') : bounded.replace(/\s*\r?\n\s*/g, ' | ')
}

export function insertIntoPrompt(tabId: string, text: string): void {
  window.dispatchEvent(new CustomEvent(INSERT_PROMPT_EVENT, { detail: { tabId, text } }))
}
