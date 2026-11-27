import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { VoiceMemory } from '../electron/main/voice/voiceMemory'
import { LiveVoiceService } from '../electron/main/voice/liveVoice'
import { initialDesign, liveVoiceDefaults, type LiveVoiceSettings } from '../shared/liveVoice'
import { restoreSettings } from '../shared/settings'
import { isLiveGoodbye, LiveTranscript } from '../src/services/speech/livePeer'

describe('GPT-Live main-process session and voice library',()=>{
  let dir:string,file:string,settings:LiveVoiceSettings,allowed:boolean,key:string|undefined
  const fetcher=vi.fn<typeof fetch>()
  const build=()=>new LiveVoiceService(file,()=>settings,async()=>key,async()=>'test-account',()=>allowed,next=>{settings=next},fetcher)
  const offer=()=>({action:'start' as const,request:randomUUID(),mode:'floating' as const,sdp:'v=0 fixture'})
  const answer=()=>Response.json({session:{id:'session-fixture'},transport:{type:'webrtc',sdp:'v=0 answer'}})
  beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'athena-live-fixture-'));file=join(dir,'ledger');settings=structuredClone(liveVoiceDefaults);allowed=true;key='fixture-key';fetcher.mockReset()})
  afterEach(()=>{rmSync(dir,{recursive:true,force:true});vi.useRealTimers()})
  it('migrates the voice default and keeps a previous local selection and microphone consent',()=>{
    const saved=restoreSettings({localVoice:{...restoreSettings({}).localVoice,engine:'higgs-tts-3-4b'}})
    expect(saved.localVoice.engine).toBe('chatterbox-turbo');expect(saved.liveVoice).toMatchObject({engine:'live',cloudAllowed:false,monthlyUSD:80,idleSeconds:60,voices:[]})
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('creates an original voice once, reuses the returned ID, and preserves explicit selections on regeneration',async()=>{
    const svc=build()
    const generated=(id:string)=>Response.json({id,name:'Athena Youthful',type:'prompt',object:'audio.voice',created_at:1})
    fetcher.mockResolvedValueOnce(generated('voice_1')).mockResolvedValueOnce(generated('voice_2'))
    await svc.generate(initialDesign);expect(settings.voice).toBe('voice_1')
    const [url,init]=fetcher.mock.calls[0];expect(url).toBe('https://api.openai.com/v1/audio/voices')
    expect(JSON.parse(String(init?.body))).toMatchObject({type:'prompt',model:'auto',name:'Athena Youthful'})
    expect((await build().generate(initialDesign)).saved?.id).toBe('voice_1')
    settings.voice='gleam';await svc.generate(initialDesign,true)
    expect(settings.voice).toBe('gleam');expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('does not present a failed creation as a saved voice',async()=>{
    fetcher.mockResolvedValue(Response.json({error:{code:'access_denied'}},{status:403}))
    await expect(build().generate(initialDesign)).rejects.toThrow();expect(settings.voices).toEqual([])
  })
  it('validates ownership, meters cumulative receipts once and persists after restart',async()=>{
    const svc=build(),cmd=offer();fetcher.mockResolvedValueOnce(answer()).mockResolvedValueOnce(new Response())
    await svc.start(4,cmd);expect(svc.floating(4)).toBe(true)
    const body=JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.session).toMatchObject({model:'gpt-live-1.1',store:false,delegation:{type:'client'},audio:{output:{voice:'marin'}}})
    expect(body.session.client.data_channel.allowed_server_events).toContainEqual({type:'session.started'})
    await expect(svc.start(5,offer())).rejects.toThrow(/already active/)
    await svc.close(5,cmd.request);expect(svc.snapshot().active).toBe(true)
    svc.usage(4,cmd.request,30);svc.usage(4,cmd.request,30)
    await svc.close(4,cmd.request,32)
    expect(build().snapshot().monthly).toBeCloseTo(32*0.05/60)
    await expect(svc.start(4,cmd)).rejects.toThrow(/already been attempted/)
  })
  it('negotiates fresh media with ordered native history, rejects stale checkpoints and excludes settings previews',async()=>{
    const memory=new VoiceMemory(dir)
    const svc=new LiveVoiceService(file,()=>settings,async()=>key,async()=>'account',()=>allowed,()=>{},fetcher,undefined,memory)
    fetcher.mockImplementation(async url=>String(url).endsWith('/hangup')?new Response():answer())
    const first={...offer(),initial:'We are building a music app.'}
    const original=await svc.start(1,first)
    const item={id:'response',offset:1200,role:'assistant' as const,text:'Which instruments?'}
    await svc.checkpoint(1,first.request,[item]);await svc.checkpoint(1,first.request,[item])
    await svc.close(1,first.request)
    const next=offer(),recovered=await svc.start(1,next)
    expect(recovered).toMatchObject({conversationId:original.conversationId,restoredItems:2})
    const body=JSON.parse(String(fetcher.mock.calls[2][1]?.body))
    expect(body.session.input.slice(0,2)).toEqual([
      {role:'user',content:[{type:'input_text',text:first.initial}]},
      {role:'assistant',content:[{type:'output_text',text:item.text}]},
    ])
    await expect(svc.checkpoint(1,first.request,[item])).rejects.toThrow(/ended/)
    await svc.close(1,next.request)
    const preview={...offer(),mode:'preview' as const}
    expect((await svc.start(2,preview)).conversationId).toBeUndefined()
    expect(JSON.stringify(fetcher.mock.calls[4][1]?.body)).not.toContain('instruments')
    await svc.close(2,preview.request)
  })
  it('revokes the matching automation lease immediately, even while remote hangup is pending',async()=>{
    const closed=vi.fn()
    const svc=new LiveVoiceService(file,()=>settings,async()=>key,async()=>'fixture',()=>allowed,()=>{},fetcher,closed)
    const cmd=offer()
    let finishHangup!:(r:Response)=>void
    fetcher.mockResolvedValueOnce(answer()).mockImplementationOnce(()=>new Promise(resolve=>{finishHangup=resolve}))
    await svc.start(1,cmd)
    expect(svc.floatingRequest(1)).toBe(cmd.request)
    expect(svc.floatingRequest(2)).toBeUndefined()
    await svc.close(1,'other')
    expect(closed).not.toHaveBeenCalled()
    const closing=svc.close(1,cmd.request)
    expect(closed).toHaveBeenCalledExactlyOnceWith(cmd.request)
    expect(svc.floatingRequest(1)).toBeUndefined()
    finishHangup(new Response());await closing
  })
  it('uses a hard deadline and blocks depleted budgets, missing credentials and lost permission before submission',async()=>{
    vi.useFakeTimers();settings.monthlyUSD=.025
    const svc=build(),cmd=offer();fetcher.mockResolvedValueOnce(answer()).mockResolvedValueOnce(new Response())
    const result=await svc.start(1,cmd);expect(result.expiresAt!-Date.now()).toBe(30000)
    await vi.advanceTimersByTimeAsync(30001);expect(svc.snapshot().active).toBe(false)
    await expect(svc.start(1,offer())).rejects.toThrow(/budget/)
    key=undefined;await expect(svc.start(1,offer())).rejects.toThrow(/key/)
    key='fixture';allowed=false;await expect(svc.start(1,offer())).rejects.toThrow(/disabled/)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('keeps an uncertain reservation without a second session attempt',async()=>{
    settings.maxSeconds=30;fetcher.mockRejectedValue(new TypeError('network interrupted'))
    await expect(build().start(1,offer())).rejects.toThrow(/before.*confirmed/)
    expect(fetcher).toHaveBeenCalledTimes(1);expect(build().snapshot().monthly).toBeCloseTo(.025)
  })
  it('refuses paid sessions if the durable ledger cannot be verified',async()=>{
    writeFileSync(file,'bad ledger');await expect(build().start(1,offer())).rejects.toThrow(/ledger/);expect(fetcher).not.toHaveBeenCalled()
  })
  it('separates transcript turns, rejects duplicate delegations and recognizes goodbye',()=>{
    const text=new LiveTranscript('open my project');expect(text.take(100)).toBe('open my project')
    text.append(120,200,'list');text.append(201,300,' branches')
    expect(text.take(310)).toBe('list branches');expect(text.take(310)).toBe('')
    expect(isLiveGoodbye('Goodbye, Athena.')).toBe(true);expect(isLiveGoodbye('Write a story about goodbye Athena')).toBe(false)
  })
  it('preserves transcript delivery order when audio ranges overlap',()=>{
    const text=new LiveTranscript()
    text.append(100,300,'Open a new tab')
    text.append(100,250,' in Google Chrome')
    expect(text.take(310)).toBe('Open a new tab in Google Chrome')
    expect(text.take(310)).toBe('')
  })
})
