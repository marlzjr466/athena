import { chromium, expect, test } from '@playwright/test'
import { build } from 'esbuild'
import type { LiveCommand } from '../../shared/liveVoice'
import { liveVoiceDefaults } from '../../shared/liveVoice'
import type { LivePeer } from '../../src/services/speech/livePeer'

test('real WebRTC audio, interruption and delegation with a local provider fixture', async () => {
  const browser=await chromium.launch({channel:'chrome',args:['--autoplay-policy=no-user-gesture-required','--mute-audio']})
  try {
    const page=await browser.newPage()
    await page.route('http://localhost/voice-fixture',route=>route.fulfill({contentType:'text/html',body:'<title>Athena voice fixture</title>'}))
    await page.goto('http://localhost/voice-fixture')
    await page.evaluate(()=>{
      const server=new RTCPeerConnection(),context=new AudioContext()
      const audio=context.createMediaStreamDestination(),tone=context.createOscillator(),gain=context.createGain()
      gain.gain.value=0;tone.connect(gain);gain.connect(audio);tone.start()
      server.addTrack(audio.stream.getAudioTracks()[0],audio.stream)
      let channel:RTCDataChannel,results=0,starts=0
      const event=(type:string,rest={})=>channel.send(JSON.stringify({type,event_id:crypto.randomUUID(),...rest}))
      server.ondatachannel=e=>{
        channel=e.channel
        channel.onopen=()=>{event('session.started');gain.gain.value=.2}
        channel.onmessage=raw=>{const command=JSON.parse(raw.data)
          if(command.type==='session.commentary.append')results++
          if(command.type==='session.close')event('session.closed',{usage:{seconds:3}})
        }
      }
      const liveVoice=async(command:LiveCommand)=>{
        if(command.action!=='start')return {}
        starts++;await context.resume()
        await server.setRemoteDescription({type:'offer',sdp:command.sdp});await server.setLocalDescription(await server.createAnswer())
        if(server.iceGatheringState!=='complete')await new Promise<void>(resolve=>{server.onicegatheringstatechange=()=>{if(server.iceGatheringState==='complete')resolve()}})
        return {sdp:server.localDescription!.sdp,expiresAt:Date.now()+20000}
      }
      Object.assign(window,{athena:{liveVoice,audioDevices:async()=>({revision:1,outputHeld:false,output:{deviceId:'default'}})},fixture:{
        interrupt(){
          gain.gain.value=0
          event('session.input_transcript.delta',{delta:'What time',start_ms:100,end_ms:220})
          event('session.delegation.created',{offset_ms:450,delegation:{id:'one',target:'client'}})
          setTimeout(()=>event('session.input_transcript.delta',{delta:' is it?',start_ms:220,end_ms:400}),120)
        },
        results:()=>({results,starts}),stream:audio.stream,cleanup(){server.close();tone.stop();void context.close()},
      }})
    })
    const bundle=await build({entryPoints:['src/services/speech/livePeer.ts'],bundle:true,write:false,platform:'browser',format:'iife',globalName:'AthenaLive',define:{'import.meta.env.DEV':'false'}})
    await page.addScriptTag({content:bundle.outputFiles[0].text})
    type Fixture = {AthenaLive:{LivePeer:typeof LivePeer}; fixture:{stream:MediaStream;interrupt():void;cleanup():void;results():{results:number;starts:number}};peer:LivePeer;level:number;ended:string;delegated:string}
    await page.evaluate(async settings=>{
      const w=window as unknown as Fixture
      w.peer=new w.AthenaLive.LivePeer({mode:'floating',settings,stream:w.fixture.stream,volume:1,state:()=>{},amplitude:v=>{w.level=v},delegate:async text=>{w.delegated=text;return 'The fixture clock reports noon.'},ended:v=>{w.ended=v}})
      await w.peer.start()
    },liveVoiceDefaults)
    await expect.poll(()=>page.evaluate(()=>(window as unknown as Fixture).peer.metrics.firstAudioMs)).toBeGreaterThan(0)
    await page.evaluate(async()=>{
      const w=window as unknown as Fixture
      // Real browser RTCRtpSender replacement, with a local synthetic source.
      await w.peer.replaceMicrophone(w.fixture.stream)
      await w.peer.replaceMicrophone(w.fixture.stream)
    })
    expect(await page.evaluate(()=>(window as unknown as Fixture).fixture.results().starts)).toBe(1)
    const interrupt=await page.evaluate(()=>{(window as unknown as Fixture).fixture.interrupt();return performance.now()})
    await expect.poll(()=>page.evaluate(()=>(window as unknown as Fixture).fixture.results()),{intervals:[20,40]}).toEqual({starts:1,results:1})
    expect(await page.evaluate(()=>(window as unknown as Fixture).delegated)).toBe('What time is it?')
    await expect.poll(()=>page.evaluate(()=>(window as unknown as Fixture).level),{intervals:[20,40]}).toBe(0)
    const timing=await page.evaluate(start=>{const w=window as unknown as Fixture;w.peer.close();return {...w.peer.metrics,interruptToSilenceMs:Math.round(performance.now()-start)}},interrupt)
    await expect.poll(()=>page.evaluate(()=>(window as unknown as Fixture).ended)).toBe('Voice session stopped.')
    await page.evaluate(()=>(window as unknown as Fixture).fixture.cleanup())
    console.info('Local WebRTC fixture',timing)
  } finally {await browser.close()}
})
