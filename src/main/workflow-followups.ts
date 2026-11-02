import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { readGithubPull, parseGithubPullUrl, validGithubRepository, type GithubApi, type GithubSnapshot,type GithubFeedback } from './workflow-github.js'
import type { WorkflowTask } from './workflow-types.js'
import {WorkflowDeliveryRejected,type WorkflowDeliveries,type WorkflowDelivery} from './workflow-deliveries.js'
import {githubBatchInput} from './workflow-feedback-batch.js'

export interface FollowupDefault {
  revision:string;projectId:string;repository:string;reviewers:{id:number;login:string}[];
  failedChecks:boolean;completeOnMerge:boolean;activatedAt:number
}
export interface FollowupGrant {
  id: string; taskId: string; sessionId: string; projectId: string; scopeRevision: number; permissionKey: string;
  repository: string; number: number; reviewers: {id:number;login:string}[]; failedChecks: boolean; enabled: boolean;
  activatedAt: number; seen: Record<string,string>; head: string; headCounts: Record<string,number>; total: number;
  health: 'watching'|'paused'|'closed'|'source-unavailable'|'needs-person'|'limit'|'scope-changed'|'source-too-large';
  completeOnMerge?:boolean;checks: GithubSnapshot['checks']
}
export interface FollowupHost {
  api: GithubApi; journal: WorkflowDeliveries; task(id:string): WorkflowTask|null;
  permissionKey(task:WorkflowTask): string|null;
  ready?(grant:FollowupGrant): boolean;
  projectAvailable?(projectId:string):boolean;
  complete?(task:WorkflowTask,snapshot:GithubSnapshot,grant:FollowupGrant):void;
  verifyRepository(task:WorkflowTask,snapshot:GithubSnapshot): Promise<void>;
  send(delivery:WorkflowDelivery,grant:FollowupGrant): Promise<'sent'|'busy'>;
  interrupt(grant:FollowupGrant): void;
  changed(): void;
  now?: () => number
}
const terminal=(task:WorkflowTask): boolean => task.outcome==='completed'||task.outcome==='cancelled'
const uuid=(value:unknown): boolean => typeof value==='string' && /^[a-f0-9-]{36}$/.test(value)

/** Explicit per-task enrollment only. Source text cannot create/modify grants or restart paused work. */
export class WorkflowFollowups {
  private db: DatabaseSync
  private busy=false
  private started=false
  failed=false
  private timer: ReturnType<typeof setTimeout>|null=null
  private stopped=false
  private readonly now:()=>number
  private readonly nextPoll=new Map<string,number>()
  private readonly retryAt=new Map<string,number>()
  private readonly failures=new Map<string,number>()
  private readonly deliveryRetryAt=new Map<string,number>()
  private readonly defaultWrites=new Map<string,string>()
  private readonly busyAttempts=new Map<string,number>()
  constructor(path:string,private readonly host:FollowupHost) {
    this.now=host.now??Date.now
    this.db=new DatabaseSync(path)
    try {
      const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version
      if(version!==0&&version!==1)throw new Error('Unsupported follow-up schema')
      this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS followups(id TEXT PRIMARY KEY,task TEXT UNIQUE NOT NULL,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS followup_defaults(project TEXT PRIMARY KEY,value TEXT NOT NULL);
        PRAGMA user_version=1;`)
    } catch(error){this.db.close();throw error}
  }
  list():FollowupGrant[] {
    return (this.db.prepare('SELECT value FROM followups ORDER BY rowid DESC LIMIT 1000').all() as {value:string}[]).map(row=>this.decode(row.value))
  }
  grant(id:string):FollowupGrant|null {
    const row=this.db.prepare('SELECT value FROM followups WHERE id=?').get(id) as {value:string}|undefined
    return row?this.decode(row.value):null
  }
  defaults():FollowupDefault[]{
    return (this.db.prepare('SELECT value FROM followup_defaults LIMIT 100').all() as {value:string}[]).map(row=>{
      const value=JSON.parse(row.value) as FollowupDefault
      if(!value||!uuid(value.revision)||typeof value.projectId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(value.projectId)
        ||!validGithubRepository(value.repository)||!Number.isFinite(value.activatedAt)||typeof value.failedChecks!=='boolean'||typeof value.completeOnMerge!=='boolean'
        ||!Array.isArray(value.reviewers)||value.reviewers.length>10||!value.reviewers.every(actor=>actor&&Number.isSafeInteger(actor.id)&&actor.id>0&&typeof actor.login==='string'&&/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(actor.login)&&actor.login.length<=100))throw new Error('Invalid project follow-up defaults')
      return value
    })
  }
  async saveDefault(projectId:string,repository:string,names:readonly string[],failedChecks:boolean,completeOnMerge:boolean):Promise<FollowupDefault>{
    if(typeof projectId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(projectId)||!validGithubRepository(repository)||!Array.isArray(names)||names.length>10
      ||typeof failedChecks!=='boolean'||typeof completeOnMerge!=='boolean')throw new Error('Invalid project defaults')
    const revision=randomUUID();this.defaultWrites.set(projectId,revision)
    const repo=await this.host.api(`repos/${repository}`) as {full_name?:unknown}
    if(!repo||typeof repo.full_name!=='string'||repo.full_name.toLowerCase()!==repository.toLowerCase())throw new Error('The default repository could not be verified')
    const reviewers:FollowupDefault['reviewers']=[]
    for(const login of new Set(names)){
      if(typeof login!=='string'||!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(login)||login.length>100)throw new Error('Use GitHub reviewer logins')
      const actor=await this.host.api(`users/${encodeURIComponent(login)}`) as {id?:unknown;login?:unknown}
      if(!actor||!Number.isSafeInteger(actor.id)||Number(actor.id)<=0||typeof actor.login!=='string'||actor.login.toLowerCase()!==login.toLowerCase())throw new Error('Reviewer identity could not be verified')
      reviewers.push({id:actor.id as number,login:actor.login})
    }
    if(!reviewers.length&&!failedChecks)throw new Error('Choose reviewers or failed checks')
    if(this.stopped||this.defaultWrites.get(projectId)!==revision||this.host.projectAvailable?.(projectId)===false)throw new Error('Project defaults changed while access was checked')
    if(this.defaults().length>=100&&!this.defaults().some(value=>value.projectId===projectId))throw new Error('Project default limit reached')
    const value:FollowupDefault={revision,projectId,repository,reviewers,failedChecks,completeOnMerge,activatedAt:this.now()}
    this.db.prepare('INSERT INTO followup_defaults(project,value) VALUES(?,?) ON CONFLICT(project) DO UPDATE SET value=excluded.value').run(projectId,JSON.stringify(value));this.host.changed();return value
  }
  removeDefault(projectId:string):void{
    if(typeof projectId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(projectId))throw new Error('Invalid project')
    this.defaultWrites.set(projectId,randomUUID());this.db.prepare('DELETE FROM followup_defaults WHERE project=?').run(projectId);this.host.changed()
  }
  async enroll(taskId:string,url:string,reviewerLogins:readonly string[],failedChecks:boolean,completeOnMerge=false):Promise<FollowupGrant> {
    if(!uuid(taskId)||typeof url!=='string'||url.length>300||!Array.isArray(reviewerLogins)||reviewerLogins.length>10||typeof failedChecks!=='boolean'||typeof completeOnMerge!=='boolean')throw new Error('Invalid follow-up settings')
    if(completeOnMerge&&!this.host.complete)throw new Error('Task completion is unavailable')
    const task=this.host.task(taskId),permissionKey=task?this.host.permissionKey(task):null
    if(!task||terminal(task)||!permissionKey)throw new Error('Open the supported local task session before enrolling it')
    const previous=this.list().find(g=>g.taskId===taskId)
    if(previous?.enabled)throw new Error('Pause the existing enrollment before changing it')
    if(this.list().filter(g=>g.enabled).length>=5)throw new Error('Pause an enrollment before adding another (five active sources maximum)')
    const pull=parseGithubPullUrl(url)
    if(this.list().some(g=>g.enabled&&g.repository.toLowerCase()===pull.repository.toLowerCase()&&g.number===pull.number))throw new Error('This PR already belongs to an enrolled task')
    const reviewers:FollowupGrant['reviewers']=[]
    for(const login of new Set(reviewerLogins)) {
      if(typeof login!=='string'||!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(login)||login.length>100)throw new Error('Use GitHub reviewer logins')
      const actor=await this.host.api(`users/${encodeURIComponent(login)}`) as {id?:unknown;login?:unknown}
      if(!actor||!Number.isSafeInteger(actor.id)||Number(actor.id)<=0||typeof actor.login!=='string'||actor.login.toLowerCase()!==login.toLowerCase())throw new Error('Reviewer identity could not be verified')
      reviewers.push({id:actor.id as number,login:actor.login})
    }
    if(!reviewers.length&&!failedChecks)throw new Error('Choose reviewers or failed CI checks')
    const snapshot=await readGithubPull(this.host.api,pull.repository,pull.number)
    if(!snapshot.open)throw new Error('The pull request is closed')
    await this.host.verifyRepository(task,snapshot)
    if(this.stopped)throw new Error('Follow-ups are stopping')
    const current=this.host.task(taskId)
    if(!current||terminal(current)||current.scopeRevision!==task.scopeRevision||this.host.permissionKey(current)!==permissionKey)throw new Error('Task changed while enrollment was being checked')
    if(this.list().some(g=>g.taskId===taskId&&g.enabled))throw new Error('This task was already enrolled')
    if(this.list().filter(g=>g.enabled).length>=5||this.list().some(g=>g.enabled&&g.repository.toLowerCase()===pull.repository.toLowerCase()&&g.number===pull.number))throw new Error('Enrollment changed while sources were checked; try again')
    if(snapshot.feedback.length>1000)throw new Error('The source exceeds the enrollment limit')
    if(!previous&&this.list().length>=1000)throw new Error('Follow-up enrollment limit reached')
    const grant:FollowupGrant={id:randomUUID(),taskId,sessionId:task.sessionId,projectId:task.projectId,scopeRevision:task.scopeRevision,
      permissionKey,repository:pull.repository,number:pull.number,reviewers,failedChecks,completeOnMerge,enabled:true,activatedAt:this.now(),
      seen:Object.fromEntries(snapshot.feedback.map(event=>[event.source,event.version])),head:snapshot.head,headCounts:{},total:0,health:'watching',checks:snapshot.checks}
    this.save(grant)
    return grant
  }
  pause(id:string):void {
    const grant=this.grant(id)
    if(!grant)throw new Error('Unknown follow-up enrollment')
    this.save({...grant,enabled:false,health:'paused'})
    this.host.journal.cancelScope(id)
    this.host.interrupt(grant)
  }
  hold(projectId?:string):void {
    for(const grant of this.list().filter(g=>g.enabled&&(!projectId||g.projectId===projectId))){this.host.journal.cancelScope(grant.id);this.host.interrupt(grant)}
  }
  async rebaseline(projectId?:string):Promise<void> {
    for(const grant of this.list().filter(g=>g.enabled&&(!projectId||g.projectId===projectId))){
      const snapshot=await this.read(grant)
      if(this.stopped)return
      const current=this.grant(grant.id)
      if(!current?.enabled)continue
      if(snapshot.feedback.length>1000)throw new Error('Follow-up source limit reached; remain paused')
      if(!snapshot.open){
        if(current.completeOnMerge&&snapshot.merged){this.save({...current,health:'needs-person'});this.nextPoll.delete(current.id);continue}
        this.closeGrant(current);continue
      }
      this.save({...current,seen:Object.fromEntries(snapshot.feedback.map(e=>[e.source,e.version])),head:snapshot.head,activatedAt:this.now(),checks:snapshot.checks,health:'watching'})
    }
  }
  authorized(grant:FollowupGrant):boolean {
    if(this.stopped||this.failed)return false
    const current=this.grant(grant.id),task=this.host.task(grant.taskId)
    return Boolean(current?.enabled&&task&&!terminal(task)&&task.sessionId===grant.sessionId&&task.scopeRevision===grant.scopeRevision
      &&this.host.permissionKey(task)===grant.permissionKey&&['working','ready'].includes(task.outcome))
  }
  async tick():Promise<void> {
    if(this.busy||this.stopped)return
    this.busy=true
    try {
      this.prune()
      const initialDeliveries=this.host.journal.list()
      for(const grant of this.list().filter(g=>g.enabled)) {
        if(!this.authorized(grant))this.host.interrupt(grant)
        await this.poll(grant,initialDeliveries)
        if(this.stopped)return
      }
      const deliveries=this.host.journal.list()
      const blocked=new Set(deliveries.filter(d=>['submitting','submitted','uncertain'].includes(d.state)).map(d=>d.sessionId))
      const observations=new Map<string,GithubSnapshot|null>()
      for(const delivery of deliveries.filter(d=>d.state==='queued')) {
        const grant=this.grant(delivery.scope)
        if(!grant?.enabled)continue
        if(!this.authorized(grant)||this.stopped)continue
        if(blocked.has(delivery.sessionId)||Math.max(this.retryAt.get(grant.id)??0,this.deliveryRetryAt.get(grant.id)??0)>this.now()||this.host.ready?.(grant)===false)continue
        // One refreshed, consistent observation immediately precedes every proposed submission.
        if(!observations.has(grant.id)){
          try{observations.set(grant.id,await this.read(grant))}catch{observations.set(grant.id,null);this.health(grant,'source-unavailable')}
        }
        const snapshot=observations.get(grant.id)
        if(!snapshot)continue
        if(this.stopped)return
        if(!snapshot.open){this.settleClosed(grant,snapshot);continue}
        if(!this.authorized(grant))continue
        if(delivery.batch){if(!this.batchCurrent(delivery,snapshot,grant)){this.reconcileBatch(delivery,snapshot,grant);continue}}
        else if(!snapshot.feedback.some(event=>event.source===delivery.source&&delivery.revision===`${snapshot.head}/${event.version}`)){this.host.journal.discard(delivery.id);this.host.changed();continue}
        const task=this.host.task(grant.taskId)
        if(!task)continue
        if(this.host.ready?.(grant)===false){this.deliveryBusy(grant);continue}
        try{await this.host.verifyRepository(task,snapshot)}catch{this.health(grant,'scope-changed');this.deliveryRetryAt.set(grant.id,this.now()+120000);continue}
        if(this.stopped)return
        if(!this.authorized(grant))continue
        try {
          const sent=await this.host.send(delivery,grant)
          if(sent==='sent'){
            this.host.journal.submitted(delivery.id);blocked.add(delivery.sessionId)
            this.busyAttempts.delete(grant.id);this.deliveryRetryAt.delete(grant.id);this.host.changed()
          }else this.deliveryBusy(grant)
        } catch {if(!this.stopped){this.host.journal.uncertain(delivery.id);blocked.add(delivery.sessionId);this.health(grant,'needs-person')}}
      }
    } finally {this.busy=false}
  }
  start():void {
    if(this.started)return
    this.started=true
    const run=async():Promise<void>=>{
      if(this.stopped)return
      try{await this.tick()}catch{if(!this.stopped){this.failed=true;this.host.changed()}}
      if(!this.stopped&&!this.failed){this.timer=setTimeout(()=>{void run()},10_000);this.timer.unref()}
    }
    void run()
  }
  stop():void {this.stopped=true;if(this.timer)clearTimeout(this.timer)}
  close():void {this.stop();this.db.close()}
  private async poll(grant:FollowupGrant,ledger:readonly WorkflowDelivery[]):Promise<void> {
    const currentGrant=this.grant(grant.id);if(!currentGrant?.enabled)return
    grant=this.recoverBudget(currentGrant,ledger)
    const task=this.host.task(grant.taskId)
    if(!task||terminal(task)||task.scopeRevision!==grant.scopeRevision||task.sessionId!==grant.sessionId){this.closeGrant(grant);return}
    if(!['working','ready'].includes(task.outcome)&&!grant.completeOnMerge){this.health(grant,'needs-person');return}
    if(!this.intakeAuthorized(grant,task))return
    if(grant.total>=10&&!grant.completeOnMerge){this.health(grant,'limit');return}
    if(Math.max(this.nextPoll.get(grant.id)??0,this.retryAt.get(grant.id)??0)>this.now())return
    this.nextPoll.set(grant.id,this.now()+120_000)
    let snapshot:GithubSnapshot
    try{snapshot=await this.read(grant)}catch{this.health(grant,'source-unavailable');return}
    if(this.stopped)return
    const current=this.grant(grant.id)
    if(!current?.enabled)return
    const latestTask=this.host.task(grant.taskId)
    if(!latestTask||terminal(latestTask)||latestTask.scopeRevision!==grant.scopeRevision){this.closeGrant(current);return}
    if(!this.intakeAuthorized(current,latestTask))return
    if(!snapshot.open){this.settleClosed(current,snapshot);return}
    if(!['working','ready'].includes(latestTask.outcome)){this.health(current,'needs-person');return}
    if(current.total>=10){this.health(current,'limit');return}
    if(snapshot.feedback.length>1000){this.health(current,'source-too-large');return}
    const next={...current,seen:{...current.seen},head:snapshot.head,headCounts:{...current.headCounts},checks:snapshot.checks,health:'watching' as FollowupGrant['health']}
    const accepted=this.acceptedPairs(ledger.filter(delivery=>delivery.scope===next.id))
    const candidates:GithubFeedback[]=[];let tracked=Object.keys(next.seen).length
    for(const event of snapshot.feedback){
      if(next.seen[event.source]===event.version)continue
      const known=event.source in next.seen
      if(tracked>=1000&&!known){next.health='source-too-large';break}
      if(!known)tracked++
      if((!known&&event.at<next.activatedAt)||!this.eligible(event,next,snapshot.head)||accepted.has(this.eventKey(event.source,event.version))){next.seen[event.source]=event.version;continue}
      candidates.push(event)
    }
    for(let offset=0;offset<candidates.length;offset+=10){
      if(next.total>=10||(next.headCounts[snapshot.head]??0)>=3){next.health='limit';break}
      const events=candidates.slice(offset,offset+10)
      try{this.host.journal.enqueue(githubBatchInput(next.sessionId,next.id,task.request,snapshot.head,events))}catch(error){if(!(error instanceof WorkflowDeliveryRejected))throw error;next.health='source-too-large';break}
      for(const event of events)next.seen[event.source]=event.version
      next.total++;next.headCounts[snapshot.head]=(next.headCounts[snapshot.head]??0)+1
    }
    this.save(next)
  }
  private recoverBudget(grant:FollowupGrant,ledger:readonly WorkflowDelivery[]):FollowupGrant{
    const reservations=new Map<string,string>()
    for(const delivery of ledger.filter(delivery=>delivery.scope===grant.id)){
      const head=delivery.batch?.head??/^([a-f0-9]{40,64})\//.exec(delivery.revision)?.[1]
      if(head)reservations.set(delivery.batch?.reservation??delivery.id,head)
    }
    const headCounts={...grant.headCounts},counts=new Map<string,number>()
    for(const head of reservations.values())counts.set(head,(counts.get(head)??0)+1)
    for(const [head,count]of counts)headCounts[head]=Math.min(3,Math.max(headCounts[head]??0,count))
    const total=Math.min(10,Math.max(grant.total,reservations.size))
    if(total===grant.total&&JSON.stringify(headCounts)===JSON.stringify(grant.headCounts))return grant
    const recovered={...grant,total,headCounts};this.save(recovered);return recovered
  }
  private eligible(event:GithubFeedback,grant:FollowupGrant,head:string):boolean{
    return (event.kind==='ci'?grant.failedChecks:event.actorId!==null&&grant.reviewers.some(actor=>actor.id===event.actorId))&&(event.head===null||event.head===head)
  }
  private eventKey(source:string,version:string):string{return source+'\n'+version}
  private members(delivery:WorkflowDelivery):readonly {source:string;version:string}[]{
    if(delivery.batch)return delivery.batch.members
    const match=/^[a-f0-9]{40,64}\/([a-f0-9]{64})$/.exec(delivery.revision)
    return match?[{source:delivery.source,version:match[1]!}]:[]
  }
  private acceptedPairs(deliveries:readonly WorkflowDelivery[]):Set<string>{
    return new Set(deliveries.flatMap(delivery=>this.members(delivery).map(member=>this.eventKey(member.source,member.version))))
  }
  private batchCurrent(delivery:WorkflowDelivery,snapshot:GithubSnapshot,grant:FollowupGrant):boolean{
    return delivery.batch?.head===snapshot.head&&delivery.batch.members.every(member=>snapshot.feedback.some(event=>event.source===member.source&&event.version===member.version&&this.eligible(event,grant,snapshot.head)))
  }
  private reconcileBatch(delivery:WorkflowDelivery,snapshot:GithubSnapshot,grant:FollowupGrant):void{
    if(!delivery.batch||!this.authorized(grant))return
    if(delivery.batch.head!==snapshot.head){this.host.journal.discard(delivery.id);this.host.changed();return}
    const others=this.host.journal.list().filter(item=>item.scope===grant.id&&item.id!==delivery.id)
    const accepted=this.acceptedPairs(others),reserved=this.acceptedPairs(others.filter(item=>item.state!=='cancelled'))
    const events:GithubFeedback[]=[]
    for(const member of delivery.batch.members){
      const event=snapshot.feedback.find(event=>event.source===member.source)
      if(!event||!this.eligible(event,grant,snapshot.head))continue
      const key=this.eventKey(event.source,event.version)
      if((event.version===member.version?reserved:accepted).has(key))continue
      events.push(event)
    }
    if(!events.length){this.host.journal.discard(delivery.id);this.host.changed();return}
    const task=this.host.task(grant.taskId);if(!task)return
    try{
      const next=this.host.journal.reconcileBatch(delivery.id,githubBatchInput(grant.sessionId,grant.id,task.request,snapshot.head,events,delivery.batch.reservation),()=>this.authorized(grant))
      if(!next)return
      const current=this.grant(grant.id)
      if(current?.enabled){const seen={...current.seen};for(const event of events)seen[event.source]=event.version;this.save({...current,seen})}
      this.host.changed()
    }catch(error){if(!(error instanceof WorkflowDeliveryRejected))throw error;this.health(grant,'source-too-large');this.deliveryBusy(grant)}
  }
  private settleClosed(grant:FollowupGrant,snapshot:GithubSnapshot):void{
    if(this.stopped||this.failed||snapshot.open)return
    const current=this.grant(grant.id),task=this.host.task(grant.taskId)
    if(!current?.enabled)return
    if(snapshot.merged===true&&current.completeOnMerge&&task&&!terminal(task)&&task.sessionId===current.sessionId
      &&task.scopeRevision===current.scopeRevision&&this.host.permissionKey(task)===current.permissionKey)this.host.complete?.(task,snapshot,current)
    this.closeGrant(current)
  }
  private closeGrant(grant:FollowupGrant):void {
    this.save({...grant,enabled:false,health:'closed'})
    this.host.journal.cancelScope(grant.id)
    this.host.interrupt(grant)
  }
  private intakeAuthorized(grant:FollowupGrant,task:WorkflowTask):boolean {
    const key=this.host.permissionKey(task)
    if(key===grant.permissionKey)return true
    // A missing live recipient may be temporary. A different, positively verified fingerprint revokes the grant.
    if(key!==null){
      this.save({...grant,enabled:false,health:'scope-changed'})
      this.host.journal.cancelScope(grant.id);this.host.interrupt(grant)
    }else this.health(grant,'needs-person')
    return false
  }
  private prune():void {
    const grants=this.list()
    for(const grant of grants.filter(g=>!g.enabled))for(const cache of [this.nextPoll,this.retryAt,this.failures,this.deliveryRetryAt,this.busyAttempts])cache.delete(grant.id)
    const retired=grants.filter(grant=>!grant.enabled&&this.host.journal.retireScope(grant.id))
    if(grants.length>=900) {
      for(const grant of retired.slice(-100))this.db.prepare('DELETE FROM followups WHERE id=?').run(grant.id)
    }
  }
  private async read(grant:FollowupGrant):Promise<GithubSnapshot> {
    try {
      const snapshot=await readGithubPull(this.host.api,grant.repository,grant.number)
      const unique=new Map<string,GithubFeedback>()
      for(const event of snapshot.feedback){const old=unique.get(event.source);if(old&&old.version!==event.version)throw new Error('Feedback changed during pagination');unique.set(event.source,event)}
      snapshot.feedback=[...unique.values()]
      this.failures.delete(grant.id);this.retryAt.delete(grant.id)
      return snapshot
    } catch(error) {
      const failures=(this.failures.get(grant.id)??0)+1
      this.failures.set(grant.id,failures)
      this.retryAt.set(grant.id,this.now()+Math.min(1_800_000,120_000*2**Math.min(failures-1,4)))
      throw error
    }
  }
  private health(grant:FollowupGrant,health:FollowupGrant['health']):void {
    if(this.stopped)return
    const current=this.grant(grant.id)
    if(current?.enabled)this.save({...current,health})
  }
  private deliveryBusy(grant:FollowupGrant):void {
    const attempts=(this.busyAttempts.get(grant.id)??0)+1;this.busyAttempts.set(grant.id,attempts)
    this.deliveryRetryAt.set(grant.id,this.now()+Math.min(120000,10000*2**Math.min(attempts-1,4)))
  }
  private save(grant:FollowupGrant):void {
    const value=JSON.stringify(grant)
    const previous=this.db.prepare('SELECT value FROM followups WHERE task=?').get(grant.taskId) as {value:string}|undefined
    if(previous?.value===value)return
    this.db.prepare('INSERT INTO followups(id,task,value) VALUES(?,?,?) ON CONFLICT(task) DO UPDATE SET id=excluded.id,value=excluded.value').run(grant.id,grant.taskId,value)
    this.host.changed()
  }
  private decode(value:string):FollowupGrant {
    const grant=JSON.parse(value) as FollowupGrant
    if(!grant||!uuid(grant.id)||!uuid(grant.taskId)||typeof grant.sessionId!=='string'||typeof grant.projectId!=='string'
      ||!validGithubRepository(grant.repository)||!Number.isSafeInteger(grant.number)||grant.number<1||typeof grant.enabled!=='boolean'
      ||(grant.completeOnMerge!==undefined&&typeof grant.completeOnMerge!=='boolean')||typeof grant.failedChecks!=='boolean'||!Array.isArray(grant.reviewers)||grant.reviewers.length>10||!grant.reviewers.every(r=>r&&Number.isSafeInteger(r.id)&&r.id>0&&typeof r.login==='string')
      ||!grant.seen||typeof grant.seen!=='object'||Array.isArray(grant.seen)||Object.keys(grant.seen).length>1000
      ||!Number.isInteger(grant.total)||grant.total<0||grant.total>10||!Number.isFinite(grant.activatedAt)||typeof grant.permissionKey!=='string'||!/^[a-f0-9]{64}$/.test(grant.permissionKey)
      ||typeof grant.head!=='string'||!/^[a-f0-9]{40,64}$/.test(grant.head)
      ||!Number.isInteger(grant.scopeRevision)||grant.scopeRevision<1||!grant.headCounts||typeof grant.headCounts!=='object'
      ||!Object.entries(grant.seen).every(([key,version])=>key.startsWith('github/')&&key.length<=256&&typeof version==='string'&&/^[a-f0-9]{64}$/.test(version))
      ||!Object.entries(grant.headCounts).every(([key,count])=>/^[a-f0-9]{40,64}$/.test(key)&&Number.isInteger(count)&&count>=0&&count<=3)
      ||!['watching','paused','closed','source-unavailable','needs-person','limit','scope-changed','source-too-large'].includes(grant.health)
      ||!['absent','pending','failed','complete'].includes(grant.checks))throw new Error('Invalid stored follow-up grant')
    return grant
  }
}
