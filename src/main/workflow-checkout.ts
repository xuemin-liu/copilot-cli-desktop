import { enclosingRepository } from './git-discovery.js'
import { ceilingDirectories } from './git-env.js'
import { scanRepoConfig, type GitTrustStore } from './git-trust.js'
import type { GitRunner } from './git-runner.js'
import { githubRemoteRepository, type GithubSnapshot } from './workflow-github.js'

/** Use the Git panel's filesystem/config trust checks before inspecting a checkout for unattended work. */
export async function verifyWorkflowCheckout(folder:string, snapshot:GithubSnapshot, runner:GitRunner, trust:GitTrustStore):Promise<void> {
  const repo=await enclosingRepository(folder)
  if(repo.kind!=='found'||repo.issue)throw new Error('Open a local Git checkout before enabling follow-ups')
  const scan=await scanRepoConfig(runner,repo.root)
  if(scan.items.length&&!await trust.isTrusted(repo.root,scan.hash))throw new Error('Review this repository’s settings in the Git panel first')
  const ceiling=ceilingDirectories(repo.root)
  const read=async(args:readonly string[]):Promise<string>=>{
    const result=await runner.run({cwd:repo.root,args,kind:'read',timeoutMs:30_000,maxStdoutBytes:64_000,
      environment:ceiling?{extra:{GIT_CEILING_DIRECTORIES:ceiling}}:undefined})
    if(result.exitCode!==0||result.timedOut||result.cancelled||result.stdoutTruncated)throw new Error('Could not verify the current checkout')
    return result.stdout.toString('utf8').trim()
  }
  const remote=await read(['remote','get-url','origin'])
  const branch=await read(['symbolic-ref','--quiet','--short','HEAD'])
  const head=await read(['rev-parse','--verify','HEAD'])
  const status=await read(['status','--porcelain=v1','--untracked-files=normal'])
  if(githubRemoteRepository(remote)!==snapshot.headRepository.toLowerCase()||branch!==snapshot.branch||head!==snapshot.head||status)
    throw new Error('Follow-ups need the clean PR branch at its current head; reconcile local changes first')
}
