/** Read on Enter, so a closed panel or a different session cannot leave cached context behind. */
export const GIT_CURSOR_CONTEXT_EVENT = 'copilot-desktop:git-cursor-context'

export interface GitCursorContextRequest { tabId: string; text?: string }

export function readGitCursorContext(tabId: string, target: EventTarget = window): string | undefined {
  const detail: GitCursorContextRequest = { tabId }
  target.dispatchEvent(new CustomEvent(GIT_CURSOR_CONTEXT_EVENT, { detail }))
  return detail.text
}
