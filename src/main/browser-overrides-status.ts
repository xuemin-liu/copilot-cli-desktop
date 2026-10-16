// No runtime imports: the renderer bundles this file, so it must not reach Node modules.
import type { BrowserOverridesState } from './browser-debug-types.js'

export type OverridesTone = 'on' | 'warning' | 'off'

/** The footer's one-line answer to "are my overrides applied to this page?". */
export function overridesStatus(state: BrowserOverridesState | undefined): { tone: OverridesTone; text: string } {
  if (!state) return { tone: 'off', text: 'Local Overrides: checking…' }
  const label = state.scope === 'session' ? 'Local Overrides (this session only)' : 'Local Overrides'
  if (!state.enabled) return { tone: 'off', text: `${label}: off` }
  if (!state.folder) return { tone: 'warning', text: `${label}: on, but no overrides folder is selected` }
  if (!state.devtools) return { tone: 'warning', text: `${label}: not applied to this page until its DevTools opens · ${state.folder}` }
  return { tone: 'on', text: `${label}: on · ${state.folder}` }
}
