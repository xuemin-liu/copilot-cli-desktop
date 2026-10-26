import { appendFile } from 'node:fs/promises'
import { createServer } from 'node:http'

/** `toolCall` ({ name, arguments }) makes the model request that tool once, when the CLI offers it and no
 * tool result is in the conversation yet; every later request gets the plain final answer. `reply(request)` may
 * script the answer instead: it returns an assistant message, or nothing for the default. */
export function createCheckModelServer({ recordingPath, delayMs = 0, toolCall, reply } = {}) {
  let recording = Promise.resolve()
  return createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => { chunks.push(chunk) })
    request.on('end', async () => {
      let parsed
      try { if (chunks.length) parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* Non-JSON probes are not model requests. */ }
      if (parsed !== undefined && recordingPath) {
        recording = recording.then(() => appendFile(recordingPath, JSON.stringify(parsed) + '\n')).catch(error => {
          console.error('[electron-check] Request recording failed:', error)
        })
        await recording
      }
      const offersTool = Array.isArray(parsed?.tools) && parsed.tools.some(tool => tool?.function?.name === toolCall?.name)
      const answeredTool = Array.isArray(parsed?.messages) && parsed.messages.some(message => message?.role === 'tool')
      const scripted = parsed && reply ? reply(parsed) : undefined
      const message = scripted ? scripted : toolCall && offersTool && !answeredTool
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_ui_check_1', type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] }
        : { role: 'assistant', content: 'The saved marker is desktop-side-chat-42.' }
      const respond = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(request.method === 'GET' && request.url?.split('?')[0] === '/v1/models'
          ? { object: 'list', data: [{ id: 'ui-check-model', object: 'model', owned_by: 'local' }] }
          : { id: 'local-ui-check', object: 'chat.completion', created: 1, model: 'ui-check-model', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
      if (delayMs) setTimeout(respond, delayMs)
      else respond()
    })
  })
}
