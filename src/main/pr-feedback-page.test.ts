import test from 'node:test'
import assert from 'node:assert/strict'
import { readPrFeedbackPage } from './pr-feedback-page.js'

test('reads all pages of long PR comments with valid JSON and intact bodies', async () => {
  const comments = Array.from({ length: 52 }, (_, id) => ({ id, body: 'a'.repeat(4100) + String(id) }))
  const api = async (route: string) => {
    if (!route.includes('?')) return { head: { sha: 'head' }, base: { sha: 'base' } }
    if (!route.includes('/pulls/1/comments?')) return []
    const offset = (Number(new URLSearchParams(route.split('?')[1]).get('page')) - 1) * 4
    return comments.slice(offset, offset + 4)
  }
  let page: number | null = 1
  const read = []
  while (page !== null) {
    const result = JSON.parse(await readPrFeedbackPage(api, 'owner/repo', 1, String(page)))
    read.push(...result.inline.map((c: {id:number;body:string}) => ({id:c.id, body:c.body})))
    page = result.nextPage
  }
  assert.deepEqual(read, comments)
  await assert.rejects(readPrFeedbackPage(api, 'owner/repo', 1, '-1'), /page/)
})
