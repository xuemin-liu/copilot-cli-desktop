export interface ContextMenuInput {
  linkURL: string; srcURL: string; mediaType: string; selectionText: string; isEditable: boolean
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
}
export type ContextMenuId = 'back' | 'forward' | 'reload' | 'hard-reload' | 'cut' | 'copy' | 'paste' | 'select-all' | 'copy-link' | 'open-link' | 'copy-image-address' | 'inspect'
export type ContextMenuItem = { id: ContextMenuId; label: string; enabled: boolean } | { separator: true }

const isHttp = (value: string): boolean => /^https?:\/\//i.test(value) && value.length <= 8192

/** What the page's right-click menu offers. Pure so it can be tested; the browser runs the chosen id. */
export function contextMenuItems(input: ContextMenuInput, navigation: { canGoBack: boolean; canGoForward: boolean }): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  const group = (...next: ContextMenuItem[]): void => { if (items.length) items.push({ separator: true }); items.push(...next) }
  if (input.isEditable) {
    group({ id: 'cut', label: 'Cut', enabled: input.editFlags.canCut }, { id: 'copy', label: 'Copy', enabled: input.editFlags.canCopy },
      { id: 'paste', label: 'Paste', enabled: input.editFlags.canPaste }, { id: 'select-all', label: 'Select all', enabled: input.editFlags.canSelectAll })
  } else if (input.selectionText.trim()) group({ id: 'copy', label: 'Copy', enabled: true })
  if (isHttp(input.linkURL)) group({ id: 'open-link', label: 'Open link in new page', enabled: true }, { id: 'copy-link', label: 'Copy link address', enabled: true })
  if (input.mediaType === 'image' && isHttp(input.srcURL)) group({ id: 'copy-image-address', label: 'Copy image address', enabled: true })
  group({ id: 'back', label: 'Back', enabled: navigation.canGoBack }, { id: 'forward', label: 'Forward', enabled: navigation.canGoForward },
    { id: 'reload', label: 'Reload', enabled: true }, { id: 'hard-reload', label: 'Hard reload (bypass cache)', enabled: true })
  if (!input.isEditable && !input.selectionText.trim()) items.push({ id: 'select-all', label: 'Select all', enabled: true })
  group({ id: 'inspect', label: 'Inspect element', enabled: true })
  return items
}
