export interface BrowserConsoleEntry {
  id: number
  timestamp: string
  level: string
  message: string
  source: string
  line: number
}

export interface BrowserNetworkEntry {
  id: string
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

export interface BrowserDebugState {
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  devtools: boolean
  error: string | null
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
}

export interface BrowserBounds { x: number; y: number; width: number; height: number }
