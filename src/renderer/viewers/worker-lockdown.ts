// Imported first by every worker that parses files. A worker started from a local file is not covered by the window's
// content security policy, so unlike the window it could reach the network. The parsers get everything they need through
// messages, so the ways out are removed here before any parser code runs. A file is untrusted input; this keeps a parsing
// mistake from becoming a request. It is not a sandbox against code running in the worker: `import()` cannot be removed.
const scope = globalThis as Record<string, unknown>
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'RTCDataChannel',
  'BroadcastChannel', 'SharedWorker', 'Worker', 'indexedDB', 'caches', 'Notification']) {
  try { Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false }) } catch { /* Not present in this worker. */ }
}
// `importScripts` stays a function, because libraries look for it to learn that they are in a worker (one bundled here
// would otherwise take the worker for a window and fail). It no longer loads anything.
try { Object.defineProperty(scope, 'importScripts', { value: () => { throw new Error('Loading scripts is not available in this worker') }, writable: false, configurable: false }) } catch { /* Not present. */ }
// The navigator stays (parsers read the platform from it); only its ways to send or keep data go.
for (const method of ['sendBeacon', 'serviceWorker', 'locks', 'storage']) {
  try { Object.defineProperty(scope.navigator as object, method, { value: undefined, configurable: false }) } catch { /* Not present. */ }
}
export {}
