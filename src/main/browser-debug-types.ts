export interface BrowserConsoleEntry {
  id: number
  pageId: number
  timestamp: string
  level: string
  message: string
  source: string
  line: number
}

export interface BrowserNetworkEntry {
  id: string
  pageId: number
  timestamp: string
  method: string
  url: string
  resourceType: string
  status: number | null
  durationMs: number | null
  error: string | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string[]>
  redirects: string[]
}

export interface BrowserSitePermission { id: number; origin: string; permission: string; label: string; decision: 'allow' | 'block' }

export type BrowserViewMode = 'page' | 'console' | 'network' | 'devtools' | 'activity'
export type BrowserCaptureSetting = 'record-console' | 'record-network' | 'preserve-console' | 'preserve-network'

export interface BrowserDebugState {
  testing?: import('./browser-test-plan.js').BrowserTestState
  view: BrowserViewMode
  recordingConsole: boolean
  recordingNetwork: boolean
  preserveConsole: boolean
  preserveNetwork: boolean
  activePageId: number
  zoomFactor: number
  pages: { id: number; title: string; url: string }[]
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  devtools: boolean
  error: string | null
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  sitePermissions: BrowserSitePermission[]
}

export interface BrowserBounds { x: number; y: number; width: number; height: number }
