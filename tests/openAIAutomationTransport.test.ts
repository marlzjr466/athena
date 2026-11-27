// @vitest-environment node
import OpenAI from 'openai'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applicationAutomationDefaults } from '../shared/applicationAutomation'
import { AutomationJournal } from '../electron/main/ai/automationJournal'
import { AutomationUnavailable, OpenAIAutomation } from '../electron/main/ai/openAIAutomation'

let directory:string
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'athena-managed-stream-'))})
afterEach(async()=>{await rm(directory,{recursive:true,force:true})})

const decision={decision:'act',tool:'athena_chat_task_status',arguments:'{}',message:''}
const session={id:'fixture_session',required_actions:[]}
const turn={id:'fixture_turn',session_id:session.id,subagent_id:null,status:'completed'}
const usage={input_tokens:120,output_tokens:30,total_tokens:150}
function events(code?:string) {
  const list:Array<Record<string,unknown>>=[
    {type:'agent.session.created',session},
    {type:'agent.session.turn.created',turn:{...turn,status:'in_progress'}},
  ]
  if(code)list.push({type:'agent.session.turn.failed',turn:{...turn,status:'failed',error:{code}},usage})
  else list.push(
    {type:'agent.session.turn.item.done',output_index:0,item:{id:'item_1',type:'message',role:'assistant',turn_id:turn.id,status:'completed',content:[{type:'output_text',text:JSON.stringify(decision)}]}},
    {type:'agent.session.turn.completed',turn,usage},
    {type:'agent.session.idle',session},
  )
  return list.map((event,index)=>'data: '+JSON.stringify({...event,event_id:'e'+index,session_id:session.id,turn_id:turn.id})+'\n\n').join('')
}
function setup(response:()=>Response) {
  const journal=new AutomationJournal(directory)
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>response())
  const client=new OpenAI({apiKey:'fixture',baseURL:'http://127.0.0.1:1/v1',fetch,maxRetries:0})
  const api=new OpenAIAutomation('fixture',journal,client)
  const record=journal.begin('local_request','chat','Inspect the task',true)
  const next=()=>api.next(applicationAutomationDefaults,'test-account',record,'Inspect the task',new AbortController().signal)
  return {fetch,api,record,journal,next}
}
const eventResponse=(code?:string)=>new Response(events(code),{headers:{'Content-Type':'text/event-stream'}})
describe('official OpenAI automation SDK transport',()=>{
  it('collects a managed action and its metered usage from a real SDK event stream',async()=>{
    const f=setup(()=>eventResponse())
    expect(await f.next()).toEqual(decision)
    const [url,init]=f.fetch.mock.calls[0]
    expect(String(url)).toMatch(/\/v1\/agents\/sessions$/)
    expect(JSON.parse(String(init?.body))).toMatchObject({stream:true,environment:{type:'none'},agent:{model:applicationAutomationDefaults.model,tools:[],multi_agent:{enabled:false}}})
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('local_request-plan-1')
    expect(f.record.session).toBe(session.id)
    expect(f.journal.usage()).toMatchObject({requests:1,unreported:0})
  })
  it('classifies a streamed exhausted-credit failure for fallback and retains measured usage',async()=>{
    const f=setup(()=>eventResponse('credit_balance_exhausted'))
    await expect(f.next()).rejects.toBeInstanceOf(AutomationUnavailable)
    expect(f.journal.usage()).toMatchObject({requests:1,unreported:0})
  })
  it('preserves streamed safety denials and HTTP permission denials',async()=>{
    await expect(setup(()=>eventResponse('cyber_policy')).next()).rejects.not.toBeInstanceOf(AutomationUnavailable)
    const forbidden=setup(()=>Response.json({error:{code:'model_not_found',message:'Access forbidden'}},{status:403}))
    await expect(forbidden.next()).rejects.toThrow(/declined.*403/)
  })
  it('retains the request reservation when transport cannot report its usage',async()=>{
    const f=setup(()=>Response.json({error:{code:'insufficient_quota',message:'Quota exhausted'}},{status:429}))
    await expect(f.next()).rejects.toBeInstanceOf(AutomationUnavailable)
    expect(f.journal.usage()).toMatchObject({requests:1,unreported:1})
    expect(f.journal.budgetReason(10,1)).toContain('unreported')
  })
})
