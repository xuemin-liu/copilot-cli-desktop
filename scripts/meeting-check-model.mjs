// The mock model's answers in the review-meeting check (session-meeting-check.mjs). Kept apart from it so the launcher,
// which runs in plain Node, can load it without Electron.
const HELPER = '& "$env:COPILOT_DESKTOP_MEETING_HELPER"'
export const MEETING_REVIEW_MARK = 'meeting-review-mark-7731'

function text(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((part) => typeof part?.text === 'string' ? part.text : '').join('') : ''
}

/** What the mock model answers: it calls the meeting helper as the host, and reviews and votes as the reviewer. */
export function meetingModelReply(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const lastUser = messages.map((message) => message?.role).lastIndexOf('user')
  if (lastUser < 0) return undefined
  const prompt = text(messages[lastUser].content)
  const toolAnswered = messages.slice(lastUser + 1).some((message) => message?.role === 'tool')
  const offersShell = Array.isArray(request.tools) && request.tools.some((tool) => tool?.function?.name === 'powershell')
  const shell = (command) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call_meeting_${Date.now()}`, type: 'function', function: { name: 'powershell', arguments: JSON.stringify({ command, description: 'Meeting helper' }) } }] })
  const say = (content) => ({ role: 'assistant', content })
  const join = /join meeting ([A-Z0-9]{4})/.exec(prompt)
  if (/Start a meeting to review the plan/.test(prompt)) {
    if (offersShell && !toolAnswered) return shell(`${HELPER} start -Topic "login plan" -File plan.md -Changes`)
    return say('The meeting is open; ask the reviewers to join it.')
  }
  if (/^\[meeting [A-Z0-9]{4} · round \d+ · replies/m.test(prompt)) {
    if (offersShell && !toolAnswered) return shell(`${HELPER} propose-close -File agreed.md`)
    return say('I proposed to close the meeting.')
  }
  if (/^\[meeting [A-Z0-9]{4} · round \d+ · vote/m.test(prompt)) return say('AGREE: the lock is now in the plan.')
  if (/^\[meeting [A-Z0-9]{4} · round \d+ · from the desktop\]/m.test(prompt)) return say(`Review: step 2 races with logout; take the lock there too. ${MEETING_REVIEW_MARK}`)
  if (/^\[meeting [A-Z0-9]{4} · closed/m.test(prompt)) return say('Everyone agreed; here is the outcome.')
  if (join) return say(`Joining meeting ${join[1]}.`)
  return undefined
}
