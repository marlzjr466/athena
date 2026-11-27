import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationAutomationDefaults as defaults, computerInstruction, isPageSearchRequest } from '../shared/applicationAutomation'
import { APPLICATIONS } from '../shared/desktopActions'
import { settingsSchema } from '../shared/settings'
import { ApplicationAutomation, type AutomationCommand } from '../electron/main/ai/applicationAutomation'
import { AutomationJournal } from '../electron/main/ai/automationJournal'
import { AutomationUnavailable, type AutomationDecision } from '../electron/main/ai/openAIAutomation'
import { ChatError } from '../electron/main/ai/AIProvider'
const act:AutomationDecision={decision:'act',tool:'open_window',arguments:'{"app":"chrome"}',message:''}
const complete:AutomationDecision={decision:'complete',tool:'',arguments:'{}',message:'model assertion'}
const objective='Use my computer to open the Chrome window.'
let dir:string
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'athena-task-'))})
afterEach(async()=>{await rm(dir,{recursive:true,force:true})})
function fixture() {
  const config={...defaults,engine:'openai' as typeof defaults.engine}, approved=vi.fn(async()=>true), access=vi.fn(async()=>{})
  const journal=new AutomationJournal(dir,{seal:s=>Buffer.from(s).toString('base64'),open:s=>Buffer.from(s,'base64').toString()})
  const next=vi.fn(async():Promise<AutomationDecision>=>act)
  const visual=vi.fn(),environment=vi.fn()
  const key=vi.fn(async():Promise<string|undefined>=>'test')
  const runner=new ApplicationAutomation({config:()=>config,cloudAllowed:()=>true,credential:key,account:async()=>'account',confirm:approved,
    client:()=>({next,visual,environment}),visual:async()=>({target:{pid:5,window:'first',capture:'window:10:0'},capture:vi.fn(),run:vi.fn(),approveChecks:vi.fn()})},journal)
  const execute=vi.fn(async()=>JSON.stringify({ok:true,verified:true,message:'Chrome window 3 is focused.'}))
  const nativePlan=vi.fn(async(_prompt:string)=>JSON.stringify(complete))
  const cmd:AutomationCommand={id:'test-action',owner:'conversation-1',text:objective,localOnly:false,check:access,observe:async()=>({application:'Chrome'}),
    tools:()=>({definitions:[{name:'open_window',description:'open window',parameters:{}}],assertAccess:()=>{},execute}),nativePlan,announce:vi.fn()}
  const run=()=>runner.run(cmd,new AbortController().signal)
  return {run,runner,cmd,config,approved,access,journal,next,visual,execute,nativePlan,key}
}
describe('application automation',()=>{
  it.each(['Search relaxing music','Search for relaxing piano music','Can you search relaxing music?','Hey Athena, please look up relaxing piano music'])('recognizes a natural current-page search objective: %s',text=>{
    expect(isPageSearchRequest(text)).toBe(true)
    expect(computerInstruction(text)).toBe(true)
  })
  it.each(['Explain how to search relaxing music','Do not search relaxing music','Search my files','Find local projects'])('does not turn analysis, negation or local discovery into a page search: %s',text=>{
    expect(isPageSearchRequest(text)).toBe(false)
  })
  it('uses the existing visual executor for an unexecuted native page action without replaying it',async()=>{
    const f=fixture();f.cmd.text='Resume';f.cmd.visualTarget='chrome'
    f.visual.mockResolvedValue('Observed playback in the approved window')
    expect((await f.run()).success).toBe(true)
    expect(f.visual).toHaveBeenCalledOnce();expect(f.next).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled()
  })
  it('migrates the default engine while preserving existing native and voice choices',()=>{
    const s=settingsSchema.parse({computerUse:{visibleCursor:false,planner:'local'}})
    expect(s.applicationAutomation.engine).toBe('codex');expect(settingsSchema.parse({applicationAutomation:{engine:'openai'}}).applicationAutomation.engine).toBe('openai');expect(s.applicationAutomation).toEqual(defaults);expect(s.computerUse).toMatchObject({planner:'local',visibleCursor:false})
    expect(computerInstruction('Explain how to click a browser button')).toBe(false)
    expect(computerInstruction(objective)).toBe(true)
  })
  it('requires a real receipt and coalesces duplicate task submissions',async()=>{
    const f=fixture();f.next.mockResolvedValueOnce(act).mockResolvedValueOnce(complete)
    const [a,b]=await Promise.all([f.run(),f.run()])
    expect(a).toEqual(b);expect(a.text).toBe('Chrome window 3 is focused.');expect(f.execute).toHaveBeenCalledTimes(1)
    expect(await readFile(join(dir,'application-automation.json'),'utf8')).not.toContain(objective)
  })
  it('uses the native planner with the completed steps on an API outage after a local effect',async()=>{
    const f=fixture()
    f.next.mockResolvedValueOnce(act).mockRejectedValueOnce(new AutomationUnavailable('Quota exhausted'))
    expect((await f.run()).success).toBe(true)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.nativePlan.mock.calls[0]?.[0]).toContain('Chrome window 3 is focused.')
  })
  it('blocks repeated input when the native fallback proposes the same effect',async()=>{
    const f=fixture();f.next.mockResolvedValueOnce(act).mockRejectedValueOnce(new AutomationUnavailable('Unavailable'))
    f.nativePlan.mockResolvedValue(JSON.stringify(act))
    expect((await f.run()).success).toBe(false);expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('stops on provider or local safety denials without falling back',async()=>{
    const f=fixture();f.next.mockRejectedValue(new ChatError('Declined by safety checks'))
    expect((await f.run()).text).toContain('Declined');expect(f.nativePlan).not.toHaveBeenCalled()
    const other=fixture();other.cmd.id='other';other.execute.mockResolvedValue('{"ok":false,"message":"Permission denied"}')
    expect((await other.run()).text).toBe('Permission denied');expect(other.nativePlan).not.toHaveBeenCalled()
  })
  it('a declined cloud disclosure sends nothing and opens no window',async()=>{
    const f=fixture();f.approved.mockResolvedValue(false)
    expect((await f.run()).success).toBe(false);expect(f.next).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled()
  })
  it('works without an API key and respects a disabled fallback and zero budget',async()=>{
    const f=fixture();f.key.mockResolvedValue(undefined);f.nativePlan.mockResolvedValueOnce(JSON.stringify(act))
    expect((await f.run()).success).toBe(true);expect(f.next).not.toHaveBeenCalled()
    const g=fixture();g.cmd.id='other';g.config.monthlyRequests=0;g.config.fallback=false
    expect((await g.run()).text).toMatch(/budget/);expect(g.next).not.toHaveBeenCalled()
  })
  it('does not announce provider-only completion',async()=>{
    const f=fixture();f.next.mockResolvedValue(complete)
    expect((await f.run()).text).toMatch(/without a verified/);expect(f.execute).not.toHaveBeenCalled()
  })
  it('keeps native task status and local fallback available when the OS credential store cannot be opened',async()=>{
    const f=fixture();f.key.mockRejectedValue(new Error('Locked key store'));f.cmd.nativeLocal=true
    f.nativePlan.mockResolvedValueOnce(JSON.stringify(act))
    expect((await f.runner.status()).credential).toBe(false)
    expect((await f.run()).success).toBe(true)
    expect(f.approved).not.toHaveBeenCalled()
  })
  it('does not consult a credential or start inference with OpenAI when the native-only budget is zero',async()=>{
    const f=fixture();f.config.monthlyRequests=0;f.cmd.nativeLocal=true;f.nativePlan.mockResolvedValueOnce(JSON.stringify(act))
    expect((await f.run()).success).toBe(true)
    expect(f.key).not.toHaveBeenCalled();expect(f.next).not.toHaveBeenCalled()
  })
  it('never replays a partial visual interaction against a different window of the same app',async()=>{
    const f=fixture(),original={application:APPLICATIONS.chrome.name,pid:5,window:'first',capture:'window:10:0'}
    f.cmd.text='Use my computer to visually click a button in Chrome.'
    f.cmd.observe=vi.fn().mockResolvedValueOnce(original).mockResolvedValue({...original,window:'second',capture:'window:11:0'})
    f.visual.mockImplementation(async(_config,_prompt,_driver,_signal,_gate,onInput)=>{
      onInput('model_call',{type:'click',x:80,y:40,button:'left'})()
      throw new AutomationUnavailable('Offline')
    })
    const outcome=await f.run()
    expect(outcome.success).toBe(false);expect(outcome.text).toContain('Refocus')
    expect(f.execute).not.toHaveBeenCalled();expect(f.nativePlan).not.toHaveBeenCalled()
  })
  it('pause and stop take effect before local input',async()=>{
    const f=fixture();let ready!:()=>void
    f.next.mockImplementation(()=>new Promise(resolve=>{ready=()=>resolve(act)}))
    const pending=f.run();await vi.waitFor(()=>expect(f.next).toHaveBeenCalledTimes(1))
    f.runner.control({action:'pause',taskId:f.cmd.id});ready()
    await new Promise(r=>setTimeout(r,10));expect(f.execute).not.toHaveBeenCalled()
    f.runner.control({action:'stop',taskId:f.cmd.id})
    expect((await pending).success).toBe(false);expect(f.execute).not.toHaveBeenCalled()
  })
  it('restores an interrupted task in its owning conversation without repeating completed input',async()=>{
    const f=fixture();f.next.mockResolvedValueOnce(act).mockRejectedValueOnce(new ChatError('Task paused'))
    expect((await f.run()).success).toBe(false)
    const other=fixture();other.cmd.text='Resume my last automation';other.cmd.owner='other';expect((await other.run()).success).toBe(false)
    const recovered=fixture();recovered.cmd.text='Resume my last automation';recovered.cmd.id='resume'
    recovered.next.mockResolvedValue(complete)
    expect((await recovered.run()).text).toContain('Chrome window 3');expect(recovered.execute).not.toHaveBeenCalled()
  })
  it('holds unresolved requests in the persisted budget and accounts a response only once',()=>{
    const f=fixture(), settle=f.journal.reserve(1)
    expect(()=>f.journal.reserve(1)).toThrow(/budget/);expect(new AutomationJournal(dir).usage().unreported).toBe(1)
    settle('gpt-6.2-sol',{input_tokens:100,output_tokens:50});settle('gpt-6.2-sol',{input_tokens:100,output_tokens:50})
    expect(new AutomationJournal(dir).usage()).toEqual({requests:1,estimatedUSD:0.0007,unreported:0})
  })
})
