import type { GithubApi } from './workflow-github.js'

/** Four full GitHub comments per collection fit comfortably within the CLI transport's per-request limit. */
export async function readPrFeedbackPage(api: GithubApi, repository: string, number: number, page = '1'): Promise<string> {
  if (!/^[1-9][0-9]{0,7}$/.test(page)) throw new Error('Invalid feedback page')
  const root = `repos/${repository}`, path = `${root}/pulls/${number}`
  const size = 4
  async function rows(route: string): Promise<Record<string, any>[]> {
    const value = await api(`${route}?per_page=${size}&page=${page}`)
    if (!Array.isArray(value) || !value.every(item => item && typeof item === 'object')) throw new Error('Invalid GitHub page')
    return value
  }
  const [pull, inline, conversation, reviews] = await Promise.all([
    api(path) as Promise<Record<string, any>>, rows(path + '/comments'), rows(root + '/issues/' + number + '/comments'), rows(path + '/reviews'),
  ])
  return JSON.stringify({ repository, number, state:pull.state, title:pull.title, author:pull.user?.login,
    head:pull.head?.sha, base:pull.base?.sha, baseRef:pull.base?.ref,
    reviews:reviews.map(r => ({id:r.id, user:r.user?.login, state:r.state, commit:r.commit_id, body:r.body})),
    inline:inline.map(c => ({id:c.id, user:c.user?.login, path:c.path, line:c.line??c.original_line, inReplyTo:c.in_reply_to_id??null, commit:c.commit_id, body:c.body})),
    conversation:conversation.map(c => ({id:c.id, user:c.user?.login, body:c.body})),
    nextPage:[reviews, inline, conversation].some(items => items.length === size) ? Number(page) + 1 : null })
}
