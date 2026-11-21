// The worker PDF.js parses documents in. A worker started from a local file is not covered by the window's content
// security policy, so unlike the window it could reach the network. PDF.js is given everything it needs through
// messages (the document's bytes, and the app's data files by way of the main process), so the ways out are removed
// here before any of its code runs. A document is untrusted input; this keeps a parsing mistake from becoming a request.
const scope = globalThis as Record<string, unknown>
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'RTCDataChannel',
  'BroadcastChannel', 'SharedWorker', 'Worker', 'importScripts', 'indexedDB', 'caches', 'Notification', 'navigator']) {
  try {
    if (name === 'navigator') {
      // The navigator stays (PDF.js reads the platform from it); only its ways to send data go.
      for (const method of ['sendBeacon', 'serviceWorker', 'locks', 'storage']) Object.defineProperty(scope.navigator as object, method, { value: undefined, configurable: false })
      continue
    }
    Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false })
  } catch { /* Not present in this worker. */ }
}

// Loaded after the lines above have run: a static import would be hoisted above them.
void import('pdfjs-dist/build/pdf.worker.mjs')
