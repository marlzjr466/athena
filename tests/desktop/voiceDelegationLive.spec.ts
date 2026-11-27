import { _electron as electron, expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { LivePeer } from '../../src/services/speech/livePeer'
import { liveVoiceDefaults } from '../../shared/liveVoice'

test.use({trace:'off'})

for(const interrupt of [false,true])test(interrupt?'synthetic stop clicking interrupts a pending floating voice instruction':'synthetic speech delegates one status check to the packaged floating registry', async () => {
  test.skip((interrupt?process.env.ATHENA_PAID_VOICE_INTERRUPT_TEST:process.env.ATHENA_PAID_VOICE_STATUS_TEST) !== 'authorized', 'Requires express authorization for one billable synthetic session')
  test.setTimeout(90000)
  const profile = await mkdtemp(join(tmpdir(),'athena-synthetic-live-'))
  const wav = join(profile,'input.wav')
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    execFileSync('/usr/bin/say',['-v','Samantha','--file-format=WAVE','--data-format=LEI16@16000','-o',wav,'Athena, check my current task status.'])
    const phrase=(await readFile(wav)).toString('base64')
    let stopPhrase=''
    if(interrupt){
      const stopFile=join(profile,'interrupt.wav')
      execFileSync('/usr/bin/say',['-v','Samantha','--file-format=WAVE','--data-format=LEI16@16000','-o',stopFile,'Stop clicking.'])
      stopPhrase=(await readFile(stopFile)).toString('base64')
    }
    const settings={...liveVoiceDefaults,cloudAllowed:true,maxSeconds:40,idleSeconds:30,monthlyUSD:0.1}
    await writeFile(join(profile,'settings.json'),JSON.stringify({floatingEnabled:false,randomActions:false,randomMovement:false,voiceEnabled:true,voiceMuted:false,liveVoice:settings,automationPermissions:{conversationManagement:true}}))
    app=await electron.launch({executablePath:process.env.ATHENA_VOICE_TEST_BINARY ?? resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena'),
      args:['--use-fake-device-for-media-stream','--mute-audio','--autoplay-policy=no-user-gesture-required','--user-data-dir='+profile]})
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app!.windows().filter(p=>/surface=(floating|control)/.test(p.url())).length).toBe(2)
    const control=app.windows().find(p=>p.url().includes('surface=control'))!
    const floating=app.windows().find(p=>p.url().includes('surface=floating'))!
    const credential=await control.evaluate(()=>window.athena!.liveVoice({action:'status'}))
    expect(credential.credential,'No verified key available to this signed Athena copy').toBe(true)
    await control.evaluate(async whisper=>{
      const {settings}=await window.athena!.getSnapshot()
      await window.athena!.setPermissionEnabled({permission:'microphone',enabled:true})
      await window.athena!.updateSettings({localAI:{...settings.localAI,speechEngine:'whisper-cli',speechModelPath:whisper},floatingEnabled:true,
        voiceInteraction:{...settings.voiceInteraction,handsFreeEnabled:true,autoVoiceResponse:true}})
    },join(homedir(),'.athena/models/whisper/ggml-small.bin'))
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=floating'))?.showInactive())
    await expect.poll(()=>control.evaluate(async()=>(await window.athena!.getSnapshot()).visible)).toBe(true)
    console.info('Voice test prerequisites',await control.evaluate(async()=>{const api=window.athena!,{settings,visible}=await api.getSnapshot();return {visible,cloud:settings.liveVoice.cloudAllowed,engine:settings.liveVoice.engine,enabled:settings.voiceEnabled,muted:settings.voiceMuted,doNotDisturb:settings.doNotDisturb,offline:settings.strictOffline,autoReply:settings.voiceInteraction.autoVoiceResponse,outputHeld:(await api.audioDevices({action:'get'})).outputHeld}}))
    const bundled=await build({entryPoints:['src/services/speech/livePeer.ts'],bundle:true,platform:'browser',format:'iife',globalName:'TestVoice',footer:{js:'globalThis.TestVoice=TestVoice;'},write:false,define:{'import.meta.env.DEV':'false'}})
    await floating.evaluate(source=>(0,eval)(source),bundled.outputFiles[0].text)
    const result=await floating.evaluate(async({phrase,settings,stopPhrase})=>{
      const api=window.athena!
      const lease=await api.enableHandsFree((await api.getChat()).sessionId)
      if(!lease.ok)throw new Error(lease.message)
      const ctx=new AudioContext(), mic=ctx.createMediaStreamDestination(), voice=ctx.createBufferSource()
      voice.buffer=await ctx.decodeAudioData(Uint8Array.from(atob(phrase),c=>c.charCodeAt(0)).buffer);voice.connect(mic)
      await ctx.resume()
      let submitted=0,verified=false,voiceStarted=false,finished='',cancelled=0,stopSent=0,cancelAt=0,stopLength=0
      const pending=new AbortController()
      const stopAudio=ctx.createBufferSource()
      if(stopPhrase){
        stopAudio.buffer=await ctx.decodeAudioData(Uint8Array.from(atob(stopPhrase),c=>c.charCodeAt(0)).buffer)
        stopLength=stopAudio.buffer.duration*1000
        stopAudio.connect(mic)
      }
      const peer=new (window as unknown as {TestVoice:{LivePeer:typeof LivePeer}}).TestVoice.LivePeer({
        mode:'floating',settings,stream:mic.stream,volume:1,
        state:state=>{if(state==='listening'&&!voiceStarted){voiceStarted=true;voice.start(ctx.currentTime+1.2)}},
        cancelWork:async()=>{cancelled++;cancelAt=performance.now();pending.abort();await api.cancelHandsFreeReply(true)},
        delegate:async (text,id)=>{
          if(submitted || !/^(?:hey )?(?:athena[, ]+)?(?:please )?check my current task status[.!? ]*$/i.test(text.trim()))return 'No action was requested by this test.'
          submitted++
          const action=await api.answerHandsFree({id,text,ownership:lease.ownership})
          verified=action.ok && /active conversation is idle/i.test(action.text??'')
          if(stopPhrase && verified){
            // Keep a cancellable follow-up pending after the real read-only status action.
            // The test never clicks a personal application.
            stopSent=performance.now()+250
            stopAudio.start(ctx.currentTime+0.25)
            await new Promise<void>(resolve=>{const deadline=setTimeout(resolve,11000);pending.signal.addEventListener('abort',()=>{clearTimeout(deadline);resolve()},{once:true})})
          }
          return action.text ?? action.message ?? 'No result.'
        },ended:reason=>{finished=reason}
      })
      try {
        await peer.start()
        const limit=performance.now()+23000
        while(performance.now()<limit && !(stopPhrase?cancelled>0:verified) && !finished) await new Promise(resolve=>setTimeout(resolve,100))
        await new Promise(resolve=>setTimeout(resolve,1800))
        return {submitted,verified,voiceStarted,finished,cancelled,stopToCancellationMs:stopSent&&cancelAt?Math.round(cancelAt-stopSent):null,phraseDurationMs:Math.round(stopLength),metrics:{...peer.metrics}}
      } finally {peer.close();mic.stream.getTracks().forEach(t=>t.stop());await ctx.close();await api.liveVoice({action:'stop',request:peer.request})}
    },{phrase,settings,stopPhrase})
    console.info('Paid synthetic status test',JSON.stringify(result))
    expect(result).toMatchObject({submitted:1,verified:true,voiceStarted:true,...(interrupt?{cancelled:1}:{})})
  } finally {
    await app?.close()
    try {
      const rows=JSON.parse(await readFile(join(profile,'live-voice-usage.json'),'utf8'))
      console.info('Disposable test usage',JSON.stringify(rows,(key,value)=>['request','id'].includes(key)?undefined:value))
    } catch { /* No session was created. */ }
    await rm(profile,{recursive:true,force:true})
  }
})
