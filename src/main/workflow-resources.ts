import type { WorkflowTask } from './workflow-types.js'

export type WorktreeAvailability='present'|'missing'|'unknown'|'not-recorded'
export interface TaskResources { session:'open'|'closed'; worktree:WorktreeAvailability; checkedAt:number|null }
/** Read-only observations. At most four real reads remain in flight, including timed-out reads. */
export class WorkflowResources {
  private readonly cache=new Map<string,{path:string;status:WorktreeAvailability;at:number}>()
  private readonly queued=new Map<string,string>()
  private readonly active=new Map<string,string>()
  private retained=new Map<string,string|undefined>()
  private closed=false
  constructor(private readonly read:(path:string)=>Promise<boolean|null>,private readonly changed:()=>void,
    private readonly now=Date.now,private readonly timeoutMs=3000){}
  views(tasks:readonly WorkflowTask[],openSessions:ReadonlySet<string>):WorkflowTask[]{
    this.retained=new Map(tasks.map(task=>[task.id,task.worktreePath]))
    for(const id of this.cache.keys())if(!this.retained.has(id))this.cache.delete(id)
    for(const id of this.queued.keys())if(!this.retained.has(id))this.queued.delete(id)
    const result=tasks.map(task=>{
      const path=task.worktreePath,cached=this.cache.get(task.id)
      const usable=cached?.path===path?cached:undefined
      const status:WorktreeAvailability=path?(usable?.status??'unknown'):'not-recorded'
      if(!this.closed&&path&&!path.includes('[REDACTED]')&&!['completed','cancelled'].includes(task.outcome)
        &&(!usable||this.now()-usable.at>=60_000)&&this.active.get(task.id)!==path)this.queued.set(task.id,path)
      return {...task,resources:{session:openSessions.has(task.sessionId)?'open' as const:'closed' as const,worktree:status,checkedAt:usable?.at??null}}
    })
    this.pump();return result
  }
  close():void{this.closed=true;this.queued.clear()}
  private pump():void{
    while(!this.closed&&this.active.size<4&&this.queued.size){
      const available=[...this.queued].find(([id])=>!this.active.has(id));if(!available)break
      const [id,path]=available;this.queued.delete(id);this.active.set(id,path)
      let timedOut=false
      const publish=(status:WorktreeAvailability):void=>{
        if(this.closed||this.retained.get(id)!==path)return
        this.cache.set(id,{path,status,at:this.now()});this.changed()
      }
      const timer=setTimeout(()=>{timedOut=true;publish('unknown')},this.timeoutMs);timer.unref()
      // Retain the active slot until the underlying filesystem read actually settles.
      void Promise.resolve().then(()=>this.read(path)).then(exists=>{if(!timedOut)publish(exists===null?'unknown':exists?'present':'missing')},()=>{if(!timedOut)publish('unknown')})
        .finally(()=>{clearTimeout(timer);this.active.delete(id);this.pump()})
    }
  }
}
