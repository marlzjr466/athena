import {parseBrowserSearchRequest} from '../../../shared/applicationAutomation'
import { mkdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { NativeCodexThread } from '../../../shared/codex'
import type { ReasoningEffort } from '../../../shared/conversations'
import type { HandsFreeReplyResult } from '../../../shared/handsFree'
import type { CodexComputerTurn, SearchRetryScope } from '../desktop/codexComputerTools'
import { ChatError } from './AIProvider'
import { CodexAppServerProvider, codexDisplay } from './CodexAppServerProvider'
import type { CodexCLIService } from './codexCLIService'

type Selection = { model: string; effort?: ReasoningEffort; identity?: string }
interface PendingSearch {
  objective:string
  query:string
  threadId:string
  expires:number
  scope:SearchRetryScope
}
interface VoiceSession {
  lease: string
  receipts: Map<string, {signature:string; result:Promise<HandsFreeReplyResult>}>
  thread?: NativeCodexThread
  selection?: Selection
  pendingSearch?: PendingSearch
}
export interface CodexVoiceProgress {
  id: string
  phase: 'running' | 'complete' | 'failed' | 'cancelled'
  started: number
  model: string
  message: string
  threadId?: string
  turnId?: string
  verifiedSteps: number
}
export interface CodexVoiceOptions {
  service: CodexCLIService
  cwd: string
  selection(): Promise<Selection>
  tools(ctx: {owner:string; model:string; objective:string; requestId:string; signal:AbortSignal; check(signal:AbortSignal):Promise<void>}): CodexComputerTurn
  forget?(owner: string): void
  announce?(event: CodexVoiceProgress): void
  onControl?(id:string, action:'pause'|'resume'|'stop'):void
}
type ActiveTask = { id:string; abort:AbortController; paused:boolean; changes:EventTarget }
const outputSchema = {
  type:'object', additionalProperties:false, required:['status','message'],
  properties:{
    status:{type:'string',enum:['verified','observation','partial','blocked','clarify'],description:'Use verified only when tools verified the requested changes. Use observation to answer an observation-only question from actual current tool results. For a partly verified objective use partial. Otherwise report blocked or ask a clarification.'},
    message:{type:'string',description:'Brief spoken response. Never describe unseen content or claim an unverified effect. Report any remaining steps.'},
  },
}
function finalReport(text: string): {status:string; message:string} | undefined {
  // The authoritative final item callback may also contain earlier commentary items.
  for (const candidate of [text, text.slice(text.lastIndexOf('\n\n{') + 2)]) {
    try {
      const value:unknown = JSON.parse(candidate)
      if (value && typeof value==='object' && 'status' in value && typeof value.status==='string' &&
          'message' in value && typeof value.message==='string') return {status:value.status,message:codexDisplay(value.message).slice(0,800)}
    } catch { /* No structured final response. */ }
  }
}

// Ambiguous objectives require action evidence. A mention of a screen or visible
// element inside a click instruction does not make it an observation request.
function observationOnly(objective:string):boolean {
  const text=objective.trim().replace(/^(?:(?:hey\s+)?athena[,! ]+|please\s+|(?:can|could|would) you\s+)+/i,'')
  if(!/^(?:what|which|where|who|how many|is|are|do you see|see|describe|read|list|identify|inspect|check|verify|tell me|show me)\b/i.test(text))return false
  return !/(?:\b(?:and|then|also|before|after|if so|when you|you should|can you|please)\s+(?:then\s+)?|[,;.!?]\s*)(?:click|tap|press|open|launch|close|switch|navigate|go|play|pause|resume|type|fill|select|send|submit|drag|scroll|move|delete|create|edit|change|set|start|stop)\b/i.test(text)
}

// A short reply can refer to a search only when it contains no other task,
// destination or query. The local executor separately binds the target.
function searchFollowup(text:string):'retry'|'unclear'|undefined {
  let rest=text.trim().toLowerCase().replace(/[’]/g,"'").replace(/[.,!?…]+/g,' ').replace(/\s+/g,' ').trim()
  if(!rest || rest.length>180)return
  const filler=/^(?:um+|uh+|okay|ok|yes|yeah|yep|sure|please|hey athena|athena|now|thanks|thank you)(?= |$)\s*/
  const refocused=/^i(?:'ve| have)? (?:just )?(?:focused|selected|opened|activated|clicked)(?: on)? (?:it|that|the (?:tab|window|browser)|chrome)(?: now)?(?= |$)\s*/
  const ready=/^(?:i (?:have|got) it|i(?:'m| am) (?:on|in) (?:it|the (?:tab|window|browser))|it(?:'s| is) (?:focused|open|ready))(?: now)?(?= |$)\s*/
  let previous:string
  do{
    previous=rest
    rest=rest.replace(filler,'').replace(refocused,'').replace(ready,'')
  }while(rest!==previous)
  rest=rest.replace(/^(?:can|could|would|will) you (?:please )?/,'')
  if(/^(?:(?:retry|try)(?: (?:it|that|the search|that search|the (?:previous|same) search))?(?: again)?|run (?:it|that search|the search) again)(?: (?:now|please))?$/.test(rest))return 'retry'
  if(!rest || /^(?:go ahead|do it|can you|got it|that's it|done|ready)$/.test(rest))return 'unclear'
}

/** One native automation thread per live voice lease. It never borrows the selected chat thread. */
export class CodexVoiceAutomation {
  private session?: VoiceSession
  private active?: ActiveTask
  constructor(private readonly options: CodexVoiceOptions) {}

  run(lease: string, requestId: string, objective: string, authorized: () => boolean): Promise<HandsFreeReplyResult> {
    if (!authorized()) {
      if(this.session?.lease===lease)this.session.pendingSearch=undefined
      return Promise.resolve({ok:false,message:'This voice automation session is no longer authorized.'})
    }
    if (this.session && this.session.lease!==lease) this.end()
    const session:VoiceSession = this.session ??= {lease,receipts:new Map()}
    const signature=createHash('sha256').update(objective).digest('hex')
    const previous = session.receipts.get(requestId)
    if (previous) return previous.signature===signature ? previous.result : Promise.resolve({ok:false,message:'This request ID was already used for a different instruction.'})
    if (this.active) return Promise.resolve({ok:false,message:'The previous automation is still running. Stop it first to change tasks.'})
    if (session.receipts.size>=512) return Promise.resolve({ok:false,message:'Start a new voice session to continue automation.'})
    if(session.pendingSearch && (session.pendingSearch.expires<=Date.now() || session.pendingSearch.threadId!==session.thread?.threadId))
      session.pendingSearch=undefined
    const followup=searchFollowup(objective)
    if(followup==='unclear' || (followup==='retry' && !session.pendingSearch)){
      const result=Promise.resolve({ok:true,text:session.pendingSearch?'What would you like me to do with the previous search?':'Which action or search would you like me to try?'})
      session.receipts.set(requestId,{signature,result})
      return result
    }
    const retry=followup==='retry'?session.pendingSearch:undefined
    session.pendingSearch=undefined
    const task:ActiveTask = {id:requestId,abort:new AbortController(),paused:false,changes:new EventTarget()}
    this.active = task
    const result = this.execute(session,task,objective,authorized,retry).finally(()=>{if(this.active===task)this.active=undefined})
    session.receipts.set(requestId,{signature,result})
    return result
  }

  private async execute(session:VoiceSession, task:ActiveTask, spoken:string, authorized:()=>boolean,retry?:PendingSearch):Promise<HandsFreeReplyResult> {
    const started = Date.now(), signal = task.abort.signal
    const objective=retry?.objective??spoken
    const search=parseBrowserSearchRequest(objective)
    let tools:CodexComputerTurn|undefined, finalText='', count=0
    const announce = (phase:CodexVoiceProgress['phase'],message:string) => {
      this.options.announce?.({id:task.id,phase,message,started,model:session.selection?.model ?? '',
        threadId:session.thread?.threadId,turnId:session.thread?.lastMessageId===task.id?session.thread.turnId:undefined,verifiedSteps:count})
    }
    const check = async (operationSignal:AbortSignal) => {
      const combined=AbortSignal.any([operationSignal,signal])
      while(task.paused){
        combined.throwIfAborted()
        await new Promise<void>((resolve,reject)=>{
          const cleanup=()=>{combined.removeEventListener('abort',cancel);task.changes.removeEventListener('change',resume)}
          const resume=()=>{cleanup();resolve()}
          const cancel=()=>{cleanup();reject(combined.reason)}
          combined.addEventListener('abort',cancel,{once:true})
          task.changes.addEventListener('change',resume,{once:true})
        })
      }
      combined.throwIfAborted()
      if(this.session!==session || !authorized())throw new ChatError('Voice automation authorization changed. Check the target before continuing.')
    }
    try {
      await check(signal)
      session.selection ??= await this.options.selection()
      const selection=session.selection
      await mkdir(this.options.cwd,{recursive:true,mode:0o700})
      const cwd=await realpath(this.options.cwd)
      await check(signal)
      tools=this.options.tools({owner:'voice:'+session.lease,model:selection.model,objective,requestId:task.id,signal,check})
      if(retry){
        if(!tools.restrictSearchRetry)throw new ChatError('Please state the search again so I can verify the intended tab.')
        tools.restrictSearchRetry(retry.scope)
      }
      const provider=new CodexAppServerProvider(this.options.service,selection.model,selection.identity)
      announce('running','Checking the requested action with Codex.')
      let completed=false
      const content=retry?spoken+'\n\nRetry the unsubmitted search for this exact query: '+JSON.stringify(retry.query)+'. Inspect the intended tab again before typing.':spoken
      for await(const chunk of provider.streamMessage([{id:task.id,role:'user',status:'complete',createdAt:started,content}],{
        signal,effort:selection.effort,permissionMode:'read-only',executionId:task.id,structuredOutput:outputSchema,
        nativeCodex:{voiceOnly:true,computerTools:tools,cwd,writableRoots:[],state:session.thread,
          persist:state=>{session.thread=state},finalText:text=>{finalText=text},
          requestUserInput:async()=>{throw new ChatError('Ask a brief clarification in the spoken result.')}},
      })){
        signal.throwIfAborted()
        const verified=tools.verifiedResults().length
        if(verified>count){count=verified;announce('running','The local executor returned a verified result.')}
        if(chunk.type==='done') completed=true
      }
      await check(signal)
      if(!completed || session.thread?.submission!=='completed')throw new ChatError('Codex did not confirm completion. Check the current target before continuing.')
      const report=finalReport(finalText)
      const receipts=tools.verifiedResults().map(item=>codexDisplay(item))
      count=receipts.length
      const actions=tools.verifiedActions().map(item=>codexDisplay(item))
      const missingSearchSubmission=!!search && tools.verifiedSearchSubmission?.()!==true
      if(search && missingSearchSubmission && session.thread?.threadId){
        const scope=tools.searchRetryScope?.()
        if(scope)session.pendingSearch={scope,objective,query:search.query,threadId:session.thread.threadId,expires:retry?.expires??Date.now()+120_000}
      }
      const questionOnly=observationOnly(objective)
      if(report?.status==='clarify' && report.message.trim().endsWith('?')){
        const question=report.message.trim().split(/(?<=[.!?])\s+/).at(-1)!
        announce('complete','Codex needs clarification.')
        return {ok:true,text:question}
      }
      if(report && questionOnly && !missingSearchSubmission && tools.hasObservation() && count && ['observation','verified'].includes(report.status)){
        announce('complete','The local executor observed the current target.')
        return {ok:true,memoryOutcome:'observed',text:report.status==='observation'?report.message:receipts.slice(-3).join(' ').slice(0,850)}
      }
      const evidence=actions.slice(-3).join(' ').slice(0,700)
      if(report?.status==='verified' && evidence && !missingSearchSubmission){
        announce('complete','The local executor verified the reported action.')
        return {ok:true,text:evidence,memoryOutcome:'verified'}
      }
      announce('failed','The requested outcome could not be verified.')
      const unverified=missingSearchSubmission ? [evidence,'Search submission could not be verified.'].filter(Boolean).join(' ') :
        evidence ? evidence+' The remaining objective could not be verified.' :
        questionOnly ? 'The requested information could not be verified from a current observation.' :
        'The requested change could not be verified.'
      const failure=tools.lastFailure?.()
      return {ok:false,message:failure ? unverified+' The last tool error was “'+failure.slice(0,300)+'”' : unverified}
    } catch(error){
      announce(signal.aborted?'cancelled':'failed',signal.aborted?'Voice automation stopped.':'Codex automation could not finish.')
      return {ok:false,message:signal.aborted?'Voice automation stopped. A submitted action may have taken effect.':
        error instanceof ChatError ? codexDisplay(error.userMessage) : 'Codex voice automation could not finish. Check its connection and permissions.'}
    } finally {await tools?.dispose?.()}
  }

  control(id:string,action:'pause'|'resume'|'stop'):boolean {
    const task=this.active
    if(!task || task.id!==id || task.abort.signal.aborted)return false
    if(action==='stop'){
      if(this.session)this.session.pendingSearch=undefined
      task.abort.abort()
      if(this.session)this.options.forget?.('voice:'+this.session.lease)
    }
    else {task.paused=action==='pause';task.changes.dispatchEvent(new Event('change'))}
    this.options.onControl?.(id,action)
    return true
  }
  steer(lease:string|undefined,paused:boolean):boolean {
    return !!this.active && this.session?.lease===lease && this.control(this.active.id,paused?'pause':'resume')
  }
  cancel() {
    if(this.session)this.session.pendingSearch=undefined
    if(this.active)return this.control(this.active.id,'stop')
    if(this.session)this.options.forget?.('voice:'+this.session.lease)
    return false
  }
  disconnect(conversation:string){
    if(this.session?.lease===conversation)this.cancel()
  }
  end(lease?:string){
    const session=this.session
    if(!session || (lease && lease!==session.lease))return
    this.cancel()
    this.session=undefined
  }
}
