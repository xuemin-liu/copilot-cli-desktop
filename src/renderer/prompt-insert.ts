export const INSERT_PROMPT_EVENT = 'copilot-desktop:insert-prompt'
const MAX_INSERT_CHARS = 12000

/** Text for the prompt box of one session. It is pasted, never submitted: the user reviews it and presses Enter. */
export function promptInsertText(text: string, bracketedPaste: boolean): string {
  const bounded = text.slice(0, MAX_INSERT_CHARS).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  // Without bracketed paste the terminal turns a line break into Enter, which would send a half-written prompt.
  return bracketedPaste ? bounded.replace(/\r\n?/g, '\n') : bounded.replace(/\s*\r?\n\s*/g, ' | ')
}

/** Dispatch an insert to whatever terminal pane owns the tab in this window. The pane that took it cancels the event, so
 * the return value says whether anything did: false when no pane for that tab lives here (a popped-out session owns its
 * terminal in another window). A dispatch is never taken as delivery by itself. */
export function dispatchPromptInsert(target: EventTarget, detail: { tabId: string; text?: string; image?: true }): boolean {
  return !target.dispatchEvent(new CustomEvent(INSERT_PROMPT_EVENT, { detail, cancelable: true }))
}

export function insertIntoPrompt(tabId: string, text: string): boolean {
  return dispatchPromptInsert(window, { tabId, text })
}

/** Attach the image on the clipboard to the prompt with Copilot's own paste-image shortcut (Alt+V). Nothing is sent. */
export function attachClipboardImage(tabId: string): boolean {
  return dispatchPromptInsert(window, { tabId, image: true })
}
