import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { liveVoiceDefaults } from '../../shared/liveVoice'

type Fixture = {
  speak(wav:string):Promise<void>
  drop():void
  started:number
  bargeIns:number
  seededName:boolean
  outputs:number
  timeline: {kind:string;start?:number;end?:number;received:number}[]
}
declare global { interface Window { syntheticMemoryInput:Fixture } }

async function installSyntheticInput(page:Page){
  await page.evaluate(async()=>{
    const audio=new AudioContext()
    const mic=audio.createMediaStreamDestination()
    await audio.resume()
    navigator.mediaDevices.getUserMedia=async()=>mic.stream.clone()
    let liveChannel:RTCDataChannel|undefined
    let origin=performance.now(), sampleAt=0
    const fixture:Fixture={
      started:0,outputs:0,bargeIns:0,seededName:false,timeline:[],
      async speak(wav){
        const source=audio.createBufferSource()
        source.buffer=await audio.decodeAudioData(Uint8Array.from(atob(wav),c=>c.charCodeAt(0)).buffer)
        source.connect(mic)
        await new Promise<void>(done=>{source.onended=()=>{source.disconnect();done()};source.start()})
      },
      drop(){if(!liveChannel || liveChannel.readyState!=='open')throw new Error('No connected data channel');liveChannel.close()},
    }
    const mute=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted')!
    Object.defineProperty(HTMLMediaElement.prototype,'muted',{...mute,set(value:boolean){
      if(value && !this.muted && !this.paused && this.srcObject instanceof MediaStream)fixture.bargeIns++
      mute.set!.call(this,value)
    }})
    const read=AnalyserNode.prototype.getByteTimeDomainData
    AnalyserNode.prototype.getByteTimeDomainData=function(data){
      read.call(this,data)
      const now=performance.now()
      if(fixture.started && now-sampleAt>150 && data.some(x=>Math.abs(x-128)>3)){
        fixture.timeline.push({kind:'playout',received:Math.round(now-origin)});sampleAt=now
      }
    }
    const create=RTCPeerConnection.prototype.createDataChannel
    RTCPeerConnection.prototype.createDataChannel=function(...args){
      const channel=create.apply(this,args)
      if(channel.label==='oai-events'){
        liveChannel=channel
        channel.addEventListener('message',e=>{
          const {type,start_ms,end_ms,session}=JSON.parse(e.data)
          if(type==='session.started'){fixture.started++;fixture.seededName=/blue moon/i.test(JSON.stringify(session?.input || []));origin=performance.now()}
          if(type.includes('transcript.delta'))fixture.timeline.push({kind:type,start:start_ms,end:end_ms,received:Math.round(performance.now()-origin)})
          if(type==='session.output_transcript.delta')fixture.outputs++
        })
      }
      return channel
    }
    window.syntheticMemoryInput=fixture
  })
}

test.use({trace:'off'})
test('signed floating voice remembers a spoken project across a transport loss, silence and an app restart',async()=>{
  test.skip(process.env.ATHENA_PAID_VOICE_MEMORY_TEST!=='authorized','Requires explicit authorization for a paid fictional speech test')
  test.setTimeout(420_000)
  // A persistent disposable test profile keeps the same budget ledger across retries.
  const profile=process.env.ATHENA_MEMORY_PROFILE || await mkdtemp(join(tmpdir(),'athena-memory-acceptance-'))
  if(!/^athena-memory-acceptance-[\w-]+$/.test(profile.split('/').at(-1)!) || ![await realpath(tmpdir()),'/private/tmp'].includes(await realpath(resolve(profile,'..'))))throw new Error('A dedicated temporary memory-test profile is required')
  await mkdir(profile,{recursive:true})
  const binary=process.env.ATHENA_MEMORY_BINARY || resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena')
  const settings={floatingEnabled:false,randomActions:false,randomMovement:false,voiceEnabled:true,voiceMuted:false,webAccess:{webSearchEnabled:false,automaticStartup:false},
    liveVoice:{...liveVoiceDefaults,cloudAllowed:true,fallback:false,maxSeconds:45,idleSeconds:10,monthlyUSD:0.18,historyDays:1}}
  let app:ElectronApplication|undefined
  let control!:Page,floating!:Page
  let passed=false
  const launch=async()=>{
    await writeFile(join(profile,'settings.json'),JSON.stringify(settings))
    app=await electron.launch({executablePath:binary,args:['--use-fake-device-for-media-stream','--mute-audio','--autoplay-policy=no-user-gesture-required','--user-data-dir='+profile]})
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app!.windows().filter(w=>/surface=(control|floating)/.test(w.url())).length).toBe(2)
    control=app.windows().find(w=>w.url().includes('surface=control'))!
    floating=app.windows().find(w=>w.url().includes('surface=floating'))!
    await installSyntheticInput(floating)
    await control.evaluate(async model=>{
      const api=window.athena!,{settings}=await api.getSnapshot()
      if(!(await api.liveVoice({action:'status'})).credential)throw new Error('No verified GPT-Live account in this signed app')
      await api.setPermissionEnabled({permission:'microphone',enabled:true})
      await api.updateSettings({localAI:{...settings.localAI,speechEngine:'whisper-cli',speechModelPath:model},floatingEnabled:true,voiceInteraction:{...settings.voiceInteraction,handsFreeEnabled:true,autoVoiceResponse:true}})
    },join(homedir(),'.athena/models/whisper/ggml-small.bin'))
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=floating'))?.showInactive())
    await expect.poll(()=>control.evaluate(async()=>(await window.athena!.getSnapshot()).handsFreeState?.state),{timeout:45000}).toBe('standby')
  }
  const say=async(text:string)=>{
    const path=join(profile,'fictional-input.wav')
    execFileSync('/usr/bin/say',['-v','Samantha','-r','155','--file-format=WAVE','--data-format=LEI16@16000','-o',path,text])
    await floating.evaluate(wav=>window.syntheticMemoryInput.speak(wav),(await readFile(path)).toString('base64'))
  }
  const memory=()=>control.evaluate(async()=>(await window.athena!.liveVoice({action:'memory',operation:'inspect'})).memory!)
  const connections=()=>floating.evaluate(()=>window.syntheticMemoryInput.started)
  const expectRecall=async(prior:Set<string>)=>{
    await expect.poll(async()=>(await memory()).recent.some(e=>e.role==='assistant' && !prior.has(e.id) && /blue moon/i.test(e.text)),{timeout:13500,intervals:[400]}).toBe(true)
  }
  try{
    await launch()
    await control.evaluate(()=>window.athena!.liveVoice({action:'memory',operation:'new'}))
    const original=await memory()
    await say('Hey Athena, I am building a music app called Blue Moon.')
    await expect.poll(connections,{timeout:25000}).toBe(1)
    await expect.poll(async()=>(await memory()).recent.some(e=>e.role==='user' && /blue moon/i.test(e.text))).toBe(true)
    const initial=await memory()
    await say('What did I tell you I was building? Please say the name.')
    await expect.poll(async()=>(await memory()).recent.some(e=>e.role==='user' && /tell you|building/i.test(e.text) && !/blue moon/i.test(e.text)),{timeout:12000}).toBe(true)
    await expectRecall(new Set(initial.recent.map(e=>e.id)))
    console.info('Confirmed immediate recall through spoken input and recorded spoken reply')
    const beforeDrop=await memory()
    await floating.evaluate(()=>window.syntheticMemoryInput.drop())
    await expect.poll(connections,{timeout:20000}).toBe(2)
    await say('What was the project name we discussed?')
    await expectRecall(new Set(beforeDrop.recent.map(e=>e.id)))
    expect((await memory()).id).toBe(original.id)
    console.info('Confirmed fresh WebRTC connection retained the logical conversation and recalled the project')
    await expect.poll(()=>control.evaluate(async()=>(await window.athena!.liveVoice({action:'status'})).active),{timeout:35000}).toBe(false)
    const saved=await memory()
    expect(saved.persistent).toBe(true)
    const inactiveSince=Date.now()
    await new Promise(resolve=>setTimeout(resolve,120_000))
    await app!.close()
    await launch()
    expect((await memory()).id).toBe(original.id)
    await say('Hey Athena.')
    await expect.poll(connections,{timeout:25000}).toBe(1)
    await say('What was the name of the project I told you about?')
    await expectRecall(new Set(saved.recent.map(e=>e.id)))
    expect((await memory()).recent.filter(e=>e.role==='user' && /blue moon/i.test(e.text))).toHaveLength(1)
    console.info('Confirmed recall after idle shutdown and signed app restart', {idleSeconds:Math.floor((Date.now()-inactiveSince)/1000)})
    const beforeCount=await floating.evaluate(()=>window.syntheticMemoryInput.outputs)
    const beforeInterrupt=await memory()
    await say('Please slowly count from one to thirty while I think about my project.')
    await expect.poll(()=>floating.evaluate(()=>window.syntheticMemoryInput.outputs),{timeout:9000,intervals:[100]}).toBeGreaterThan(beforeCount+1)
    await say('Wait, stop counting. What was my project name again?')
    await expectRecall(new Set(beforeInterrupt.recent.map(e=>e.id)))
    expect(await floating.evaluate(()=>window.syntheticMemoryInput.bargeIns)).toBeGreaterThan(0)
    expect((await memory()).recent.some(e=>e.role==='assistant' && !beforeInterrupt.recent.some(old=>old.id===e.id) && /twenty.nine|twenty nine|29,? 30/i.test(e.text))).toBe(false)
    console.info('Confirmed interruption muted real playout and the follow-up recalled the project')
    await expect.poll(()=>control.evaluate(async()=>(await window.athena!.liveVoice({action:'status'})).active),{timeout:35000}).toBe(false)
    const separate=await control.evaluate(async()=>(await window.athena!.liveVoice({action:'memory',operation:'new'})).memory!)
    expect(separate.id).not.toBe(original.id)
    expect(separate.recent).toEqual([])
    expect(separate.summary).toEqual([])
    const usage=await control.evaluate(()=>window.athena!.liveVoice({action:'status'}))
    if(0.18-(usage.monthly??0)>=0.022){
      const count=await connections()
      await say('Hey Athena.')
      await expect.poll(connections,{timeout:23000}).toBe(count+1)
      expect(await floating.evaluate(()=>window.syntheticMemoryInput.seededName)).toBe(false)
      await say('Do you know the name of my fictional project? If I have not told you, say so.')
      await expect.poll(async()=>(await memory()).recent.some(e=>e.role==='assistant' && /name|told|know|shared|project|mentioned|yet/i.test(e.text)),{timeout:13000}).toBe(true)
      expect((await memory()).recent.some(e=>/blue moon/i.test(e.text))).toBe(false)
      console.info('Confirmed isolated spoken conversation had no previous project in its seed or reply')
    }
    passed=true
  }finally{
    if(app && control && !control.isClosed()){
      const evidence=await control.evaluate(async()=>{
        const live=await window.athena!.liveVoice({action:'status'}),memory=(await window.athena!.liveVoice({action:'memory',operation:'inspect'})).memory!
        const {handsFreeState}=await window.athena!.getSnapshot()
        return {estimatedUSD:live.monthly,active:live.active,state:handsFreeState?.state,status:handsFreeState?.message,roles:memory.recent.map(e=>({role:e.role,partial:e.partial,hasName:/blue moon/i.test(e.text)}))}
      }).catch(()=>undefined)
      console.info('Disposable profile evidence',evidence)
      if(!passed && floating && !floating.isClosed())console.info('Live timing evidence',JSON.stringify(await floating.evaluate(()=>window.syntheticMemoryInput?.timeline.slice(0,90))))
      await app.close()
    }
  }
})
