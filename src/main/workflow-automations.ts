import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { redactDiagnosticText } from './desktop-diagnostics.js'
import { validGithubRepository, type GithubApi } from './workflow-github.js'
import { readAutomationEvents,resolveAutomationActors,type AutomationActor,type AutomationEvent,type AutomationTemplate } from './workflow-automation-source.js'
/** Only the host may assert that it refused before creating a session, checkout or submitting input. */
export class AutomationLaunchRefused extends Error {}

export interface AutomationRule {id:string;revision:string;projectId:string;scopeKey:string;repository:string;template:AutomationTemplate;actors:AutomationActor[];mode:'off'|'preview'|'automatic';seen:Record<string,string>;activatedAt:number;health:string;launches:number;day:number;dayLaunches:number}
export interface AutomationPreview {id:string;ruleId:string;revision:string;key:string;version:string;title:string;summary:string;createdAt:number;state:'preview'|'launching'|'started'|'uncertain'|'stale'|'overlap'|'limit';refusal?:string;sessionId?:string;taskId?:string}
export interface AutomationHost {api:GithubApi;changed():void;interrupt(projectId?:string):void;ready(projectId:string):boolean;
  scopeKey(projectId:string):string|null;
  launch(rule:AutomationRule,event:AutomationEvent,authorized:()=>boolean):Promise<{sessionId:string;taskId:string}>;now?:()=>number}
const clean=(value:string,max:number):string=>{
  let result=redactDiagnosticText(value.replace(/[\p{Cf}\p{Cc}]/gu,' '))
  // Cutting a redaction placeholder in half can expand again on decode. Keep stored values bounded and idempotent.
  while(result.length>max)result=redactDiagnosticText(result.slice(0,Math.max(0,max-16)))
  return result
}
const terminalPreview=(state:string):boolean=>!['launching','uncertain'].includes(state)

/** Person-owned rules. Source payloads cannot enable rules or change the fixed investigation launch profile. */
export class WorkflowAutomations {
  private db:DatabaseSync;private busy=false;private stopped=false;private timer:NodeJS.Timeout|null=null
  private next=new Map<string,number>();private failures=new Map<string,number>();private now:()=>number
  private pauseEpoch=0
  private readonly nextLaunch=new Map<string,number>()
  failed=false
  constructor(path:string,private host:AutomationHost){
    this.now=host.now??Date.now;this.db=new DatabaseSync(path)
    try{
      const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version
      if(version!==0&&version!==1)throw new Error('Unsupported automation schema')
      this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,rule TEXT NOT NULL,revision TEXT NOT NULL,source TEXT NOT NULL,version TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(rule,revision,source,version));
        CREATE TABLE IF NOT EXISTS owners(source TEXT PRIMARY KEY,preview TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS switches(id TEXT PRIMARY KEY,value TEXT NOT NULL);
        PRAGMA user_version=1;`)
      for(const preview of this.previews().filter(p=>p.state==='launching'))this.savePreview({...preview,state:'uncertain'})
    }catch(error){this.db.close();throw error}
  }
  rules():AutomationRule[]{return (this.db.prepare('SELECT value FROM rules ORDER BY rowid').all() as {value:string}[]).map(row=>this.ruleValue(row.value))}
  previews():AutomationPreview[]{return (this.db.prepare('SELECT value FROM previews ORDER BY rowid DESC').all() as {value:string}[]).map(row=>this.previewValue(row.value))}
  paused(projectId?:string):boolean {
    const ids=projectId?['all',`project/${projectId}`]:['all']
    return ids.some(id=>(this.db.prepare('SELECT value FROM switches WHERE id=?').get(id) as {value:string}|undefined)?.value==='paused')
  }
  projectPaused(projectId:string):boolean {return (this.db.prepare('SELECT value FROM switches WHERE id=?').get(`project/${projectId}`) as {value:string}|undefined)?.value==='paused'}
  async setPaused(paused:boolean,projectId?:string):Promise<void>{
    if(typeof paused!=='boolean'||(projectId!==undefined&&(typeof projectId!=='string'||projectId.length>200)))throw new Error('Invalid pause control')
    const epoch=++this.pauseEpoch
    // Keep paused throughout a refresh. Resuming never executes accumulated source backlog.
    if(!paused)for(const rule of this.rules().filter(r=>r.mode!=='off'&&(!projectId||r.projectId===projectId))){
      const events=await this.read(rule);if(this.stopped)return
      const current=this.rules().find(r=>r.id===rule.id)
      if(epoch!==this.pauseEpoch||current?.revision!==rule.revision)throw new Error('Pause or rule changed while resuming; try again')
      this.saveRule({...current,revision:randomUUID(),seen:Object.fromEntries(events.map(e=>[e.key,e.version])),activatedAt:this.now()})
    }
    if(epoch!==this.pauseEpoch)throw new Error('Pause changed while resuming; try again')
    this.db.prepare('INSERT OR REPLACE INTO switches VALUES(?,?)').run(projectId?`project/${projectId}`:'all',paused?'paused':'running')
    if(paused)this.host.interrupt(projectId)
    this.host.changed()
  }
  async configure(projectId:string,repository:string,template:AutomationTemplate,names:string[],id?:string):Promise<void>{
    if(typeof projectId!=='string'||!projectId||projectId.length>200||!validGithubRepository(repository)||!['assigned-issue','default-ci'].includes(template))throw new Error('Invalid automation settings')
    const previous=id?this.rules().find(r=>r.id===id):undefined
    const scopeKey=this.host.scopeKey(projectId)
    if(!scopeKey)throw new Error('Select a supported local project first')
    if(id&&!previous)throw new Error('Unknown automation rule')
    if(!previous&&this.rules().length>=5)throw new Error('Five rules maximum')
    const actors=await resolveAutomationActors(this.host.api,template,names)
    const events=await readAutomationEvents(this.host.api,repository,template)
    if(this.stopped)return
    if(this.host.scopeKey(projectId)!==scopeKey)throw new Error('Project settings changed; try again')
    const current=previous?this.rules().find(r=>r.id===id):undefined
    if(previous&&current?.revision!==previous.revision)throw new Error('Rule changed; try again')
    if(!previous&&this.rules().length>=5)throw new Error('Five rules maximum')
    if(previous)this.host.interrupt(previous.projectId)
    this.saveRule({id:previous?.id??randomUUID(),revision:randomUUID(),projectId,scopeKey,repository:repository.toLowerCase(),template,actors,mode:'preview',
      seen:Object.fromEntries(events.map(e=>[e.key,e.version])),activatedAt:this.now(),health:'preview',launches:current?.launches??0,day:current?.day??Math.floor(this.now()/86400000),dayLaunches:current?.dayLaunches??0})
  }
  async setMode(id:string,mode:AutomationRule['mode']):Promise<void>{
    if(!['off','preview','automatic'].includes(mode))throw new Error('Invalid rule mode')
    const rule=this.rules().find(r=>r.id===id);if(!rule)throw new Error('Unknown rule')
    const events=mode==='off'?[]:await this.read(rule)
    if(this.stopped)return
    const current=this.rules().find(r=>r.id===id)
    if(current?.revision!==rule.revision)throw new Error('Rule changed; try again')
    this.saveRule({...current,mode,revision:randomUUID(),seen:Object.fromEntries(events.map(e=>[e.key,e.version])),activatedAt:this.now(),health:mode})
    if(mode!=='automatic')this.host.interrupt(rule.projectId)
  }
  async startPreview(id:string):Promise<void>{
    if(this.busy)throw new Error('Automation is checking sources; try again shortly')
    this.busy=true
    try{
    const preview=this.previews().find(p=>p.id===id),rule=preview?this.rules().find(r=>r.id===preview.ruleId):null
    if(!preview||!rule||preview.state!=='preview'||rule.revision!==preview.revision||rule.mode==='off')throw new Error('This preview is stale; wait for current evidence')
    await this.dispatch(rule,preview,true)
    }finally{this.busy=false}
  }
  private permitted(rule:AutomationRule,manual=false):boolean {
    if(this.stopped||this.failed)return false
    const current=this.rules().find(r=>r.id===rule.id)
    return !this.stopped&&!this.failed&&!this.paused(rule.projectId)&&this.host.scopeKey(rule.projectId)===rule.scopeKey&&current?.revision===rule.revision&&(manual?current.mode!=='off':current.mode==='automatic')
  }
  async tick():Promise<void>{
    if(this.stopped||this.busy||this.failed)return
    this.busy=true
    try {
      for(const rule of this.rules()){
        if(rule.mode==='off'||this.paused(rule.projectId)||(this.next.get(rule.id)??0)>this.now())continue
        this.next.set(rule.id,this.now()+120000)
        let events:AutomationEvent[]
        try{events=await this.read(rule);this.failures.delete(rule.id)}catch{
          if(this.stopped)return
          const failures=(this.failures.get(rule.id)??0)+1;this.failures.set(rule.id,failures)
          this.next.set(rule.id,this.now()+Math.min(1800000,120000*2**Math.min(failures-1,4)))
          this.saveRule({...rule,health:'source unavailable'});continue
        }
        if(this.stopped)return
        const current=this.rules().find(r=>r.id===rule.id)
        if(current?.revision!==rule.revision||current.mode==='off'||this.paused(rule.projectId))continue
        const updated={...current,seen:{...current.seen},health:current.mode as string}
        for(const event of events){
          if(updated.seen[event.key]===event.version)continue
          if(!Object.hasOwn(updated.seen,event.key)&&event.at<updated.activatedAt){updated.seen[event.key]=event.version;continue}
          if(!Object.hasOwn(updated.seen,event.key)&&Object.keys(updated.seen).length>=1000){updated.health='source limit';break}
          if(!rule.actors.some(a=>a.id===event.actorId)){updated.seen[event.key]=event.version;continue}
          if(!this.retain(rule.projectId)){updated.health='history limit';break}
          const preview:AutomationPreview={id:randomUUID(),ruleId:rule.id,revision:rule.revision,key:event.key,version:event.version,
            title:clean(event.title,120),summary:clean(`Matched ${rule.template}; allowed actor ${event.actorId}. ${event.body}`,2000),createdAt:this.now(),state:'preview'}
          this.savePreview(preview);updated.seen[event.key]=event.version
        }
        this.saveRule(updated)
      }
      for(const preview of this.previews().filter(p=>p.state==='preview').reverse()){
        const rule=this.rules().find(r=>r.id===preview.ruleId)
        if(rule&&rule.revision===preview.revision&&rule.mode==='automatic'&&this.permitted(rule))await this.dispatch(rule,preview)
      }
    }finally{this.busy=false}
  }
  start():void {if(this.timer||this.stopped)return;const run=async():Promise<void>=>{
    try{await this.tick()}catch{if(!this.stopped){this.failed=true;this.host.changed()}}
    if(!this.stopped&&!this.failed){this.timer=setTimeout(()=>{void run()},10000);this.timer.unref()}
  };void run()}
  stop():void{this.stopped=true;if(this.timer)clearTimeout(this.timer)}
  close():void{this.stop();this.db.close()}
  private async dispatch(rule:AutomationRule,preview:AutomationPreview,manual=false):Promise<void>{
    if(!this.permitted(rule,manual)||!this.host.ready(rule.projectId))return
    if(!manual&&(this.nextLaunch.get(preview.id)??0)>this.now())return
    const day=Math.floor(this.now()/86400000),count=rule.day===day?rule.dayLaunches:0
    if(rule.launches>=10||count>=3){this.savePreview({...preview,state:'limit'});return}
    let events:AutomationEvent[]
    try{events=await this.read(rule)}catch{if(!this.stopped)this.saveRule({...rule,health:'source unavailable'});return}
    if(!this.permitted(rule,manual))return
    const event=events.find(e=>e.key===preview.key&&e.version===preview.version&&rule.actors.some(a=>a.id===e.actorId))
    if(!event){this.savePreview({...preview,state:'stale'});return}
    // One durable owner per source across all rules, revisions and restarts. Ambiguous launches never retry themselves.
    this.db.exec('BEGIN IMMEDIATE')
    try{
      if(this.db.prepare('SELECT source FROM owners WHERE source=?').get(event.key)){
        this.savePreview({...preview,state:'overlap'});this.db.exec('COMMIT');return
      }
      this.db.prepare('INSERT INTO owners VALUES(?,?)').run(event.key,preview.id)
      this.savePreview({...preview,state:'launching'})
      this.saveRule({...rule,launches:rule.launches+1,day,dayLaunches:count+1})
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
    try{
      const receipt=await this.host.launch(rule,event,()=>this.permitted(rule,manual))
      if(!this.stopped)this.savePreview({...preview,...receipt,state:'started'})
    }catch(error){
      if(this.stopped)return
      if(error instanceof AutomationLaunchRefused){
        // This typed host assertion is emitted only before session/worktree creation. Refund exactly our reservation.
        this.db.exec('BEGIN IMMEDIATE')
        try{
          const owner=this.db.prepare('SELECT preview FROM owners WHERE source=?').get(preview.key) as {preview:string}|undefined
          if(owner?.preview!==preview.id)throw new Error('Launch ownership changed')
          this.db.prepare('DELETE FROM owners WHERE source=? AND preview=?').run(preview.key,preview.id)
          const current=this.rules().find(r=>r.id===rule.id)
          if(!current)throw new Error('Launch rule is missing')
          this.saveRule({...current,launches:Math.max(0,current.launches-1),dayLaunches:current.day===day?Math.max(0,current.dayLaunches-1):current.dayLaunches})
          this.savePreview({...preview,state:'preview',refusal:clean(error.message,300)})
          this.db.exec('COMMIT')
          this.nextLaunch.set(preview.id,this.now()+120000)
        }catch(failure){this.db.exec('ROLLBACK');throw failure}
      }else this.savePreview({...preview,state:'uncertain'})
    }
  }
  private async read(rule:AutomationRule):Promise<AutomationEvent[]>{return readAutomationEvents(this.host.api,rule.repository,rule.template)}
  private retain(projectId:string):boolean{
    const ids=new Set(this.rules().filter(r=>r.projectId===projectId).map(r=>r.id))
    const rows=this.previews().filter(p=>ids.has(p.ruleId))
    for(const preview of rows.filter(p=>p.createdAt<this.now()-30*86400000&&terminalPreview(p.state)))this.db.prepare('DELETE FROM previews WHERE id=?').run(preview.id)
    const remaining=this.previews().filter(p=>ids.has(p.ruleId))
    if(remaining.length>=1000){const oldest=remaining.filter(p=>terminalPreview(p.state)).at(-1);if(!oldest)return false;this.db.prepare('DELETE FROM previews WHERE id=?').run(oldest.id)}
    // Owner tombstones outlive preview retention. Refuse new launches once the bounded ownership ledger fills.
    return (this.db.prepare('SELECT COUNT(*) AS n FROM owners').get() as {n:number}).n<1000
  }
  private saveRule(rule:AutomationRule):void {this.db.prepare('INSERT OR REPLACE INTO rules VALUES(?,?)').run(rule.id,JSON.stringify(rule));this.host.changed()}
  private savePreview(p:AutomationPreview):void {this.db.prepare('INSERT INTO previews VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(p.id,p.ruleId,p.revision,p.key,p.version,JSON.stringify(p));this.host.changed()}
  private ruleValue(value:string):AutomationRule {
    const r=JSON.parse(value) as AutomationRule
    if(!r||!/^[-a-f0-9]{36}$/.test(r.id)||!/^[-a-f0-9]{36}$/.test(r.revision)||typeof r.projectId!=='string'||!validGithubRepository(r.repository)
      ||!['assigned-issue','default-ci'].includes(r.template)||!['off','preview','automatic'].includes(r.mode)||!Array.isArray(r.actors)||r.actors.length>10
      ||!r.actors.every(a=>Number.isSafeInteger(a.id)&&a.id>0&&typeof a.login==='string'&&/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(a.login)&&a.kind===(r.template==='assigned-issue'?'user':'app'))
      ||typeof r.scopeKey!=='string'||!/^[a-f0-9]{64}$/.test(r.scopeKey)||!r.seen||Object.keys(r.seen).length>1000||!Object.entries(r.seen).every(([k,v])=>k.startsWith('github/')&&k.length<=300&&/^[a-f0-9]{64}$/.test(v))
      ||!Number.isFinite(r.activatedAt)||typeof r.health!=='string'||r.health.length>100||!Number.isInteger(r.launches)||r.launches<0||r.launches>10||!Number.isInteger(r.day)||!Number.isInteger(r.dayLaunches)||r.dayLaunches<0||r.dayLaunches>3)throw new Error('Invalid automation record')
    return r
  }
  private previewValue(value:string):AutomationPreview {
    const p=JSON.parse(value) as AutomationPreview
    if(!p||!/^[-a-f0-9]{36}$/.test(p.id)||!/^[-a-f0-9]{36}$/.test(p.ruleId)||!/^[-a-f0-9]{36}$/.test(p.revision)||typeof p.key!=='string'||!p.key.startsWith('github/')||p.key.length>300||!/^[a-f0-9]{64}$/.test(p.version)
      ||typeof p.title!=='string'||p.title!==clean(p.title,120)||typeof p.summary!=='string'||p.summary!==clean(p.summary,2000)||!Number.isFinite(p.createdAt)
      ||(p.refusal!==undefined&&(typeof p.refusal!=='string'||p.refusal!==clean(p.refusal,300)))
      ||!['preview','launching','started','uncertain','stale','overlap','limit'].includes(p.state))throw new Error('Invalid preview record')
    return p
  }
}
