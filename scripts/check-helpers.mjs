import { readFile } from 'node:fs/promises'

export async function ui(window, code, timeoutMs = 15_000) {
  let timer
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(code),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Renderer timeout: ${code}`)), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

// A CLI appending JSONL can leave its last record incomplete between polls.
// Ignore only that unfinished record; malformed complete records are errors.
export async function readEvents(path) {
  const text = await readFile(path, 'utf8')
  return text.split('\n').slice(0, -1).filter(line => line.trim()).map(line => JSON.parse(line))
}
