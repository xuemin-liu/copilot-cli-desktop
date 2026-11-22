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
  let page: string | number | null = 1
  const read = new Map<number,string>()
  while (page !== null) {
    const result = JSON.parse(await readPrFeedbackPage(api, 'owner/repo', 1, String(page)))
    for (const c of result.inline) read.set(c.id,(read.get(c.id)??'')+c.body)
    page = result.nextPage
  }
  assert.deepEqual(Array.from(read, ([id,body]) => ({id,body})), comments)
  await assert.rejects(readPrFeedbackPage(api, 'owner/repo', 1, '-1'), /page/)
})

test('all three collections preserve long escaped bodies within the serialized page budget', async () => {
  const body = ('\u0001🙂"\\' + '\n').repeat(3300)
  const input = Array.from({ length: 4 }, (_, id) => ({ id, body: body + id }))
  const api = async (route: string) => !route.includes('?') ? {title:'file',head:{sha:'head'},base:{sha:'base'}}
    : route.includes('page=1') ? input : []
  const assembled = new Map<string,string>()
  let cursor: string | number | null = 1
  for (let calls = 0; cursor !== null; calls++) {
    assert.ok(calls < 500)
    const result = await readPrFeedbackPage(api,'owner/repo',1,String(cursor))
    assert.ok(Buffer.byteLength(result) <= 12000, 'page exceeds the shell output budget')
    const page = JSON.parse(result)
    for (const kind of ['inline','reviews','conversation']) for(const item of page[kind]) {
      const key = kind + item.id
      const before = assembled.get(key) ?? ''
      assert.equal(item.bodyOffset ?? 0,before.length)
      assembled.set(key,before + item.body)
    }
    cursor = page.nextPage
  }
  for(const kind of ['inline','reviews','conversation']) for(const item of input) assert.equal(assembled.get(kind+item.id),item.body)
})
