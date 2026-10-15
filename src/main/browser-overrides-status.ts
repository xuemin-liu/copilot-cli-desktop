// No runtime imports: the renderer bundles this file, so it must not reach Node modules.
import type { BrowserOverridesState } from './browser-debug-types.js'

export type OverridesTone = 'on' | 'warning' | 'off'

/** The footer's one-line answer to "are my overrides applied to this page?". */
export function overridesStatus(state: BrowserOverridesState | undefined): { tone: OverridesTone; text: string } {
  if (!state) return { tone: 'off', text: 'Local Overrides: checking…' }
  if (!state.enabled) return { tone: 'off', text: 'Local Overrides: off' }
  if (!state.folder) return { tone: 'warning', text: 'Local Overrides: on, but no overrides folder is selected' }
  if (!state.devtools) return { tone: 'warning', text: `Local Overrides: not applied to this page until its DevTools opens · ${state.folder}` }
  return { tone: 'on', text: `Local Overrides: on · ${state.folder}` }
}
