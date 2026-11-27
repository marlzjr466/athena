// @vitest-environment jsdom
import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest'
import { LivePeer } from '../src/services/speech/livePeer'
import { liveVoiceDefaults } from '../shared/liveVoice'
const ipc=vi.hoisted(()=>vi.fn())
const route=vi.hoisted(()=>vi.fn())
vi.mock('../src/services/desktop',()=>({desktop:{liveVoice:ipc}}))
vi.mock('../src/services/speech/audioDevices',()=>({routeSpeech:route}))
const input={kind:'audio',readyState:'live',stop:vi.fn(),enabled:true}
const clone={...input,stop:vi.fn()}
const microphone={...input,clone:()=>clone}
const stream={getAudioTracks:()=>[microphone]} as unknown as MediaStream
let channel:{readyState:string;onmessage?:(event:{data:string})=>void;send:ReturnType<typeof vi.fn>}
let pc:{ontrack?:(e:{track:typeof input})=>void;close:ReturnType<typeof vi.fn>}
const replaceTrack=vi.fn(async (_track: unknown)=>{})
let sound=128
const deliver=(event:object)=>channel.onmessage?.({data:JSON.stringify({event_id:crypto.randomUUID(),...event})})
describe('Live WebRTC ownership',()=>{
  beforeEach(()=>{
    vi.useFakeTimers();vi.clearAllMocks();sound=128
    ipc.mockImplementation(async command=>command.action==='start'?{sdp:'v=0 answer',expiresAt:Date.now()+60000}:{})
    route.mockResolvedValue(()=>{})
    channel={readyState:'open',send:vi.fn()}
    vi.stubGlobal('RTCPeerConnection',class {
      constructor(){pc=this}
      createDataChannel=()=>channel;close=vi.fn();addTrack=vi.fn(()=>({replaceTrack}))
      iceGatheringState='complete';localDescription={sdp:'v=0 test'}
      createOffer=async()=>this.localDescription;setLocalDescription=async()=>{};setRemoteDescription=async()=>{}
    })
    vi.stubGlobal('Audio',class {pause(){}async play(){}volume=1})
    vi.stubGlobal('MediaStream',class {})
    vi.stubGlobal('AudioContext',class {
      createConstantSource=()=>({offset:{value:0},connect:vi.fn(),start:vi.fn(),stop:vi.fn(),disconnect:vi.fn()})
      createMediaStreamDestination=()=>({stream:{getAudioTracks:()=>[clone]}})
      createMediaStreamSource=()=>({connect:vi.fn()})
      createAnalyser=()=>({fftSize:512,getByteTimeDomainData:(s:Uint8Array)=>s.fill(sound)})
      resume=async()=>{};close=async()=>{}
    })
  })
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
  const opts=()=>({mode:'floating' as const,settings:structuredClone(liveVoiceDefaults),stream,volume:1,amplitude:vi.fn(),state:vi.fn(),delegate:vi.fn(async()=>'Verified local result'),ended:vi.fn()})
  it('delegates media resume when no automation task is paused',async()=>{
    const o=opts(),pauseWork=vi.fn(async()=>false),peer=new LivePeer({...o,pauseWork})
    await peer.start();deliver({type:'session.started'})
    deliver({type:'session.input_transcript.delta',start_ms:100,end_ms:300,delta:'Resume'})
    deliver({type:'session.delegation.created',offset_ms:305,delegation:{id:'resume-media',target:'client'}})
    await vi.advanceTimersByTimeAsync(360)
    expect(o.delegate).toHaveBeenCalledWith('Resume',expect.any(String))
    expect(channel.send.mock.calls.flat().join(' ')).not.toContain('There is no active automation')
    peer.close();await vi.advanceTimersByTimeAsync(2000)
  })
  it('keeps late query words that arrive after a delegation with a buffered prefix',async()=>{
    const o=opts(),peer=new LivePeer(o);await peer.start()
    deliver({type:'session.started'})
    deliver({type:'session.input_transcript.delta',start_ms:100,end_ms:250,delta:'Search for'})
    deliver({type:'session.delegation.created',offset_ms:700,delegation:{id:'search',target:'client'}})
    await vi.advanceTimersByTimeAsync(220)
    expect(o.delegate).not.toHaveBeenCalled()
    deliver({type:'session.input_transcript.delta',start_ms:250,end_ms:600,delta:' relaxing piano music'})
    await vi.advanceTimersByTimeAsync(360)
    expect(o.delegate.mock.calls).toEqual([['Search for relaxing piano music',expect.any(String)]])
    peer.close();await vi.advanceTimersByTimeAsync(2000)
  })
  it('keeps listening when a later transcript delta extends a possible goodbye',async()=>{
    const o=opts(),peer=new LivePeer(o);await peer.start();deliver({type:'session.started'})
    deliver({type:'session.input_transcript.delta',start_ms:100,end_ms:200,delta:'Stop listening'})
    await vi.advanceTimersByTimeAsync(90)
    deliver({type:'session.input_transcript.delta',start_ms:200,end_ms:400,delta:' to this playlist'})
    await vi.advanceTimersByTimeAsync(350)
    expect(channel.send.mock.calls.flat().join(' ')).not.toContain('session.close')
    deliver({type:'session.input_transcript.delta',start_ms:2200,end_ms:2600,delta:'Goodbye Athena'})
    await vi.advanceTimersByTimeAsync(350)
    expect(channel.send.mock.calls.flat().join(' ')).toContain('session.close')
    await vi.advanceTimersByTimeAsync(2000)
  })
  it('keeps one live voice session while an automation approval waits beyond the idle timeout',async()=>{
    ipc.mockImplementation(async command=>command.action==='start'?{sdp:'v=0 answer',expiresAt:Date.now()+600000}:{})
    const o=opts()
    let finish!:(value:string)=>void
    const delegate=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve}))
    const peer=new LivePeer({...o,delegate});await peer.start()
    deliver({type:'session.started'})
    deliver({type:'session.input_transcript.delta',start_ms:0,end_ms:200,delta:'Open Chrome'})
    deliver({type:'session.delegation.created',offset_ms:220,delegation:{id:'pending',target:'client'}})
    await vi.advanceTimersByTimeAsync(65000)
    expect(delegate).toHaveBeenCalledOnce();expect(pc.close).not.toHaveBeenCalled()
    finish('Chrome is open.');await vi.advanceTimersByTimeAsync(1)
    expect(channel.send.mock.calls.flat().join(' ')).toContain('Chrome is open.')
    peer.close();await vi.advanceTimersByTimeAsync(2000)
  })
  it('sends one delegation, remains duplex, and follows actual audio energy',async()=>{
    const o=opts(),peer=new LivePeer(o);await peer.start()
    deliver({type:'session.started'});pc.ontrack?.({track:input})
    sound=182;await vi.advanceTimersByTimeAsync(80)
    expect(o.state).toHaveBeenCalledWith('speaking');expect(clone.enabled).toBe(true)
    deliver({type:'session.input_transcript.delta',start_ms:200,end_ms:500,delta:'List local branches'})
    const task={type:'session.delegation.created',offset_ms:505,delegation:{id:'task-1',target:'client'}}
    deliver(task);deliver(task);await vi.advanceTimersByTimeAsync(360)
    expect(o.delegate).toHaveBeenCalledTimes(1)
    expect(channel.send.mock.calls.flat().join(' ')).toContain('Verified local result')
    sound=128;await vi.advanceTimersByTimeAsync(240);expect(o.amplitude).toHaveBeenLastCalledWith(0)
    peer.close();deliver({type:'session.closed',usage:{seconds:8}});await vi.advanceTimersByTimeAsync(1)
    expect(input.stop).not.toHaveBeenCalled();expect(clone.stop).toHaveBeenCalled();expect(pc.close).toHaveBeenCalledTimes(1)
  })
  it('waits for late speech, dismisses stale results, and announces only this session’s verified task once',async()=>{
    const o=opts(), delegate=vi.fn<(text:string,id:string)=>Promise<string>>()
    let finish!:(value:string)=>void
    delegate.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const pauseWork=vi.fn(async()=>true),peer=new LivePeer({...o,delegate,pauseWork})
    await peer.start();deliver({type:'session.started'})
    const task=(id:string,offset_ms:number)=>deliver({type:'session.delegation.created',offset_ms,delegation:{id,target:'client'}})
    const speech=(start_ms:number,end_ms:number,delta:string)=>deliver({type:'session.input_transcript.delta',start_ms,end_ms,delta})
    task('first',300);speech(30,200,'Open this project');await vi.advanceTimersByTimeAsync(460)
    expect(delegate).toHaveBeenCalledTimes(1)
    speech(340,550,'Pause');task('pause',560);await vi.advanceTimersByTimeAsync(360)
    speech(600,800,'Continue');task('resume',810);await vi.advanceTimersByTimeAsync(360)
    expect(pauseWork.mock.calls).toEqual([[true],[false]])
    const request=delegate.mock.calls[0][1]
    peer.automationProgress('unrelated','OpenAI')
    peer.automationProgress(request,'OpenAI')
    peer.automationProgress(request,'OpenAI')
    peer.automationProgress(request,'Athena Native')
    peer.submittedTaskEnded('unrelated',true);peer.submittedTaskEnded(request,true);peer.submittedTaskEnded(request,true)
    peer.stopAutomation();finish('Unexpected late success');await vi.advanceTimersByTimeAsync(1)
    const messages=channel.send.mock.calls.flat().join(' ')
    expect(messages.match(/checking the current state before/g)).toHaveLength(1)
    expect(messages.match(/continuing with the configured fallback/g)).toHaveLength(1)
    expect(messages.match(/requested chat task finished/g)).toHaveLength(1)
    expect(messages).not.toContain('Unexpected late success')
    peer.close();await vi.advanceTimersByTimeAsync(2000)
  })
  it('applies a spoken correction to the pending plan without replaying the original target',async()=>{
    const o=opts(),cancelWork=vi.fn(async()=>finish('Old result'))
    let finish!:(text:string)=>void
    const delegate=vi.fn<(text:string,id:string)=>Promise<string>>().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValueOnce('Opened YouTube')
    const peer=new LivePeer({...o,cancelWork,delegate});await peer.start();deliver({type:'session.started'})
    const turn=(text:string,start:number,id:string)=>{
      deliver({type:'session.input_transcript.delta',start_ms:start,end_ms:start+100,delta:text})
      deliver({type:'session.delegation.created',offset_ms:start+105,delegation:{id,target:'client'}})
    }
    turn('Open Spotify',200,'original');await vi.advanceTimersByTimeAsync(360)
    turn('Actually, open YouTube instead.',500,'correction');await vi.advanceTimersByTimeAsync(360)
    expect(cancelWork).toHaveBeenCalledOnce()
    expect(delegate.mock.calls.map(([text])=>text)).toEqual(['Open Spotify','open YouTube'])
    expect(channel.send.mock.calls.flat().join(' ')).not.toContain('Old result')
    expect(channel.send.mock.calls.flat().join(' ')).toContain('Opened YouTube')
    peer.close();await vi.advanceTimersByTimeAsync(2000)
  })
  it('stops when the output disconnects and never delegates a preview',async()=>{
    const o=opts(),peer=new LivePeer({...o,mode:'preview',stream:undefined,delegate:undefined})
    await peer.start();deliver({type:'session.started'})
    deliver({type:'session.delegation.created',offset_ms:50,delegation:{id:'test',target:'client'}})
    expect(o.delegate).not.toHaveBeenCalled()
    route.mock.calls[0][1]('Speaker disconnected.')
    expect(clone.stop).toHaveBeenCalled();expect(o.amplitude).toHaveBeenLastCalledWith(0)
    await vi.advanceTimersByTimeAsync(2000);expect(o.ended).toHaveBeenCalledWith('Speaker disconnected.')
  })
  it('replaces the microphone without another paid session or stopping the source owner',async()=>{
    const o=opts(),peer=new LivePeer(o);await peer.start();deliver({type:'session.started'})
    const replacement={...input,stop:vi.fn()}
    const original={...input,stop:vi.fn(),clone:()=>replacement}
    await peer.replaceMicrophone({getAudioTracks:()=>[original]} as unknown as MediaStream)
    expect(replaceTrack).toHaveBeenCalledWith(replacement)
    expect(clone.stop).toHaveBeenCalledOnce();expect(original.stop).not.toHaveBeenCalled()
    expect(pc.close).not.toHaveBeenCalled()
    expect(ipc.mock.calls.filter(([cmd])=>cmd.action==='start')).toHaveLength(1)
    peer.close();await vi.advanceTimersByTimeAsync(2000)
    expect(replacement.stop).toHaveBeenCalledOnce()
  })
  it('times out on silence and never creates a second session',async()=>{
    const o=opts();o.settings.idleSeconds=5
    const peer=new LivePeer(o);await peer.start();deliver({type:'session.started'})
    await vi.advanceTimersByTimeAsync(7000)
    expect(o.ended).toHaveBeenCalledWith('Returned to local wake-word listening.')
    expect(ipc.mock.calls.filter(([cmd])=>cmd.action==='start')).toHaveLength(1)
  })
})
