import {attentionTitle,type AttentionItem,type AttentionReason} from './workflow-attention.js'

const reasons=new Set<AttentionReason>(['Session stopped unexpectedly','Needs approval','Review meeting paused','Task needs input','Ready for review','Task blocked or failed','Follow-ups need attention','Handoff needs reconciliation','Task resource unavailable','Task outcome needs review'])
export interface WorkflowNotice {title:string;body:string;items:readonly AttentionItem[]}
/** Baseline restored facts, then notify new actionable evidence once. No request/report/question enters a notice. */
export class WorkflowNotifications {
  private current=new Set<string>()
  private readonly pending=new Map<string,{item:AttentionItem;facts:Set<string>}>()
  private timer:ReturnType<typeof setTimeout>|null=null
  private primed=false
  constructor(private readonly background:(item:AttentionItem)=>boolean,private readonly emit:(notice:WorkflowNotice)=>void,
    private readonly delayMs=250){}
  private facts(item:AttentionItem):readonly string[]{return item.evidence??[item.key]}
  prime(items:readonly AttentionItem[]):void{this.current=new Set(items.flatMap(item=>this.facts(item)));this.primed=true;this.pending.clear()}
  update(items:readonly AttentionItem[],enabled:boolean):void{
    if(!this.primed){this.prime(items);return}
    const next=new Set(items.flatMap(item=>this.facts(item)))
    for(const [id,pending] of this.pending){
      for(const fact of pending.facts)if(!next.has(fact))pending.facts.delete(fact)
      const item=items.find(item=>this.facts(item).some(fact=>pending.facts.has(fact)))
      if(!pending.facts.size||!item)this.pending.delete(id);else pending.item=item
    }
    if(enabled)for(const item of items){
      const introduced=this.facts(item).filter(fact=>!this.current.has(fact))
      if(introduced.length&&this.background(item)){
        const id=item.subjectId??item.tabId,old=this.pending.get(id)
        this.pending.set(id,{item,facts:new Set([...(old?.facts??[]),...introduced])})
      }
    }
    this.current=next
    if(!enabled)this.pending.clear()
    if(this.pending.size&&!this.timer){this.timer=setTimeout(()=>this.flush(),this.delayMs);this.timer.unref()}
  }
  flush():void{
    if(this.timer)clearTimeout(this.timer);this.timer=null
    const items=[...this.pending.values()].filter(pending=>[...pending.facts].some(fact=>this.current.has(fact))&&this.background(pending.item)).map(pending=>pending.item);this.pending.clear()
    if(!items.length)return
    const item=items[0]!,safeReasons=item.reasons.filter(reason=>reasons.has(reason))
    if(items.length===1&&!safeReasons.length)return
    try{this.emit({title:'Copilot needs you',body:items.length===1?`${attentionTitle(item.title)} · ${safeReasons.join(' · ')}`:`${items.length} sessions or tasks need attention.`,items})}
    catch{/* OS notification failures must leave the attention list and manual terminal usable. */}
  }
  close():void{if(this.timer)clearTimeout(this.timer);this.timer=null;this.pending.clear()}
}
