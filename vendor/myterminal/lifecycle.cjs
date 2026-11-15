// Extracted from pinned MyTerminal TerminalTab.jsx: bell cooldown and bounded SSH retry.
// Shared by the original component and the desktop's process-owned lifecycle.
exports.createBellNotifier = ({ focused, notify, label, now = Date.now }) => {
  let lastBell = 0
  return data => {
    if (data.includes('\x07') && !focused()) {
      const time = now()
      if (time - lastBell > 5000) {
        lastBell = time
        notify('Terminal Bell', `Activity in: ${label()}`)
      }
    }
  }
}

exports.createReconnectController = ({ connect, changed = () => {}, exhausted = () => {}, attempts = { current: 0 }, timers = globalThis }) => {
  let timer = null, remaining = null, disposed = false, limitReached = false
  const cancel = () => {
    if (timer !== null) timers.clearInterval(timer)
    timer = null; remaining = null; changed(null)
  }
  return {
    get remaining() { return remaining },
    get attempts() { return attempts.current },
    get exhausted() { return limitReached },
    schedule() {
      if (disposed) return
      cancel()
      const attempt = attempts.current + 1
      if (attempt > 5) { limitReached = true; exhausted(); return }
      attempts.current = attempt
      remaining = Math.min(30, attempt * 5)
      changed(remaining)
      timer = timers.setInterval(() => {
        remaining--
        changed(remaining > 0 ? remaining : null)
        if (remaining <= 0) { cancel(); connect() }
      }, 1000)
    },
    connected() { cancel(); attempts.current = 0; limitReached = false },
    cancel,
    dispose() { disposed = true; cancel() },
  }
}
