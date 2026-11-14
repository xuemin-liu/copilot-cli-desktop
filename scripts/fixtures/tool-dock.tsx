import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceToolDock } from '../../src/renderer/components/WorkspaceToolDock.js'
import { SessionWorkspace } from '../../src/renderer/components/SessionWorkspace.js'
import type { DesktopSessionTab } from '../../src/main/types.js'
import type { BrowserDebugState } from '../../src/main/browser-debug-types.js'
import type { ToolDockPreferences } from '../../src/renderer/tool-dock-state.js'

const calls: Array<{ name: string; id: string; value?: unknown }> = []
const states = new Map<string, BrowserDebugState>()
let picked: (id: string, value: string) => void = () => {}
let finishPick: (() => void) | undefined
const browser = (id: string): BrowserDebugState => {
  if (!states.has(id)) states.set(id, { activePageId: 1, pages: [{ id: 1, title: id, url: `http://localhost/${id}` }],
    zoomFactor: 1, view: 'page', recordingConsole: true, recordingNetwork: true, preserveConsole: true, preserveNetwork: true,
    url: `http://localhost/${id}`, loading: false, canGoBack: false, canGoForward: false, devtools: false, error: null,
    console: [], network: [], sitePermissions: [], history: [] } as BrowserDebugState)
  return structuredClone(states.get(id)!)
}
const api = {
  browserOpen: async (id: string) => { calls.push({ name: 'open', id }); return browser(id) },
  browserState: async (id: string) => { calls.push({ name: 'poll', id }); return browser(id) },
  browserBounds: async (id: string, value: unknown) => {
    calls.push({ name: 'bounds', id, value })
    if (value === null) {
      const state = states.get(id)
      if (state) state.testing = { enabled: false, running: false, step: 0, total: 0, label: '', report: null }
      finishPick?.(); finishPick = undefined
    }
  },
  browserAction: async (id: string, action: string) => {
    const state = browser(id)
    if (action === 'testing:on') state.testing = { enabled: true, running: true, step: 1, total: 3, label: 'Testing', report: null }
    if (action === 'testing:off') state.testing = { enabled: false, running: false, step: 0, total: 0, label: '', report: null }
    states.set(id, state)
    return browser(id)
  },
  browserPickMany: async () => new Promise<void>(resolve => { finishPick = resolve }),
  onBrowserPicked: (listener: typeof picked) => { picked = listener; return () => {} },
  getTabSnapshot: async () => ({ sequence: 0, data: 'persistent terminal\r\n> ' }),
  getTabOutput: async () => ({ sequence: 0, data: '' }),
}
Object.defineProperty(window, 'copilotDesktop', { value: new Proxy(api, { get(target, key) {
  if (key in target) return target[key as keyof typeof target]
  return String(key).startsWith('on') ? () => () => {} : async () => undefined
} }) })
const tab = (id: string): DesktopSessionTab => ({ id, title: id, status: 'running', processId: 1, workspaceProfileId: 'project', cliVersion: null,
  sessionPermissionPreset: null, permissionWarning: null, remote: false, lastSessionId: null, lastActivityAt: 0 })
const main = tab('main'), side = { ...tab('side'), sideChat: true as const, sideParentTabId: 'main' }, other = tab('other')
let gitMounts = 0
function GitProbe() {
  const [draft, setDraft] = useState('')
  useEffect(() => { gitMounts++ }, [])
  return <textarea aria-label="Retained Git draft" value={draft} onChange={e => setDraft(e.target.value)} />
}
function Fixture() {
  const [prefs, setPrefs] = useState<ToolDockPreferences>({ open: true, tool: 'browser', width: 420 })
  const [active, setActive] = useState('main')
  const [choice, setChoice] = useState<string | null>(null)
  const [pair, setPair] = useState(false)
  const [obscured, setObscured] = useState(false)
  const [profile, setProfile] = useState('project')
  const [popouts, setPopouts] = useState<string[]>([])
  const tabs = pair ? [main, side, other] : [main, other]
  Object.assign(window, { dockTest: { calls, states, gitMounts, prefs, setPrefs, setActive, setPair, setObscured, setProfile, setPopouts,
    pick: (id: string, value: string) => picked(id, value) } })
  return <WorkspaceToolDock prefs={prefs} onChange={setPrefs} onClose={() => setPrefs(value => ({ ...value, open: false }))}
    tabs={tabs} activeTabId={active} profileId={profile} gitAvailable={profile !== 'general'} git={<GitProbe />}
    browserChoice={choice} onBrowserChoice={setChoice} onActivate={setActive} browserPoppedOutTabIds={popouts} poppedOutTabIds={[]}
    obscured={obscured} onError={error => { throw error }}>
    <SessionWorkspace tabs={tabs} activeTabId={active} canOpenTab onActivate={setActive} onFork={() => {}} onClose={() => {}}
      onRestart={() => {}} onShowLog={() => {}} onCreate={() => {}} />
  </WorkspaceToolDock>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
