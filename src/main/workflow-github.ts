import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { findWindowsExecutable } from './resolve-copilot.js'
import { findPosixExecutable } from './posix-executables.js'

export type GithubApi = (path: string, paged?: boolean) => Promise<unknown>
export interface GithubFeedback {
  /** `head`: the desktop's own note that a review loop's PR moved to a new head or base (no GitHub text). */
  source: string; version: string; actorId: number | null; kind: 'review' | 'ci' | 'head'; body: string; head: string | null; at: number
  /** An inline comment's first commit (`original_commit_id`): where its anchor came from, whatever the PR's head is now. */
  anchor?: string | null
}
/** A submitted review's state, kept apart from its text: an approval often has no body. */
export interface GithubReview {
  id: number; actorId: number; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; commitId: string | null; submittedAt: number; body: string
}
export interface GithubSnapshot {
  repository: string; headRepository: string; branch: string; head: string; base: string; open: boolean; merged?:boolean;
  checks: 'absent' | 'pending' | 'failed' | 'complete'; feedback: GithubFeedback[]
  /** The PR author's account id, when GitHub names one. */
  author?: number | null
  /** The base branch's repository: a PR whose head lives elsewhere comes from a fork. */
  baseRepository?: string
  reviews?: GithubReview[]
}
export interface GithubReadOptions {
  /** false: CI is not part of this grant, so check runs and statuses are not read at all. */
  checks?: boolean
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
export async function readGithubPull(api: GithubApi, repository: string, number: number, options: GithubReadOptions = {}): Promise<GithubSnapshot> {
  if (!validGithubRepository(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid GitHub source')
  const root = `repos/${repository}`
  const path = `${root}/pulls/${number}`
  const pull = record(await api(path))
  const head = record(pull.head), base = record(pull.base)
  const headSha = string(head.sha), baseSha = string(base.sha)
  if (!/^[a-f0-9]{40,64}$/.test(headSha) || !/^[a-f0-9]{40,64}$/.test(baseSha)) throw new Error('Invalid GitHub revision')
  const author = pull.user && typeof pull.user === 'object' && Number.isSafeInteger((pull.user as Record<string, unknown>).id) ? (pull.user as Record<string, unknown>).id as number : null
  const result: GithubSnapshot = {repository, headRepository: head.repo ? string(record(head.repo).full_name) : '',
    branch:string(head.ref),head:headSha,base:baseSha,open:pull.state==='open',merged:pull.merged===true,checks:'absent',feedback:[],author,reviews:[],
    baseRepository: base.repo ? string(record(base.repo).full_name) : ''}
  if (!result.open) return result
  const readChecks = options.checks !== false
  const [inline, conversation, reviews, checks, statuses] = await Promise.all([
    rows(api,`${path}/comments?per_page=100`), rows(api,`${root}/issues/${number}/comments?per_page=100`),
    rows(api,`${path}/reviews?per_page=100`),
    readChecks ? rows(api,`${root}/commits/${headSha}/check-runs?per_page=100`,'check_runs') : Promise.resolve([]),
    readChecks ? rows(api,`${root}/commits/${headSha}/statuses?per_page=100`) : Promise.resolve([]),
  ])
  for (const item of reviews) {
    const actor = item.user && typeof item.user === 'object' ? item.user as Record<string, unknown> : null
    if (!Number.isSafeInteger(item.id) || !actor || !Number.isSafeInteger(actor.id)) continue
    const state = String(item.state)
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'COMMENTED' && state !== 'DISMISSED') continue
    result.reviews!.push({ id: item.id as number, actorId: actor.id as number, state, commitId: typeof item.commit_id === 'string' ? item.commit_id : null,
      submittedAt: timestamp(item.submitted_at), body: typeof item.body === 'string' ? item.body : '' })
  }
  for (const [kind, items] of [['inline',inline],['conversation',conversation],['review',reviews]] as const) {
    for (const item of items) {
      if (!Number.isSafeInteger(item.id) || typeof item.body !== 'string' || !item.body.trim()) continue
      if (kind === 'review' && !['COMMENTED','CHANGES_REQUESTED','APPROVED'].includes(String(item.state))) continue
      const actor = item.user ? record(item.user) : null
      if (!actor || !Number.isSafeInteger(actor.id)) continue
      result.feedback.push({source:`github/${repository}/pull/${number}/${kind}/${item.id}`,
        version:hash([item.updated_at ?? item.submitted_at,item.body,item.state]), actorId:actor.id as number,
        kind:'review',body:item.body,head:typeof item.commit_id==='string' ? item.commit_id : null,at:timestamp(item.updated_at ?? item.submitted_at ?? item.created_at),
        ...(kind === 'inline' ? { anchor: typeof item.original_commit_id === 'string' ? item.original_commit_id : null } : {})})
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

/** GitHub answered the write with a client error (4xx): it created nothing. `detail` is GitHub's own short reason. */
export class GithubWriteRefused extends Error { constructor(readonly status: number, readonly detail: string) { super(`GitHub refused the write (HTTP ${status})`) } }

/**
 * Why a gh write failed. gh prints "HTTP <status>" for an answer it got. Only a 4xx says for sure that nothing was
 * created; a timeout, a network error or a 5xx may still have landed, and goes to reconciliation.
 */
export function writeFailure(stderr: string): Error {
  const status = Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1])
  if (status >= 400 && status < 500) return new GithubWriteRefused(status, stderr.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300))
  return new Error('GitHub did not confirm the write')
}

/** One write. The body goes in on stdin as JSON, so no text a model wrote ever becomes a command-line argument. */
export type GithubWrite = (method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>) => Promise<unknown>

/** The desktop's only GitHub write path: the PR helper uses it after its checks (pr-loop-posts.ts). */
export async function githubCliWrite(cwd: string): Promise<GithubWrite> {
  const executable=await (process.platform==='win32' ? findWindowsExecutable('gh') : findPosixExecutable('gh'))
  if (!executable || !isAbsolute(executable)) throw new Error('Install GitHub CLI and sign in before enabling follow-ups')
  return (method,path,body) => new Promise((resolve,reject) => {
    if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pulls|issues)\/[0-9a-z/_-]+$/.test(path)) { reject(new Error('Invalid GitHub write route')); return }
    const child=spawn(executable,['api','--hostname','github.com','-X',method,path,'--input','-'],{cwd,env:{...process.env,GH_PROMPT_DISABLED:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']})
    let stdout='',stderr='',size=0
    const timer=setTimeout(()=>{child.kill();reject(new Error('GitHub did not answer the write in time'))},60_000)
    child.stdout.setEncoding('utf8').on('data',chunk=>{size+=chunk.length;if(size<=2*1024*1024)stdout+=chunk})
    child.stderr.setEncoding('utf8').on('data',chunk=>{if(stderr.length<8000)stderr+=chunk})
    child.on('error',()=>{clearTimeout(timer);reject(new Error('GitHub CLI could not start'))})
    child.on('close',code=>{
      clearTimeout(timer)
      if(code!==0){reject(writeFailure(stderr));return}
      try{resolve(JSON.parse(stdout))}catch{reject(new Error('GitHub returned an invalid response'))}
    })
    child.stdin.end(JSON.stringify(body))
  })
}

/**
 * A failed read, with what the loops act on: GitHub's status (404: no such PR yet) and whether it was a rate limit, so
 * polling backs off instead of spending what is left. The message never carries gh's output.
 */
export class GithubReadFailed extends Error {
  constructor(readonly status: number | null, readonly rateLimited: boolean) { super('GitHub source is unavailable; check authentication, permissions, rate limits, or source size') }
}
export function readFailure(stderr: string): GithubReadFailed {
  const status = Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1])
  return new GithubReadFailed(Number.isInteger(status) ? status : null, /rate limit/i.test(stderr) || status === 429)
}

/** Uses an absolute gh executable and a non-project cwd, never a shell or repository command. */
export async function githubCliApi(cwd: string): Promise<GithubApi> {
  const executable=await (process.platform==='win32' ? findWindowsExecutable('gh') : findPosixExecutable('gh'))
  if (!executable || !isAbsolute(executable)) throw new Error('Install GitHub CLI and sign in before enabling follow-ups')
  return (path,paged=false) => new Promise((resolve,reject) => {
    const args=['api','--hostname','github.com',path,...(paged?['--paginate','--slurp']:[])]
    execFile(executable,args,{cwd,env:{...process.env,GH_PROMPT_DISABLED:'1'},windowsHide:true,timeout:30_000,maxBuffer:2*1024*1024},(error,stdout,stderr) => {
      if (error) {reject(readFailure(String(stderr??'')));return}
      try {resolve(JSON.parse(stdout))} catch {reject(new Error('GitHub returned an invalid response'))}
    })
  })
}
