import { z } from 'zod'
import type { ApplicationAutomationConfig, AutomationControl, AutomationEngineStatus } from '../../../shared/applicationAutomation'
import { computerInstruction } from '../../../shared/applicationAutomation'
import { APPLICATIONS, appIdentifierSchema, type AppIdentifier } from '../../../shared/desktopActions'
import { AutomationBudgetReached, AutomationJournal, fingerprint, type AutomationRecord } from './automationJournal'
import { AutomationUnavailable, decisionFormat, decisionSchema, OpenAIAutomation, plannerInstructions, type VisualDriver } from './openAIAutomation'
import { ChatError, type DeterministicActionResult, type ProjectTools } from './AIProvider'
import { redactOutput } from './agentCommands'

type TaskStatus = NonNullable<AutomationEngineStatus['task']>
type Drivers = Pick<OpenAIAutomation,'next'|'visual'|'environment'> & {dispose?():void}
interface Services {
  config():ApplicationAutomationConfig
  cloudAllowed():boolean
  credential():Promise<string|undefined>
  account():Promise<string|null>
  client?(key:string):Drivers
  confirm(title:string,detail:string,signal:AbortSignal):Promise<boolean>
  visual(app:AppIdentifier,objective:string,gate:()=>Promise<void>,signal:AbortSignal,observed:Record<string,unknown>):Promise<VisualDriver>
}
export interface AutomationCommand {
  id:string; owner:string; text:string; localOnly:boolean; nativeLocal?:boolean
  visualTarget?:AppIdentifier
  check(signal:AbortSignal):Promise<void>
  observe(signal:AbortSignal):Promise<Record<string,unknown>>
  tools(text:string,id:string):ProjectTools
  nativePlan(prompt:string,signal:AbortSignal,format:{instructions:string;schema:Record<string,unknown>}):Promise<string>
  announce(task:TaskStatus,phase:'running'|'complete'|'failed'|'cancelled',message?:string):void
}
const resumeRequest=/^(?:(?:hey )?athena[, ]+)?(?:please )?resume (?:my |the )?(?:last )?automation[.!? ]*$/i
const visualTool={name:'approved_window',description:'Observe and operate the specified foreground window using the computer tool. Only for goals requiring visual controls. The original objective must explicitly identify the application or current window.',parameters:{type:'object',properties:{app:{type:'string',enum:Object.keys(APPLICATIONS)}},required:['app'],additionalProperties:false}}
const describeTool={name:'describe_tool',description:'Inspect the exact input schema of a registered tool before using it.',parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}
function relevantTools(tools:ProjectTools['definitions'],objective:string) {
  const terms=new Set(objective.toLowerCase().match(/[a-z0-9]+/g)?.filter(word=>word.length>2 && !['the','and','athena','computer','use','with','from','this','that','please'].includes(word)))
  const score=(name:string,description:string)=>{
    const words=new Set(description.toLowerCase().match(/[a-z0-9]+/g))
    const identifiers=name.split('_')
    return [...terms].reduce((sum,term)=>sum+(identifiers.includes(term)?4:words.has(term)?1:0),0)
  }
  return tools.map(tool=>({tool,score:score(tool.name,tool.description)})).sort((a,b)=>b.score-a.score).slice(0,5).map(({tool})=>tool)
}
const safeResult=z.object({ok:z.boolean(),message:z.string().optional(),error:z.string().optional(),verified:z.boolean().optional()}).passthrough()
function canonical(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonical)
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]))
  return value
}
const failure=(text:string):DeterministicActionResult=>({handled:true,success:false,text})
function explicitVisualTarget(text:string,foreground:unknown) {
  if(!/\b(?:visually|on.screen|using (?:a |the )?(?:screenshot|visible cursor)|computer.use tool)\b/i.test(text))return
  const lower=text.toLowerCase()
  const names=Object.entries(APPLICATIONS).filter(([id,app])=>lower.includes(app.name.toLowerCase()) || new RegExp('\\b'+id+'\\b','i').test(text))
  if(names.length===1)return names[0][0]
  if(!names.length && /\b(?:current|active|this) window\b/i.test(text))return Object.entries(APPLICATIONS).find(([,app])=>app.name===foreground)?.[0]
}
export class ApplicationAutomation {
  private active?:{status:TaskStatus; cancel:AbortController; resume?:()=>void; changed?:()=>void}
  private inflight = new Map<string,{text:string; result:Promise<DeterministicActionResult>}>()
  private connection?:{signature:string;api:Drivers}
  private keyStatus?:{at:number;available:boolean}
  constructor(private services:Services,private journal:AutomationJournal){}
  private client(key:string):Drivers {
    const signature=fingerprint(key)
    if(this.connection?.signature!==signature){
      this.connection?.api.dispose?.()
      this.connection={signature,api:this.services.client?.(key) ?? new OpenAIAutomation(key,this.journal)}
    }
    return this.connection.api
  }
  control(command:Exclude<AutomationControl,string>) {
    const active=this.active
    if(!active || active.status.id!==command.taskId)throw new ChatError('This automation has already ended.')
    if(command.action==='stop')active.cancel.abort(new ChatError('Automation was stopped.'))
    active.status.paused=command.action==='pause'
    if(!active.status.paused)active.resume?.()
    if(command.action!=='stop')active.changed?.()
  }
  stop(){this.active?.cancel.abort(new ChatError('Automation was stopped.')); this.active?.resume?.();this.connection?.api.dispose?.()}
  private async credential(){
    // The OS key store can be locked or unavailable to a particular app signature.
    // Local task control and native fallback must remain usable in that state.
    let key:string|undefined
    try{key=await this.services.credential()}catch{key=undefined}
    this.keyStatus={at:Date.now(),available:!!key}
    return key
  }
  async status(checkEnvironment=false,create=false):Promise<AutomationEngineStatus> {
    const cfg=this.services.config()
    const key=checkEnvironment || !this.keyStatus || Date.now()-this.keyStatus.at>=60_000?await this.credential():undefined
    let environment
    if(checkEnvironment && key && this.services.cloudAllowed() && cfg.environment==='self_hosted') {
      const account=await this.services.account()
      if(create && this.active)throw new ChatError('Finish the current automation before preparing another executor.')
      if(account)environment=await this.client(key).environment(account,cfg.model,create,AbortSignal.timeout(15000))
    }
    return {credential:this.keyStatus?.available??false,...this.journal.usage(),task:this.active && {...this.active.status},environment}
  }
  run(cmd:AutomationCommand,signal:AbortSignal):Promise<DeterministicActionResult> {
    const resume=resumeRequest.test(cmd.text.trim())
    if(!resume && !cmd.visualTarget && !computerInstruction(cmd.text))return Promise.resolve({handled:false})
    if(this.services.config().engine==='codex' && !cmd.localOnly)return Promise.resolve(failure('Computer-use planning is configured for Codex. Use a native Codex chat or Floating Athena with GPT-Live.'))
    const key=cmd.owner+'|'+cmd.id, previous=this.inflight.get(key)
    if(previous)return previous.text===cmd.text?previous.result:Promise.resolve(failure('The automation request identity changed.'))
    if(this.active)return Promise.resolve(failure('An automation is already controlling the desktop. Pause or stop it first.'))
    const result=this.execute(cmd,signal,resume)
    this.inflight.set(key,{text:cmd.text,result})
    if(this.inflight.size>64)this.inflight.delete(this.inflight.keys().next().value!)
    return result
  }
  private async execute(cmd:AutomationCommand,parent:AbortSignal,resume:boolean):Promise<DeterministicActionResult> {
    const services=this.services, cfg=services.config()
    const active:NonNullable<ApplicationAutomation['active']>={cancel:new AbortController(),status:{
      id:cmd.id,engine:cfg.engine==='openai'?'OpenAI':'Athena Native',action:'Inspecting task',started:Date.now(),steps:0,paused:false}}
    this.active=active
    const signal=AbortSignal.any([parent,active.cancel.signal,AbortSignal.timeout(10*60_000)])
    const status=active.status
    const gate=async()=>{
      signal.throwIfAborted()
      if(status.paused)await new Promise<void>((resolve,reject)=>{
        const abort=()=>{active.resume=undefined;reject(signal.reason)}
        active.resume=()=>{signal.removeEventListener('abort',abort);active.resume=undefined;resolve()}
        signal.addEventListener('abort',abort,{once:true})
      })
      await cmd.check(signal);signal.throwIfAborted()
      if(services.config().engine!==cfg.engine)throw new ChatError('The automation engine changed. Review the current state before continuing.')
    }
    let activeRecord:AutomationRecord|undefined, objective=cmd.text, results:string[]=[], last=''
    let external=false, nativeConsent=false
    const report=(label:string)=>{status.action=label;cmd.announce(status,'running')}
    try {
      await gate()
      const startedRequests=this.journal.usage().requests
      active.changed=()=>{status.requests=Math.max(0,this.journal.usage().requests-startedRequests);cmd.announce(status,'running')}
      if(objective.length>12000)throw new ChatError('Shorten the automation instruction to 12,000 characters.')
      const task=resume?this.journal.pending(cmd.owner):this.journal.begin(cmd.id,cmd.owner,objective,cfg.persist)
      if(!task)throw new ChatError('No resumable automation was found in this conversation.')
      activeRecord=task
      if(resume) {
        const saved=task && this.journal.recover(task)
        if(!saved)throw new ChatError('No resumable automation was found in this conversation.')
        objective=saved.objective; results=saved.results
      }
      if(task.finished || task.receipts.some(r=>r.outcome!=='verified'))throw new ChatError('This task has a completed, declined or uncertain operation. Inspect its current state before issuing a new instruction.')
      this.journal.checkpoint(task,objective,results)
      const tools=cmd.tools(objective,task.id)
      let observed=await cmd.observe(signal)
      const initialBudgetReason=this.journal.budgetReason(cfg.monthlyRequests,cfg.monthlyEstimateUSD)
      if(initialBudgetReason && cfg.engine==='openai' && !cfg.fallback && !cmd.localOnly)throw new AutomationBudgetReached(initialBudgetReason)
      const key=cfg.engine==='openai' && !initialBudgetReason && !cmd.localOnly && services.cloudAllowed()?await this.credential():undefined
      const account=key?await services.account().catch(()=>null):null
      let api=key && account?this.client(key):undefined
      if(!api && cfg.engine==='openai' && !cfg.fallback && !cmd.localOnly)throw new ChatError('OpenAI Automation needs a verified API key, online access and API budget. Enable native fallback or select Athena Native in Settings → AI → Computer use.')
      if(cfg.environment==='self_hosted' && api && !task.session && this.journal.environment?.session) {
        const bound=this.journal.environment.session
        if(this.journal.claimed(bound,task.id))throw new ChatError('That executor belongs to another task. Prepare a fresh isolated executor.')
      }
      const assertCloud=async()=>{
        await gate()
        if(!services.cloudAllowed() || await services.account()!==account || !external || services.config().environment!==cfg.environment || services.config().model!==cfg.model)
          throw new ChatError('OpenAI automation authorization or its account changed.')
      }
      const addReceipt=(name:string,input:unknown)=>{
        const key=fingerprint(name+JSON.stringify(canonical(input)))
        if(!tools.readOnly?.(name) && task.receipts.some(r=>r.key===key))throw new ChatError('That operation already has a receipt. Reobserve the target before requesting a different action.')
        if(task.receipts.length>=Math.min(cfg.maxSteps,services.config().maxSteps))throw new ChatError('The task has reached its configured action limit.')
        const entry={name,key,outcome:'pending' as 'pending'|'verified'|'blocked'}
        task.receipts.push(entry);this.journal.save(task)
        return ()=>{entry.outcome='verified';this.journal.save(task)}
      }
      const catalog=tools.definitions.filter(t=>!/(?:execute_command|shell|password|point_at_window|capture_screen)/i.test(t.name))
      const likely=relevantTools(catalog,objective)
      let requestedSchema:typeof catalog[number]|undefined
      let reviewedVisual=false
      for(let i=0;i<=cfg.maxSteps;i++) {
        await gate()
        const currentLimits=services.config()
        const budgetReason=this.journal.budgetReason(currentLimits.monthlyRequests,currentLimits.monthlyEstimateUSD)
        if(api && budgetReason) {
          if(!currentLimits.fallback)throw new AutomationBudgetReached(budgetReason)
          api=undefined
        }
        status.engine=api?'OpenAI':'Athena Native'
        if(task.interruptedVisualApp && !reviewedVisual){
          const app=appIdentifierSchema.parse(task.interruptedVisualApp), name='athena_desktop_inspect_accessible_ui'
          report('Rechecking the window after interrupted visual input')
          observed=await cmd.observe(signal)
          const digest=fingerprint(JSON.stringify([observed.pid,observed.window,observed.capture]))
          if(observed.application!==APPLICATIONS[app].name || digest!==task.interruptedWindowDigest || !catalog.some(tool=>tool.name===name))
            throw new ChatError('Visual input was applied before the interruption. Refocus its window and review the result before continuing.')
          await gate();tools.assertAccess()
          const checked=safeResult.parse(JSON.parse(await tools.execute(name,{app},signal)))
          if(!checked.ok || checked.verified===false)throw new ChatError('The interrupted window could not be inspected. Review the previous input before continuing.')
          results.push(JSON.stringify({tool:name,message:'Inspected the current '+APPLICATIONS[app].name+' controls after interrupted input.',observation:redactOutput(JSON.stringify(checked)).slice(0,1650)}))
          this.journal.checkpoint(task,objective,results)
          reviewedVisual=true
        }
        status.requests=Math.max(0,this.journal.usage().requests-startedRequests)
        report(api?'Planning the next action':'Reviewing remaining actions with Athena Native')
        const prompt=()=>JSON.stringify({objective:redactOutput(objective),
          registeredTools:catalog.map(tool=>tool.name),
          tools:[...likely.filter(tool=>tool.name!==requestedSchema?.name),...(requestedSchema?[requestedSchema]:[]),describeTool,...(api?[visualTool]:[])],verifiedResults:results,observed,
          completedTools:task.receipts.map(r=>r.name), remainingSteps:cfg.maxSteps-i, instruction:resume?'Reinspect current state before changing it. Preserve completed work.':undefined})
        let decision
        const directApp=i===0 && !resume && api?(cmd.visualTarget ?? explicitVisualTarget(objective,observed.application)):undefined
        if(api) {
          if(!external) {
            external=await services.confirm('Use OpenAI for this automation?', 'Send this instruction and relevant local tool results to the OpenAI API for planning. Managed Agents retains session context. API charges apply. Window images require separate approval. '+objective.slice(0,400),signal)
            if(!external)throw new ChatError('OpenAI automation was declined.')
          }
          await assertCloud()
          try {
            decision=directApp?{decision:'act' as const,tool:'approved_window',arguments:JSON.stringify({app:directApp}),message:''}:
              await api.next(currentLimits,account!,task,prompt(),signal)
            await assertCloud()
          }
          catch(error) {
            if(!(error instanceof AutomationUnavailable || error instanceof AutomationBudgetReached) || !services.config().fallback)throw error
            api=undefined;status.engine='Athena Native';report('Checking current state for native fallback');observed=await cmd.observe(signal)
          }
        }
        if(!decision) {
          if(!nativeConsent && !cmd.localOnly && !cmd.nativeLocal) {
            nativeConsent=await services.confirm('Use the configured native planner?', 'Send this automation instruction and its verified results to the configured Athena planning model. The selected provider’s normal charges may apply.',signal)
            if(!nativeConsent)throw new ChatError('Native planning was declined.')
          }
          await gate()
          const raw=await cmd.nativePlan(prompt(),signal,{instructions:plannerInstructions,schema:decisionFormat})
          decision=decisionSchema.parse(JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi,'')))
        }
        await gate()
        if(decision.decision==='blocked')throw new ChatError(decision.message || 'The next action needs clarification.')
        if(decision.decision==='complete') {
          if(!results.length || !task.receipts.some(r=>r.outcome==='verified') || !results.some(result=>Boolean(JSON.parse(result).message)))throw new ChatError('The planner reported completion without a verified local result.')
          task.finished=true;delete task.context;this.journal.save(task)
          status.requests=Math.max(0,this.journal.usage().requests-startedRequests)
          const text=last || results.map(item=>JSON.parse(item)).findLast(item=>item.message)?.message
          cmd.announce(status,'complete',text);return {handled:true,success:true,action:'application-automation',text}
        }
        if(i===cfg.maxSteps)throw new ChatError('Automation reached the configured step limit. Verified steps are preserved.')
        const args=JSON.parse(decision.arguments)
        if(decision.tool===describeTool.name){
          const {name}=z.object({name:z.string()}).strict().parse(args)
          requestedSchema=catalog.find(tool=>tool.name===name)
          if(!requestedSchema)throw new ChatError('The requested tool is not registered.')
          continue
        }
        if(task.interruptedVisualApp && !tools.readOnly?.(decision.tool)){
          const ok=await services.confirm('Continue after interrupted visual input?','A previous input in '+APPLICATIONS[appIdentifierSchema.parse(task.interruptedVisualApp)].name+' was applied. Check its effects before approving the next operation: '+decision.tool+' '+redactOutput(JSON.stringify(args)).slice(0,500),signal)
          if(!ok)throw new ChatError('The next operation was declined. Earlier input was preserved.')
          await gate()
        }
        let outcome:Record<string,unknown>
        if(decision.tool==='approved_window') {
          if(!api)throw new ChatError('This step requires visual computer use. Use a supported structured control or enable OpenAI visual automation.')
          const {app}=z.object({app:appIdentifierSchema}).strict().parse(args)
          status.application=APPLICATIONS[app].name; report('Inspecting '+status.application)
          const driver=await services.visual(app,objective,assertCloud,signal,observed)
          try {
            const before=task.receipts.length
            const message=await api.visual(services.config(),redactOutput(objective),driver,signal,assertCloud,(_id,action)=>{
              const finish=addReceipt('window.'+action.type,{app,action})
              return ()=>{
                task.interruptedVisualApp=app
                if(driver.target)task.interruptedWindowDigest=fingerprint(JSON.stringify([driver.target.pid,driver.target.window,driver.target.capture]))
                finish()
              }
            },services.config)
            delete task.interruptedVisualApp;delete task.interruptedWindowDigest
            if(task.receipts.length===before)addReceipt('window.observe',{app,observation:fingerprint(message)})()
            outcome={ok:true,message}
            if(directApp){
              status.steps++;task.finished=true;delete task.context;this.journal.save(task)
              status.requests=Math.max(0,this.journal.usage().requests-startedRequests)
              cmd.announce(status,'complete',message);return {handled:true,success:true,action:'application-automation',text:message}
            }
          } catch(error) {
            if(!(error instanceof AutomationUnavailable || error instanceof AutomationBudgetReached) || !services.config().fallback)throw error
            if(task.receipts.some(r=>r.outcome==='pending'))throw new ChatError('Visual input has an uncertain outcome. Inspect the window before retrying.')
            api=undefined;observed=await cmd.observe(signal)
            results.push(JSON.stringify({observation:'Visual service unavailable. Reinspect the target using structured controls. Reviewed input receipts are in completedTools.'}))
            continue
          } finally {driver.dispose?.()}
        } else {
          if(!catalog.some(tool=>tool.name===decision.tool))throw new ChatError('The planner requested an unregistered local action.')
          status.application=appIdentifierSchema.safeParse(args?.app).success?APPLICATIONS[args.app as AppIdentifier].name:undefined
          report(decision.tool.replace(/^athena_/,'').replaceAll('_',' '))
          const done=addReceipt(decision.tool,args)
          tools.assertAccess();await gate()
          outcome=safeResult.parse(JSON.parse(await tools.execute(decision.tool,args,signal)))
          if(!outcome.ok || outcome.verified===false)throw new ChatError(String(outcome.message || outcome.error || 'The local action was not verified.'))
          done()
        }
        status.steps++
        last=String(outcome.message || 'The local action returned a verified receipt.')
        results.push(JSON.stringify({tool:decision.tool,message:redactOutput(last).slice(0,500),observation:redactOutput(JSON.stringify(outcome)).slice(0,1650)}))
        this.journal.checkpoint(task,objective,results)
        observed=await cmd.observe(signal)
      }
      throw new ChatError('Automation stopped at its execution limit.')
    } catch(error) {
      const reason=signal.aborted?'Automation stopped. Review the last verified result.':error instanceof ChatError?error.userMessage:error instanceof AutomationUnavailable?error.message:'The automation response could not be validated. Review the current state before continuing.'
      cmd.announce(status,signal.aborted?'cancelled':'failed',reason)
      return failure(reason+(last?' Last verified result: '+last:''))
    } finally {
      if(activeRecord?.finished && activeRecord.session)this.journal.releaseEnvironment(activeRecord.session)
      if(this.active===active)this.active=undefined
    }
  }
}
