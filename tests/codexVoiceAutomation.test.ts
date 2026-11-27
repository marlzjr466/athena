// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIChunk, ChatMessage } from '../shared/chat'
import type { StreamOptions } from '../electron/main/ai/AIProvider'
import type { CodexCLIService } from '../electron/main/ai/codexCLIService'
import { CodexAppServerProvider } from '../electron/main/ai/CodexAppServerProvider'
import { CodexVoiceAutomation, type CodexVoiceOptions } from '../electron/main/ai/codexVoiceAutomation'
import type { CodexBrowserTarget } from '../electron/main/desktop/codexComputerTools'

describe('floating Codex automation ownership',()=>{
  let cwd:string
  beforeEach(()=>{cwd=mkdtempSync(join(tmpdir(),'athena-voice-thread-'))})
  afterEach(()=>{vi.restoreAllMocks();rmSync(cwd,{recursive:true,force:true})})
  function fixture() {
    const receipts:string[]=[], actions:string[]=[]
    let observation=false, status='verified', answer='A model claim.', confirmed=true, lastFailure:string|undefined
    let submittedSearch=false
    let retryScope:{target?:CodexBrowserTarget}|undefined
    const restrictSearchRetry=vi.fn()
    const selection=vi.fn(async()=>({model:'test-native-model',identity:'fixture@example.test'}))
    const dispose=vi.fn(),forget=vi.fn(),announce=vi.fn()
    const tools=vi.fn<CodexVoiceOptions['tools']>(()=>({
      definitions:[],assertAccess:()=>{},execute:async()=>'{}',verifiedResults:()=>receipts,verifiedActions:()=>actions,verifiedSearchSubmission:()=>submittedSearch,hasObservation:()=>observation,lastFailure:()=>lastFailure,dispose,
      searchRetryScope:()=>retryScope,restrictSearchRetry,
    }))
    const stream=vi.spyOn(CodexAppServerProvider.prototype,'streamMessage').mockImplementation(async function*(messages:ChatMessage[],options:StreamOptions={}):AsyncIterable<AIChunk>{
      const host=options.nativeCodex!
      host.persist({threadId:host.state?.threadId ?? 'thread-'+messages[0].id, account:'fixture',cwd,voiceAutomation:true,
        submission:confirmed?'completed':'failed',turnId:'turn-'+messages[0].id,lastMessageId:messages[0].id})
      host.finalText?.(JSON.stringify({status,message:answer}))
      yield {type:'done'}
    })
    const service=new CodexVoiceAutomation({cwd,service:{} as CodexCLIService,selection,tools,announce,forget})
    return {service,stream,selection,tools,dispose,forget,announce,receipts,actions,report:(s:string,m:string)=>{status=s;answer=m},
      markSearchSubmitted:()=>{submittedSearch=true},markObserved:()=>{observation=true},fail:()=>{confirmed=false},toolFailed:(reason:string)=>{lastFailure=reason},
      allowPreInputRetry:(scope:{target?:CodexBrowserTarget}={})=>{retryScope=scope},restrictSearchRetry}
  }
  it('reuses one native thread and model across follow-ups, returning only actual verified results',async()=>{
    const f=fixture()
    f.receipts.push('Chrome is focused.')
    f.actions.push('Chrome is focused.')
    const first=f.service.run('lease','a','Open Chrome',()=>true)
    const duplicate=f.service.run('lease','a','Open Chrome',()=>true)
    expect(first).toBe(duplicate)
    expect((await f.service.run('lease','a','Close Chrome',()=>true)).ok).toBe(false)
    expect(await first).toEqual({ok:true,text:'Chrome is focused.',memoryOutcome:'verified'})
    expect(await f.service.run('lease','a','Open Chrome',()=>true)).toEqual(await first)
    await f.service.run('lease','b','Go back',()=>true)
    expect(f.stream).toHaveBeenCalledTimes(2)
    const second=f.stream.mock.calls[1]
    expect(second[0]).toHaveLength(1)
    expect(second[0][0].content).toBe('Go back')
    expect(second[1]).toMatchObject({permissionMode:'read-only',nativeCodex:{voiceOnly:true,writableRoots:[],state:{threadId:'thread-a'}}})
    expect(f.selection).toHaveBeenCalledTimes(1)
    expect(f.tools.mock.calls.map(([ctx])=>ctx.owner)).toEqual(['voice:lease','voice:lease'])
    expect(f.dispose).toHaveBeenCalledTimes(2)
    f.service.end('other-lease')
    expect(f.forget).not.toHaveBeenCalled()
    f.service.end('lease')
    expect(f.forget).toHaveBeenCalledWith('voice:lease')
    await f.service.run('new-lease','c','Open Chrome',()=>true)
    expect(f.stream.mock.calls[2][1]?.nativeCodex?.state).toBeUndefined()
  })
  it('rechecks authority after transport loss and reuses the logical voice thread without replaying its last turn',async()=>{
    const f=fixture()
    f.receipts.push('Chrome is focused.');f.actions.push('Chrome is focused.')
    await f.service.run('conversation','first','Open Chrome',()=>true)
    f.service.disconnect('conversation')
    expect(f.forget).toHaveBeenCalledWith('voice:conversation')
    const denied=await f.service.run('conversation','denied','Go back',()=>false)
    expect(denied.ok).toBe(false)
    await f.service.run('conversation','second','Go back',()=>true)
    expect(f.stream).toHaveBeenCalledTimes(2)
    expect(f.stream.mock.calls[1][1]?.nativeCodex?.state?.threadId).toBe('thread-first')
  })
  it('rejects a model-only success or missing native completion, and allows clarification',async()=>{
    const f=fixture()
    expect((await f.service.run('lease','1','Play',()=>true)).ok).toBe(false)
    f.report('clarify','Which window should I use?')
    expect(await f.service.run('lease','2','Play',()=>true)).toEqual({ok:true,text:'Which window should I use?'})
    f.fail()
    expect((await f.service.run('lease','3','Play',()=>true)).ok).toBe(false)
  })
  it('speaks a screen description only after a current observation for an observation request',async()=>{
    const f=fixture()
    f.receipts.push('The target window is focused.')
    f.report('observation','There are two visible tabs.')
    expect((await f.service.run('lease','1','What is visible?',()=>true)).ok).toBe(false)
    f.markObserved()
    expect((await f.service.run('lease','2','What is visible?',()=>true)).text).toBe('There are two visible tabs.')
    expect((await f.service.run('lease','3','Play a video',()=>true)).ok).toBe(false)
  })
  it.each(['observation','verified','blocked'])('cannot report a requested change from a screenshot (model status %s)',async status=>{
    const f=fixture()
    f.markObserved(); f.receipts.push('Observed the approved browser window.')
    f.report(status,'I clicked the visible button and the video is playing.')
    for(const [i,prompt] of ['Click the visible button on my screen','Describe my screen then click Play','Open the video'].entries()){
      const result=await f.service.run('lease',String(i),prompt,()=>true)
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/could not be verified/)
      expect(result.message).not.toMatch(/clicked|playing/)
      expect(f.announce.mock.lastCall?.[0].phase).toBe('failed')
    }
  })
  it('requires the actual search submission even when the model reports success after verified typing',async()=>{
    const f=fixture(),objective='Okay, got it now. Um, search for relaxing piano music.'
    f.actions.push('Opened the requested tab.','Verified the text in the search field.')
    f.receipts.push(...f.actions)
    f.report('verified','I searched and found the results.')
    const partial=await f.service.run('lease','typed-only',objective,()=>true)
    expect(partial).toEqual({ok:false,message:'Opened the requested tab. Verified the text in the search field. Search submission could not be verified.'})
    expect(f.announce.mock.lastCall?.[0].phase).toBe('failed')
    f.markSearchSubmitted()
    f.actions.push('The same tab navigated with the exact submitted search query.')
    const complete=await f.service.run('lease','actually-submitted',objective,()=>true)
    expect(complete).toEqual({ok:true,text:f.actions.join(' '),memoryOutcome:'verified'})
    expect(f.announce.mock.lastCall?.[0].phase).toBe('complete')
  })
  it('reports only completed local steps when part of an objective remains unverified',async()=>{
    const f=fixture()
    f.actions.push('Opened a tab in the current Chrome window.')
    f.receipts.push(...f.actions,'Observed the approved browser window.')
    f.report('partial','The checkout was successful.')
    const result=await f.service.run('lease','1','Open a new tab and play the first result',()=>true)
    expect(result).toEqual({ok:false,message:'Opened a tab in the current Chrome window. The remaining objective could not be verified.'})
    expect(f.announce.mock.lastCall?.[0].phase).toBe('failed')
  })
  it('binds an explicitly spoken retry to the previous exact search, native thread and target',async()=>{
    const f=fixture(),objective='Search for relaxing piano.',spoken='Um. I just focused it now. Can you try?'
    const scope={target:{app:'chrome' as const,pid:4,window:'window-4',tab:'youtube-tab',url:'https://www.youtube.com/'}}
    f.allowPreInputRetry(scope)
    f.toolFailed('Focus the browser tab once.')
    expect((await f.service.run('voice','first',objective,()=>true)).ok).toBe(false)
    expect((await f.service.run('voice','context','Okay, I have focused it now.',()=>true)).text).toMatch(/previous search/)
    expect(f.stream).toHaveBeenCalledTimes(1)
    f.markSearchSubmitted()
    f.actions.push('Verified the actual search submission.')
    const again=f.service.run('voice','repeat',spoken,()=>true)
    expect(f.service.run('voice','repeat',spoken,()=>true)).toBe(again)
    expect((await again).ok).toBe(true)
    expect(f.restrictSearchRetry).toHaveBeenCalledExactlyOnceWith(scope)
    expect(f.tools.mock.calls[1][0].objective).toBe(objective)
    const sent=f.stream.mock.calls[1]
    expect(sent[1]?.nativeCodex?.state?.threadId).toBe('thread-first')
    expect(sent[0]).toHaveLength(1)
    expect(sent[0][0]).toMatchObject({id:'repeat',content:expect.stringContaining(spoken)})
    expect(sent[0][0].content).toContain('"relaxing piano"')
    expect(sent[0][0].content).not.toContain(objective)
    expect((await f.service.run('voice','completed-retry','Try again.',()=>true)).text).toMatch(/Which action/)
    expect(f.stream).toHaveBeenCalledTimes(2)
  })
  it.each(['uncertain-submit','expired','cancelled','ended','revoked','other-request'])('does not issue a search retry after %s',async condition=>{
    const f=fixture()
    if(condition!=='uncertain-submit')f.allowPreInputRetry()
    f.toolFailed(condition==='uncertain-submit'?'Submission was attempted but navigation could not be verified.':'Focus the intended browser tab.')
    const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now)
    await f.service.run('voice','initial','Search relaxing piano',()=>true)
    if(condition==='expired')clock.mockReturnValue(now+120_001)
    if(condition==='cancelled')f.service.cancel()
    if(condition==='ended')f.service.end('voice')
    if(condition==='revoked')await f.service.run('voice','revoked','Can you try?',()=>false)
    if(condition==='other-request')await f.service.run('voice','superseding','Open Finder',()=>true)
    const previous=f.stream.mock.calls.length
    expect((await f.service.run('voice','after','Could you try it again?',()=>true)).text).toMatch(/Which action/)
    expect(f.stream).toHaveBeenCalledTimes(previous)
    expect(f.restrictSearchRetry).not.toHaveBeenCalled()
  })
  it('explains a blocked action using the local executor’s failure even after a fresh capture',async()=>{
    const f=fixture()
    f.markObserved()
    f.receipts.push('Observed the browser window.')
    f.toolFailed('The selected tab changed. Share the intended tab again.')
    f.report('blocked','I played the video.')
    const reply=await f.service.run('lease','one','Play the first result',()=>true)
    expect(reply.ok).toBe(false)
    expect(reply.message).toContain('The selected tab changed.')
    expect(reply.message).not.toContain('played')
  })
  it('pauses only the owning task and aborts pending computer input when the voice lease closes',async()=>{
    const f=fixture()
    let entering!:()=>void
    const entered=new Promise<void>(resolve=>{entering=resolve})
    let next!:()=>void
    const resume=new Promise<void>(resolve=>{next=resolve})
    const input=vi.fn()
    f.stream.mockImplementation(async function*(){
      entering();await resume
      const ctx=f.tools.mock.calls[0][0]
      await ctx.check(ctx.signal);input()
      yield {type:'done'}
    })
    const turn=f.service.run('lease','active','Click Play',()=>true)
    await entered
    expect(f.service.control('chat-task','stop')).toBe(false)
    expect(f.service.steer('wrong-lease',true)).toBe(false)
    expect(f.service.steer('lease',true)).toBe(true)
    next()
    await Promise.resolve()
    expect(input).not.toHaveBeenCalled()
    f.service.end('lease')
    expect((await turn).ok).toBe(false)
    expect(input).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
    expect((await f.service.run('lease','expired','Play',()=>false)).ok).toBe(false)
    expect(f.stream).toHaveBeenCalledTimes(1)
  })
})
