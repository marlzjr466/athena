import type { VoiceEntry } from '../../../shared/liveVoice'

type Fragment={role:'user'|'assistant';start:number;end:number;text:string;received:number}
export class LiveHistory {
  private fragments:Fragment[]=[]
  private audible:number[]=[]
  private interruptions:{start:number;end:number}[]=[]
  private serial=0
  private suppressOutput=false
  sample(offset:number){this.audible.push(offset);if(this.audible.length>1500)this.audible.shift()}
  interrupt(offset:number){this.interruptions.push({start:offset,end:Infinity})}
  resume(offset:number){const i=this.interruptions.at(-1);if(i && !Number.isFinite(i.end))i.end=offset}
  delegated(){this.suppressOutput=true}
  add(role:Fragment['role'],start:number,end:number,text:string,received:number){
    if(end<=start || !Number.isFinite(end) || start<0 || !Number.isFinite(start) || !text)return
    if(role==='user')this.suppressOutput=false
    if(role==='assistant' && this.suppressOutput)return
    this.fragments.push({role,start,end,text,received})
  }
  drain(now:number,closing=false):VoiceEntry[]{
    const entries:VoiceEntry[]=[]
    const retained:Fragment[]=[]
    for(const role of ['user','assistant'] as const){
      const groups:Fragment[][]=[]
      for(const f of this.fragments.filter(f=>f.role===role)){
        const group=groups.at(-1)
        if(group && f.start-group.at(-1)!.end<1250)group.push(f)
        else groups.push([f])
      }
      for(const group of groups){
        const last=group.at(-1)!
        // Live timestamps use the engine's audio timeline. WebRTC playout and
        // local interruption boundaries use the renderer clock. Engines may
        // start after negotiation or standby. Align each utterance using its
        // least delayed fragment, without treating a late packet as new audio.
        let clockOffset=Math.max(0,Math.min(...group.map(f=>f.received-f.end)))
        if(role==='assistant'){
          // A WebRTC jitter buffer can deliver the entire utterance several
          // frames after its first caption. Align only to measured speech in
          // this burst, and never shift a caption across a local interruption.
          const first=group[0], projected=first.start+clockOffset
          const onset=this.audible.find(t=>t>=projected-120 && t<=first.end+clockOffset+1000)
          if(onset!==undefined && onset>first.end+clockOffset &&
            !this.interruptions.some(i=>i.start<=onset && i.end>=projected)){
            clockOffset=onset-first.start-40
          }
        }
        if(!closing && (now-last.received<1500 || now<last.end+clockOffset+450)){retained.push(...group);continue}
        const delivered=role==='user'?group:group.filter(f=>{
          const start=f.start+clockOffset,end=f.end+clockOffset
          return now>=end && !this.interruptions.some(i=>end>i.start && start<i.end) &&
            this.audible.some(t=>t>=start-120 && t<=end+350)
        })
        if(!delivered.length)continue
        const partial=delivered.length<group.length || closing && now-last.received<700
        entries.push({id:String(++this.serial),role,offset:group[0].start+clockOffset,text:delivered.map(f=>f.text).join('').slice(0,5000),partial})
      }
    }
    this.fragments=retained
    return entries.sort((a,b)=>a.offset-b.offset)
  }
}
