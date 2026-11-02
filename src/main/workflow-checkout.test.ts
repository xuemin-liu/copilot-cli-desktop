import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitFixture } from './fixtures/git-fixture.js'
import { GitTrustStore } from './git-trust.js'
import { verifyWorkflowCheckout } from './workflow-checkout.js'
import type { GithubSnapshot } from './workflow-github.js'

test('unattended checkout verification requires clean matching origin, branch, head, and trusted config',async t=>{
  const f=await createGitFixture();if(!f){t.skip('Git unavailable');return}
  try {
    const root=f.repo('repo'),trust=new GitTrustStore(join(f.root,'trust.json'))
    f.plain(root,'remote','add','origin','https://github.com/owner/repo.git')
    const snapshot:GithubSnapshot={repository:'owner/repo',headRepository:'owner/repo',branch:'main',head:f.plain(root,'rev-parse','HEAD').trim(),base:'b'.repeat(40),open:true,checks:'absent',feedback:[]}
    await verifyWorkflowCheckout(root,snapshot,f.runner,trust)
    await assert.rejects(verifyWorkflowCheckout(root,{...snapshot,head:'c'.repeat(40)},f.runner,trust),/clean PR branch/)
    await assert.rejects(verifyWorkflowCheckout(root,{...snapshot,headRepository:'other/repo'},f.runner,trust),/clean PR branch/)
    await assert.rejects(verifyWorkflowCheckout(root,{...snapshot,branch:'other'},f.runner,trust),/clean PR branch/)
    writeFileSync(join(root,'a.txt'),'dirty')
    await assert.rejects(verifyWorkflowCheckout(root,snapshot,f.runner,trust),/clean PR branch/)
    f.plain(root,'config','filter.probe.clean','echo unwanted')
    await assert.rejects(verifyWorkflowCheckout(root,snapshot,f.runner,trust),/Git panel/)
  }finally{f.cleanup()}
})
