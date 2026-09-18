import { appendFile } from 'node:fs/promises'
import { createServer } from 'node:http'

export function createCheckModelServer({ recordingPath, delayMs = 0 } = {}) {
  let recording = Promise.resolve()
  return createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => { if (recordingPath) chunks.push(chunk) })
    request.on('end', async () => {
      let parsed
      try { if (chunks.length) parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* Non-JSON probes are not model requests. */ }
      if (parsed !== undefined) {
        recording = recording.then(() => appendFile(recordingPath, JSON.stringify(parsed) + '\n')).catch(error => {
          console.error('[electron-check] Request recording failed:', error)
        })
        await recording
      }
      const respond = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(request.method === 'GET' && request.url?.split('?')[0] === '/v1/models'
          ? { object: 'list', data: [{ id: 'ui-check-model', object: 'model', owned_by: 'local' }] }
          : { id: 'local-ui-check', object: 'chat.completion', created: 1, model: 'ui-check-model', choices: [{ index: 0, message: { role: 'assistant', content: 'The saved marker is desktop-side-chat-42.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
      if (delayMs) setTimeout(respond, delayMs)
      else respond()
    })
  })
}
