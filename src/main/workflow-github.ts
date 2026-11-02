import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { findWindowsExecutable } from './resolve-copilot.js'
import { findPosixExecutable } from './posix-executables.js'

export type GithubApi = (path: string, paged?: boolean) => Promise<unknown>
export interface GithubFeedback {
  source: string; version: string; actorId: number | null; kind: 'review' | 'ci'; body: string; head: string | null; at: number
}
export interface GithubSnapshot {
  repository: string; headRepository: string; branch: string; head: string; base: string; open: boolean;
  checks: 'absent' | 'pending' | 'failed' | 'complete'; feedback: GithubFeedback[]
}
export function validGithubRepository(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..' && part.length <= 100)
}
export function parseGithubPullUrl(value: string): { repository: string; number: number } {
  const url = new URL(value)
  const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search
    || !match || !validGithubRepository(match[1]!) || !Number.isSafeInteger(Number(match[2]))) throw new Error('Use a github.com pull request URL')
  return { repository: match[1]!, number: Number(match[2]) }
}
export function githubRemoteRepository(value: string): string | null {
  const ssh = /^git@github\.com:([^\s]+)$/.exec(value.trim())
  let path: string
  try {
    if (ssh) path = ssh[1]!
    else {
      const url = new URL(value.trim())
      if (url.hostname !== 'github.com' || !['https:','ssh:'].includes(url.protocol) || url.search || url.hash) return null
      path = url.pathname.replace(/^\//,'')
    }
    path = path.replace(/\.git$/,'').replace(/\/$/,'')
    return validGithubRepository(path) ? path.toLowerCase() : null
  } catch { return null }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected GitHub response')
  return value as Record<string, unknown>
}
const string = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Unexpected GitHub text'); return value }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const timestamp = (value: unknown): number => typeof value==='string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
async function rows(api: GithubApi, path: string, field?: string): Promise<Record<string, unknown>[]> {
  const pages = await api(path,true)
  if (!Array.isArray(pages)) throw new Error('Incomplete GitHub pagination')
  const result = pages.flatMap(page => {
    const items: unknown = field ? record(page)[field] : page
    if (!Array.isArray(items)) throw new Error('Unexpected GitHub page')
    return items.map(record)
  })
  if (result.length > 1000) throw new Error('GitHub source exceeds its read limit')
  return result
}
/** No partial observation is returned when permissions, pagination or head/base consistency cannot be established. */
export async function readGithubPull(api: GithubApi, repository: string, number: number): Promise<GithubSnapshot> {
  if (!validGithubRepository(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid GitHub source')
  const root = `repos/${repository}`
  const path = `${root}/pulls/${number}`
  const pull = record(await api(path))
  const head = record(pull.head), base = record(pull.base)
  const headSha = string(head.sha), baseSha = string(base.sha)
  if (!/^[a-f0-9]{40,64}$/.test(headSha) || !/^[a-f0-9]{40,64}$/.test(baseSha)) throw new Error('Invalid GitHub revision')
  const result: GithubSnapshot = {repository, headRepository: head.repo ? string(record(head.repo).full_name) : '',
    branch:string(head.ref),head:headSha,base:baseSha,open:pull.state==='open',checks:'absent',feedback:[]}
  if (!result.open) return result
  const [inline, conversation, reviews, checks, statuses] = await Promise.all([
    rows(api,`${path}/comments?per_page=100`), rows(api,`${root}/issues/${number}/comments?per_page=100`),
    rows(api,`${path}/reviews?per_page=100`), rows(api,`${root}/commits/${headSha}/check-runs?per_page=100`,'check_runs'),
    rows(api,`${root}/commits/${headSha}/statuses?per_page=100`),
  ])
  for (const [kind, items] of [['inline',inline],['conversation',conversation],['review',reviews]] as const) {
    for (const item of items) {
      if (!Number.isSafeInteger(item.id) || typeof item.body !== 'string' || !item.body.trim()) continue
      if (kind === 'review' && !['COMMENTED','CHANGES_REQUESTED','APPROVED'].includes(String(item.state))) continue
      const actor = item.user ? record(item.user) : null
      if (!actor || !Number.isSafeInteger(actor.id)) continue
      result.feedback.push({source:`github/${repository}/pull/${number}/${kind}/${item.id}`,
        version:hash([item.updated_at ?? item.submitted_at,item.body,item.state]), actorId:actor.id as number,
        kind:'review',body:item.body,head:typeof item.commit_id==='string' ? item.commit_id : null,at:timestamp(item.updated_at ?? item.submitted_at ?? item.created_at)})
    }
  }
  const newest = (items: Record<string, unknown>[], key: string): Record<string, unknown>[] => {
    const groups = new Map<string, Record<string, unknown>>()
    for (const item of items) {
      const name=string(item[key]);const old=groups.get(name)
      if (!Number.isSafeInteger(item.id)) throw new Error('Invalid GitHub check identity')
      if (!old || Number(item.id)>Number(old.id)) groups.set(name,item)
    }
    return [...groups.values()]
  }
  const currentChecks=newest(checks,'name'), currentStatuses=newest(statuses,'context')
  let pending=false,failed=false
  for (const [kind,items] of [['check',currentChecks],['status',currentStatuses]] as const) {
    for (const item of items) {
      const name=string(item[kind==='check'?'name':'context'])
      const waiting=kind==='check' ? item.status!=='completed' : item.state==='pending'
      const failure=kind==='check' ? ['failure','timed_out'].includes(String(item.conclusion)) && !waiting : ['failure','error'].includes(String(item.state))
      pending ||= waiting;failed ||= failure
      if (failure) result.feedback.push({source:`github/${repository}/pull/${number}/${kind}/${item.id}`,
        version:hash([headSha,item.id,item.conclusion,item.state,item.completed_at]),actorId:null,kind:'ci',
        body:`Check ${name} failed on ${headSha}. Inspect the current check result before deciding what change is needed.`,head:headSha,at:timestamp(item.completed_at ?? item.created_at)})
    }
  }
  result.checks=failed?'failed':pending?'pending':(currentChecks.length+currentStatuses.length?'complete':'absent')
  const verified=record(await api(path))
  if (verified.state!==pull.state || record(verified.head).sha!==headSha || record(verified.base).sha!==baseSha) throw new Error('GitHub source changed during collection')
  return result
}

/** Uses an absolute gh executable and a non-project cwd, never a shell or repository command. */
export async function githubCliApi(cwd: string): Promise<GithubApi> {
  const executable=await (process.platform==='win32' ? findWindowsExecutable('gh') : findPosixExecutable('gh'))
  if (!executable || !isAbsolute(executable)) throw new Error('Install GitHub CLI and sign in before enabling follow-ups')
  return (path,paged=false) => new Promise((resolve,reject) => {
    const args=['api','--hostname','github.com',path,...(paged?['--paginate','--slurp']:[])]
    execFile(executable,args,{cwd,env:{...process.env,GH_PROMPT_DISABLED:'1'},windowsHide:true,timeout:30_000,maxBuffer:2*1024*1024},(error,stdout) => {
      if (error) {reject(new Error('GitHub source is unavailable; check authentication, permissions, rate limits, or source size'));return}
      try {resolve(JSON.parse(stdout))} catch {reject(new Error('GitHub returned an invalid response'))}
    })
  })
}
