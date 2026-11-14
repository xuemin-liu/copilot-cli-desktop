export function appendOutputLines(outputLines, pendingLine, plain, maxLines = 5000, trimCount = 500) {
  const combined = pendingLine + plain
  const parts = combined.split('\n')
  const nextPendingLine = parts.pop()
  let changed = false

  for (const line of parts) {
    const clean = line.replace(/\r/g, '').trim()
    if (clean) {
      outputLines.push(clean)
      if (outputLines.length > maxLines) outputLines.splice(0, trimCount)
      changed = true
    }
  }

  return { pendingLine: nextPendingLine, changed }
}

export function updateCwdDetection(rawBuffer, plainBuffer, rawChunk, plainChunk, maxBuffer = 4096) {
  const nextRawBuffer = (rawBuffer + rawChunk).slice(-maxBuffer)
  const nextPlainBuffer = (plainBuffer + plainChunk).slice(-maxBuffer)
  const osc7 = nextRawBuffer.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/)

  if (osc7) {
    try {
      return {
        rawBuffer: nextRawBuffer,
        plainBuffer: nextPlainBuffer,
        cwd: decodeURIComponent(osc7[1]),
      }
    } catch (_) {
      return { rawBuffer: nextRawBuffer, plainBuffer: nextPlainBuffer, cwd: null }
    }
  }

  const promptMatch = nextPlainBuffer.match(/(?:^|\r?\n|\r)[^\r\n]*[: ]([~/][^\r\n $#>]*?)\s*[$#>]\s*$/)
  return {
    rawBuffer: nextRawBuffer,
    plainBuffer: nextPlainBuffer,
    cwd: promptMatch ? promptMatch[1].trim() : null,
  }
}
