/** Read on Enter, so a closed panel or a different session cannot leave cached context behind. */
export const GIT_CURSOR_CONTEXT_EVENT = 'copilot-desktop:git-cursor-context'

export interface GitCursorContextRequest { tabId: string; text?: string; complete?: (attached: boolean) => void }

export function requestGitCursorContext(tabId: string, target: EventTarget = window): GitCursorContextRequest {
  const detail: GitCursorContextRequest = { tabId }
  target.dispatchEvent(new CustomEvent(GIT_CURSOR_CONTEXT_EVENT, { detail }))
  return detail
}

export function readGitCursorContext(tabId: string, target: EventTarget = window): string | undefined {
  return requestGitCursorContext(tabId, target).text
}
