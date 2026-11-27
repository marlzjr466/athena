import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { InitialItem } from 'openai/resources/live/live'
import { voiceEntrySchema, type VoiceEntry, type VoiceMemoryView } from '../../../shared/liveVoice'
import { ChatError } from '../ai/AIProvider'

const note=z.object({id:z.string().uuid(),text:z.string().max(400)})
const chat=z.object({id:z.string().uuid(),updated:z.number(),recent:z.array(voiceEntrySchema),summary:z.array(z.string()),compacted:z.number()})
const database=z.object({active:z.string().uuid(),chats:z.array(chat),notes:z.array(note)})
type DB=z.infer<typeof database>
const fresh=()=>({id:randomUUID(),updated:Date.now(),recent:[] as VoiceEntry[],summary:[] as string[],compacted:0})
const secret=/\b(?:password|passcode|access token|api key|secret key|credit card|social security|verification code|private key|bearer\s+\S+)\b|\b(?:sk-|ghp_|AKIA)[\w-]{8,}|https?:\/\/\S+\?\S+/i
export const newVoiceChat=/^(?:(?:hey )?athena[, ]+)?(?:please )?(?:start|create|begin) (?:a )?new (?:voice )?conversation[.!?]*$/i
const privateRequest=/\b(?:don['’]?t|do not|never) (?:remember|save|store|record)\b|\bforget (?:that|this|what i just said|my last)\b/i
type Cipher={seal(text:string):string;open(text:string):string}

export class VoiceMemory {
  private db?:DB
  private account=''
  private days=-1
  constructor(private dir:string,private cipher?:Cipher){}
  private get file(){return join(this.dir,'voice-history-'+this.account+'.enc')}
  private persist(){
    if(!this.db || !this.cipher || !this.days)return
    try{
      writeFileSync(this.file+'.tmp',this.cipher.seal(JSON.stringify(this.db)),{mode:0o600})
      renameSync(this.file+'.tmp',this.file)
    }catch{throw new ChatError('Voice history could not be saved securely.')}
  }
  open(account:string,days:number){
    const key=createHash('sha256').update(account).digest('hex')
    const switched=key!==this.account || !this.db
    if(key!==this.account || !this.db){
      this.account=key;this.db=undefined
      if(days && existsSync(this.file)){
        if(!this.cipher)throw new ChatError('Unlock secure storage to restore the saved voice conversation.')
        try{this.db=database.parse(JSON.parse(this.cipher.open(readFileSync(this.file,'utf8'))))}
        catch{throw new ChatError('The saved voice conversation could not be restored.')}
      }
      if(!this.db){const c=fresh();this.db={active:c.id,chats:[c],notes:[]}}
    }
    const changed=days!==this.days
    this.days=days
    if(!days){rmSync(this.file,{force:true});rmSync(this.file+'.tmp',{force:true});return}
    const cutoff=Date.now()-days*86400000
    const expired=this.db.chats.some(c=>c.updated<cutoff)
    if(expired){
      this.db.chats=this.db.chats.filter(c=>c.updated>=cutoff)
      if(!this.db.chats.some(c=>c.id===this.db!.active)){const c=fresh();this.db.chats.push(c);this.db.active=c.id}
    }
    if(changed || expired || switched)this.persist()
  }
  get id(){return this.db!.active}
  private get chat(){return this.db!.chats.find(c=>c.id===this.id)!}
  view():VoiceMemoryView{
    const c=this.chat
    return {id:c.id,conversations:this.db!.chats.map(({id,updated})=>({id,updated})),recent:c.recent,summary:c.summary,compacted:c.compacted,notes:this.db!.notes,persistent:!!(this.days && this.cipher)}
  }
  manage(op:string,id?:string,text?:string){
    const db=this.db!
    if(op==='new'){
      if(db.chats.length>=100)throw new ChatError('Clear an old voice conversation before creating another.')
      const c=fresh();db.chats.push(c);db.active=c.id
    }else if(op==='select'){
      if(!db.chats.some(c=>c.id===id))throw new ChatError('That voice conversation is unavailable.')
      db.active=id!
    }else if(op==='clear'){
      db.chats=db.chats.filter(c=>c.id!==db.active)
      const c=fresh();db.chats.push(c);db.active=c.id
    }else if(op==='remove-note'){db.notes=db.notes.filter(n=>n.id!==id)}
    else if(op==='save-note' || op==='edit-note'){
      if(!text || secret.test(text))throw new ChatError('Choose a short memory without credentials or sensitive numbers.')
      if(op==='edit-note'){const n=db.notes.find(n=>n.id===id);if(!n)throw new ChatError('Memory no longer available.');n.text=text}
      else if(!db.notes.some(n=>n.text===text)){if(db.notes.length>=32)throw new ChatError('The saved memory list is full.');db.notes.push({id:randomUUID(),text})}
    }
    if(op!=='inspect')this.persist()
    return this.view()
  }
  append(entries:VoiceEntry[]){
    const c=this.chat
    for(const e of entries){
      if(!e.text.trim() || secret.test(e.text))continue
      const i=c.recent.findIndex(old=>old.id===e.id)
      if(i>=0)c.recent[i]=e
      else c.recent.push(e)
    }
    c.recent.sort((a,b)=>a.offset-b.offset)
    c.updated=Date.now()
    while(c.recent.length>28 || c.recent.reduce((n,e)=>n+Buffer.byteLength(e.text),0)>5000){
      const old=c.recent.shift()!;c.compacted++
      if(old.partial)continue
      const kind=old.role==='task'?'Task':old.text.includes('?')?'Question':/\b(?:decided|choose|chosen|agreed|will use)\b/i.test(old.text)?'Decision':old.role==='user'?'Topic':'Reply'
      const line=kind+' ('+old.role+'): '+old.text.trim().slice(0,220)
      if(c.summary.includes(line))continue
      c.summary.push(line)
      if(c.summary.length>16){
        const index=c.summary.findIndex(v=>v.startsWith('Reply') || v.startsWith('Topic'))
        c.summary.splice(index<0?0:index,1)
      }
    }
    this.persist()
  }
  /** Only returned to the local main process. No chat history is read from other accounts. */
  seed(initial?:string):InitialItem[]{
    const c=this.chat,items:InitialItem[]=[]
    // Budget by encoded bytes, a conservative upper bound on text tokens.
    let bytes=8000-(initial?Buffer.byteLength(initial)+32:0)
    const add=(role:'user'|'assistant',value:string)=>{
      const size=Buffer.byteLength(value)+24
      if(size>bytes)return false
      bytes-=size
      items.unshift(role==='assistant'?{role,content:[{type:'output_text',text:value}]}:{role,content:[{type:'input_text',text:value}]})
      return true
    }
    for(const e of [...c.recent].reverse()){
      if(!add(e.role==='user'?'user':'assistant',(e.partial?'[Partial transcript] ':'')+(e.role==='task'?'[Task status] ':'')+e.text))break
    }
    const prior=[...this.db!.notes.map(n=>'Explicitly saved: '+n.text),...c.summary.slice().reverse()]
    const selected=prior.filter(line=>{const size=Buffer.byteLength(line)+24;if(size>bytes-100)return false;bytes-=size;return true})
    if(selected.length)items.unshift({role:'user',content:[{type:'input_text',text:'Earlier conversation notes (historical context):\n'+selected.join('\n')}]})
    return items
  }
  privateTurn(text:string){return privateRequest.test(text) || secret.test(text)}
  requestsForget(text:string){
    return privateRequest.test(text) && /(?:forget (?:that|this|what i just said|my last)|remember (?:that|what i just said)[.!?]*$)/i.test(text)
  }
  rememberExplicit(text:string){
    const match=/^(?:athena[, ]+)?(?:please )?remember (?:that )?(.{2,400})[.!]?$/i.exec(text)
    if(match && !this.privateTurn(text) && this.db!.notes.length<32)this.manage('save-note',undefined,match[1])
  }
  forgetLast(){
    const c=this.chat
    const last=c.recent.findLastIndex(e=>e.role==='user')
    if(last>=0){
      const previous=c.recent[last].text
      this.db!.notes=this.db!.notes.filter(n=>!previous.includes(n.text))
      c.recent.splice(last);this.persist()
    }
  }
}
