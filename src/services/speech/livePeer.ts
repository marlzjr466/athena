import { LiveHistory } from './liveHistory'
import type { VoiceEntry } from '../../../shared/liveVoice'
import type { ServerEvent } from 'openai/resources/live/live'
import { sampleLines, type LiveVoiceSettings } from '../../../shared/liveVoice'
import { desktop } from '../desktop'
import { routeSpeech } from './audioDevices'
import { audioRms, speechLevel } from './playbackAmplitude'

type Phase = 'connecting' | 'listening' | 'speaking' | 'working'
interface Options {
  mode: 'floating' | 'preview' | 'test'
  settings:LiveVoiceSettings
  stream?: MediaStream
  initial?:string
  language?:keyof typeof sampleLines
  volume:number
  voice?:string
  state(phase:Phase,message?:string):void
  amplitude?(level:number):void
  delegate?(text:string, requestId:string):Promise<string>
  cancelWork?():Promise<void>
  pauseWork?(paused:boolean):Promise<boolean>
  ended(reason:string):void
}
export function isLiveGoodbye(text:string) {
  return /^(?:hey\s+)?(?:athena[, ]+)?(?:goodbye|bye|stop listening|go to standby|tama na|paalam)(?:[, ]+athena)?[.!?\s]*$/i.test(text.trim())
}
export class LiveTranscript {
  private fragments:Array<{start:number;end:number;text:string}>=[]
  private through=-1
  private boundaries:Promise<unknown>=Promise.resolve()
  private changed?:(start:number)=>void
  constructor(private initial='') {}
  append(start:number,end:number,text:string) {
    if (!Number.isFinite(start)||!Number.isFinite(end)||end<start||start<this.through||end<=this.through)return
    this.fragments.push({start,end,text:text.slice(0,3000)})
    // The Live protocol defines transcript text in delivery order. Time ranges
    // may overlap and are for delegation boundaries, not sorting words.
    this.fragments=this.fragments.slice(-250)
    this.changed?.(start)
  }
  retire(offset:number) {
    if (!Number.isFinite(offset) || offset <= this.through) return
    this.initial = ''
    this.through = offset
    this.fragments = this.fragments.filter(f => f.start >= offset)
  }
  latest() {
    const last=this.fragments.at(-1)
    if(!last)return ''
    let first=this.fragments.length-1
    while(first>0 && this.fragments[first].start-this.fragments[first-1].end<1500)first--
    return this.fragments.slice(first).map(f=>f.text).join('').trim()
  }
  /** Input transcript deltas have no "done" event. Let in-range fragments settle
   * even when a prefix arrived before the model delegated; consuming it eagerly
   * would retire the rest of the instruction. Resolve boundaries in arrival order. */
  collect(offset:number):Promise<string> {
    const next=this.boundaries.then(()=>{
      if(!Number.isFinite(offset) || offset<=this.through)return ''
      return new Promise<string>(resolve=>{
        let quiet:ReturnType<typeof setTimeout>|undefined
        const finish=(settled:boolean)=>{
          clearTimeout(quiet);clearTimeout(deadline);this.changed=undefined
          const text=settled?this.take(offset):''
          this.retire(offset)
          resolve(text)
        }
        const deadline=setTimeout(()=>finish(false),1800)
        this.changed=(start:number)=>{
          if(start>offset)return
          clearTimeout(quiet)
          quiet=setTimeout(()=>finish(true),350)
        }
        if(this.initial || this.fragments.some(f=>f.start<=offset))this.changed(offset)
      })
    })
    this.boundaries=next
    return next
  }
  take(offset:number) {
    if(!Number.isFinite(offset)||offset<=this.through)return ''
    if (this.fragments.some(f => f.start < offset && f.end > offset)) return ''
    const current=this.fragments.filter(f=>f.end<=offset)
    let first=current.length-1
    while(first>0 && current[first].start-current[first-1].end<1500)first--
    const text=current.length ? current.slice(first).map(f=>f.text).join('').trim() : this.initial.trim()
    if (!text) return ''
    this.retire(offset)
    return text.length<=12000?text:''
  }
}
export class LivePeer {
  readonly request=crypto.randomUUID()
  readonly metrics={started:performance.now(),connectedMs:0,firstAudioMs:0,delegations:0,receivedPackets:0,outputFragments:0}
  private pc=new RTCPeerConnection()
  private channel=this.pc.createDataChannel('oai-events')
  private player=new Audio()
  private context?:AudioContext
  private output?:()=>void
  private track?:MediaStreamTrack
  private sender?:RTCRtpSender
  private inputLane:Promise<void>=Promise.resolve()
  private silentSource?:ConstantSourceNode
  private events=new Set<string>()
  private tasks=new Map<string,string>()
  private transcript:LiveTranscript
  private timer?:ReturnType<typeof setInterval>
  private meter?:ReturnType<typeof setInterval>
  private done=false
  private closing=false
  private started=false
  private latestWarning=0
  private controlTimer?:ReturnType<typeof setTimeout>
  private stoppedThrough=-1
  private taskGeneration=0
  private pending=0
  private progress?:{request:string;delegation:string;engine?:string}
  private queue:Promise<void>=Promise.resolve()
  private history?:LiveHistory
  private timeline=0
  private checkpointLane:Promise<void>=Promise.resolve()
  private memoryFailed=false
  private interrupted=false
  private speaking=false
  private touched=Date.now()
  private sounded=0
  private expires=0
  private disconnected=0
  private closingTimer?:ReturnType<typeof setTimeout>
  private reason='Voice session ended.'
  constructor(private options:Options) {
    this.transcript=new LiveTranscript(options.initial)
    this.channel.onmessage=event=>{try{void this.receive(JSON.parse(event.data)).catch(()=>this.close('Could not process a Live event.'))}catch{this.close('Invalid Live event.')}}
    this.channel.onclose=()=>{if(!this.closing)this.reason='The Live connection was interrupted.';this.finish()}
    this.pc.ontrack=event=>{if(event.track.kind==='audio')void this.play(event.track).catch(()=>this.close('Unable to play GPT-Live on the selected speaker.'))}
    this.pc.onconnectionstatechange=()=>{
      if(this.pc.connectionState==='failed')this.close('WebRTC connection failed.')
      this.disconnected=this.pc.connectionState==='disconnected'?Date.now():0
    }
  }
  activity(){this.touched=Date.now()}
  private send(event:object){if(this.channel.readyState==='open')this.channel.send(JSON.stringify(event))}
  async start() {
    try {
      this.options.state('connecting')
      this.context=new AudioContext()
      this.output=await routeSpeech(this.player,reason=>this.close(reason))
      if(this.closing||this.done){this.output();return}
      this.player.volume=this.options.volume
      // A voiced preview sends digital silence. It never opens a microphone.
      let track:MediaStreamTrack|undefined
      if(this.options.mode==='preview'){
        const destination=this.context.createMediaStreamDestination()
        this.silentSource=this.context.createConstantSource()
        this.silentSource.offset.value=0
        this.silentSource.connect(destination)
        this.silentSource.start()
        track=destination.stream.getAudioTracks()[0]
      }else track=this.options.stream?.getAudioTracks()[0]?.clone()
      if(!track || track.readyState!=='live')throw new Error('The selected microphone is unavailable.')
      this.track=track; this.sender=this.pc.addTrack(track,new MediaStream([track]))
      await this.context.resume()
      await this.pc.setLocalDescription(await this.pc.createOffer())
      if(this.pc.iceGatheringState!=='complete')await new Promise<void>((resolve,reject)=>{
        const stop=()=>{clearTimeout(timeout);this.pc.removeEventListener('icegatheringstatechange',check)}
        const check=()=>{if(this.pc.iceGatheringState==='complete'){stop();resolve()}}
        const timeout=setTimeout(()=>{stop();reject(new Error('WebRTC network discovery timed out.'))},10000)
        this.pc.addEventListener('icegatheringstatechange',check);check()
      })
      if(this.closing||this.done)return
      const result=await desktop.liveVoice({action:'start',request:this.request,mode:this.options.mode,sdp:this.pc.localDescription!.sdp,language:this.options.language,initial:this.options.initial,voice:this.options.voice})
      if(!result.sdp||!result.expiresAt)throw new Error(result.message||'OpenAI returned no SDP answer.')
      if(this.done || this.closing){await desktop.liveVoice({action:'stop',request:this.request});return}
      if(result.conversationId && this.options.mode==='floating')this.history=new LiveHistory()
      this.expires=result.expiresAt
      await this.pc.setRemoteDescription({type:'answer',sdp:result.sdp})
      this.activity()
      let statsReadAt=0
      this.timer=setInterval(()=>{
        const now=Date.now()
        this.checkpoint()
        if(now-statsReadAt>2000 && this.pc.connectionState==='connected'){
          statsReadAt=now
          void this.pc.getStats().then(rows=>rows.forEach(stat=>{
            if(stat.type==='inbound-rtp' && stat.kind==='audio')this.metrics.receivedPackets=stat.packetsReceived
          })).catch(()=>{})
        }
        if(this.disconnected && now-this.disconnected>4000)this.close('The voice connection was interrupted.')
        else if(now>=this.expires)this.close('Session time or budget limit reached.')
        else if(!this.started && now-this.touched>12000)this.close('OpenAI did not start the WebRTC session.')
        else if(!this.pending && now-this.touched>=this.options.settings.idleSeconds*1000)this.close('Returned to local wake-word listening.')
        else if(this.options.mode==='preview' && this.sounded && now-this.sounded>1900)this.close('Voice preview finished.')
      },250)
      if(result.message)this.options.state('connecting',result.message)
    } catch(error) {this.reason=error instanceof Error?error.message:'GPT-Live could not connect.';this.finish();throw error}
  }
  private offset(){return Math.max(0,performance.now()-this.timeline)}
  interruptSpeech(){
    this.activity()
    if(this.started && this.options.settings.fullDuplex && !this.interrupted && this.speaking){
      this.interrupted=true;this.history?.interrupt(this.offset());this.player.muted=true
    }
  }
  resumeListening(){
    if(!this.closing && !this.done && this.interrupted){this.interrupted=false;this.history?.resume(this.offset());this.player.muted=false}
  }
  private checkpoint(closing=false,extra?:VoiceEntry){
    if(!this.history || !this.started)return
    const entries=this.history.drain(this.offset(),closing)
    if(extra)entries.push(extra)
    if(!entries.length)return
    this.checkpointLane=this.checkpointLane.then(async()=>{
      const reply=await desktop.liveVoice({action:'checkpoint',request:this.request,entries})
      if(reply.endConversation)this.close(reply.message??'New voice conversation ready. Wake Athena to continue.')
    }).catch(()=>{
      this.memoryFailed=true
      if(!this.done)this.options.state('listening','Conversation history could not be saved.')
    })
  }
  private async play(track:MediaStreamTrack) {
    if(this.done||this.closing)return
    const stream=new MediaStream([track])
    this.player.srcObject=stream
    const ctx=this.context!
    // Meter the received track without connecting a second copy to the speakers.
    const source=ctx.createMediaStreamSource(stream), analyser=ctx.createAnalyser()
    analyser.fftSize=512;source.connect(analyser)
    const samples=new Uint8Array(analyser.fftSize)
    await this.player.play()
    if(this.done||this.closing)return
    this.meter=setInterval(()=>{
      analyser.getByteTimeDomainData(samples)
      const level=this.player.muted||this.player.paused ? 0 : speechLevel(audioRms(samples))*this.player.volume
      this.options.amplitude?.(level)
      if(level>0.015){
        if(this.started)this.history?.sample(this.offset());
        this.sounded=Date.now();this.activity()
        if(!this.metrics.firstAudioMs)this.metrics.firstAudioMs=Math.round(performance.now()-this.metrics.started)
      }
      const speaking=this.sounded>0 && Date.now()-this.sounded<160
      if(this.speaking!==speaking){
        this.speaking=speaking
        if(this.track&&!this.options.settings.fullDuplex)this.track.enabled=!speaking
        this.options.state(speaking?'speaking':this.pending?'working':'listening')
      }
    },40)
  }
  private async receive(event:ServerEvent) {
    if(this.done || !event || typeof event!=='object')return
    if(event.type==='session.closed'){
      if(!this.closing)this.reason='OpenAI closed the session ('+event.reason+').'
      this.finish(event.usage?.seconds);return
    }
    if(this.closing||!("event_id" in event)||this.events.has(event.event_id))return
    this.events.add(event.event_id)
    if(event.type==='session.started'){this.timeline=performance.now();this.started=true;this.activity();this.metrics.connectedMs=Math.round(performance.now()-this.metrics.started);this.options.state('listening')
      if(this.options.mode==='preview')this.send({type:'session.commentary.append',delegation_id:null,content:sampleLines[this.options.language??'English']})
      return}
    if(event.type==='error'){
      const code=event.error?.code
      this.close('OpenAI reported a Live session error'+(code && /^[a-z_]{1,64}$/.test(code)?' ('+code+')':'')+'.');return
    }
    if(event.type==='session.output_transcript.delta'){this.metrics.outputFragments++;this.history?.add('assistant',event.start_ms,event.end_ms,event.delta,this.offset());return}
    if(event.type==='session.usage.updated'){
      const {threshold}=await desktop.liveVoice({action:'usage',request:this.request,seconds:event.usage.seconds})
      if(threshold && threshold>this.latestWarning && !this.done){
        this.latestWarning=threshold
        this.options.state(this.speaking?'speaking':'listening',threshold+'% of your monthly voice budget used.')
      }
      return
    }
    if(event.type==='session.input_transcript.delta'){
      this.history?.add('user',event.start_ms,event.end_ms,event.delta,this.offset());
      this.activity();this.transcript.append(event.start_ms,event.end_ms,event.delta)
      const utterance=this.transcript.latest()
      clearTimeout(this.controlTimer)
      if(isLiveGoodbye(utterance)){
        // Live can deliver "stop listening" as the prefix of a longer request.
        this.controlTimer=setTimeout(()=>{
          if(!this.closing && !this.done && this.transcript.latest()===utterance)this.close('Returned to local wake-word listening.')
        },300)
        return
      }
      if (this.pending && this.options.cancelWork && /^(?:please )?(?:stop clicking|stop what (?:you are|you're|you’re) doing|cancel (?:this|the current) automation)[.!?]?$/i.test(utterance)) {
        this.controlTimer=setTimeout(()=>{
          if (!this.pending || this.closing || this.done || this.transcript.latest()!==utterance) return
          this.stoppedThrough=event.end_ms
          this.stopAutomation()
          void this.options.cancelWork?.().catch(()=>{})
        },180)
      }
      return
    }
    if(event.type!=='session.delegation.created'||event.delegation.target!=='client'||this.tasks.has(event.delegation.id))return
    const id=event.delegation.id
    const requestId=crypto.randomUUID()
    this.tasks.set(id,requestId)
    const epoch=this.taskGeneration
    this.activity()
    const text=this.options.delegate ? await this.transcript.collect(event.offset_ms) : ''
    if (this.done || this.closing || epoch!==this.taskGeneration) return
    clearTimeout(this.controlTimer)
    const stop = /^(?:please )?(?:stop(?: clicking| what you(?:'re| are) doing)?|cancel|pause|wait)(?: (?:the |my )?(?:current )?(?:task|automation))?[.!]?$/i.test(text) || /^wait[, ]+(?:do not|don't|don’t) send (?:it|that)(?: yet)?[.!]?$/i.test(text)
    const correction = /^actually[, ]+(?:please )?(.+?) instead[.!]?$/i.exec(text)
    const hold=/^(?:please )?(?:wait|pause)(?: (?:this |the )?(?:automation|task))?[.!]?$/i.test(text) || /^wait[, ]+(?:do not|don't|don’t) send (?:it|that)(?: yet)?[.!]?$/i.test(text)
    const resume=/^(?:please )?(?:continue|resume)(?: (?:the |my )?(?:task|automation))?[.!]?$/i.test(text)
    if((hold || resume) && this.options.pauseWork){
      const active=await this.options.pauseWork(hold)
      if(active || /\b(?:task|automation)\b/i.test(text) || /^wait\b/i.test(text)){
        this.send({type:'session.commentary.append',delegation_id:id,content:active?(hold?'Paused before the next action. A step already submitted may finish.':'Continuing the active task.'):'There is no active automation to pause or continue.'})
        return
      }
      // With no active task, “pause”/“resume” may target the current media.
      // Let the native executor resolve the freshly observed application.
    }
    if(stop && !hold && this.stoppedThrough>=0 && event.offset_ms >= this.stoppedThrough && event.offset_ms-this.stoppedThrough<1000) {
      this.stoppedThrough=-1
      this.send({type:'session.commentary.append',delegation_id:id,content:'Stopped pending automation. Already submitted actions may have finished.'})
      return
    }
    if(this.pending && this.options.cancelWork && (stop || correction)){
      this.taskGeneration++;await this.options.cancelWork()
      if (stop) {this.send({type:'session.commentary.append',delegation_id:id,content:'Stopped pending steps. An action already submitted may have taken effect.'});return}
    }
    if(!text || !this.options.delegate || this.pending>=3) {
      this.send({type:'session.commentary.append',delegation_id:id,content:this.pending?'The previous task is still running.':'Ask the user to repeat the request. No action was taken.'})
      return
    }
    this.history?.delegated()
    this.pending++;this.metrics.delegations++
    this.send({type:'session.thinking.append',delegation_id:id,content:'Athena is checking the requested action. Completion is pending.'})
    this.options.state('working')
    const delegate=this.options.delegate,generation=this.taskGeneration
    this.queue=this.queue.then(async()=>{
      if(this.done||this.closing||generation!==this.taskGeneration){this.pending--;return}
      let answer:string
      try{
        this.progress={request:requestId,delegation:id}
        answer=await delegate(correction?.[1] ?? text, requestId)
      }catch{answer='The requested operation could not be verified.'}
      finally{if(this.progress?.request===requestId)this.progress=undefined;this.pending--;this.activity()}
      if(!this.closing&&!this.done&&generation===this.taskGeneration)this.send({type:'session.commentary.append',delegation_id:id,content:answer.slice(0,900)})
    })
    await this.queue
  }
  private readonly announced = new Set<string>()
  automationProgress(request:string,engine:string) {
    const progress=this.progress
    if(!progress || progress.request!==request || this.done || this.closing || this.options.mode!=='floating')return
    const first=!progress.engine
    if(!first && progress.engine===engine)return
    progress.engine=engine
    this.send({type:first?'session.commentary.append':'session.thinking.append',delegation_id:progress.delegation,
      content:first?'I’m checking the current state before I take the next step.':'Athena is continuing with the configured fallback and checking completed actions.'})
  }
  submittedTaskEnded(request:string,complete:boolean) {
    if (this.closing || this.done || this.options.mode!=='floating' || this.announced.has(request)) return
    const match = Array.from(this.tasks).find(([,value])=>value===request)
    if (!match) return
    this.announced.add(request)
    this.send({type:'session.commentary.append',delegation_id:match[0],content:complete?'The requested chat task finished. Its reply is in the conversation.':'The requested chat task ended without a completed reply. Check its status in the conversation.'})
  }
  stopAutomation(){
    this.progress=undefined
    for (const id of this.tasks.values()) this.announced.add(id)
    this.taskGeneration++;this.activity()
    if(this.started && !this.closing && !this.done && this.options.mode==='floating')
      this.send({type:'session.instructions.append',delegation_id:null,content:'The user stopped automation. Disregard pending results and wait for a new user instruction.'})
  }
  setVolume(value:number){this.player.volume=value}
  /** Preserve SDP, delegation state and billing session while changing capture. */
  replaceMicrophone(stream:MediaStream):Promise<void> {
    const operation=this.inputLane.then(async()=>{
      if(this.done||this.closing)return
      const source=stream.getAudioTracks()[0]
      if(!source||source.readyState!=='live')throw new Error('The replacement microphone is unavailable.')
      if(!this.sender) return // start() will use the updated source below
      const replacement=source.clone()
      replacement.enabled=this.track?.enabled??true
      try {
        await this.sender.replaceTrack(replacement)
        if(this.done||this.closing){replacement.stop();return}
        this.track?.stop();this.track=replacement
      } catch(error){replacement.stop();throw error}
    })
    this.options.stream=stream
    this.inputLane=operation.catch(()=>{})
    return operation
  }
  private silence() {
    this.silentSource?.stop();this.silentSource?.disconnect();this.silentSource=undefined
    this.track?.stop();this.track=undefined
    this.player.pause();this.player.srcObject=null
    clearInterval(this.meter);this.options.amplitude?.(0)
    clearInterval(this.timer);clearTimeout(this.controlTimer)
  }
  close(reason='Voice session stopped.') {
    if(this.done||this.closing)return
    this.closing=true;this.reason=reason;this.history?.interrupt(this.offset());this.silence()
    if(this.channel.readyState==='open' && this.started){
      this.send({type:'session.close'});this.closingTimer=setTimeout(()=>this.finish(),1800)
    }else this.finish()
  }
  private finish(seconds?:number) {
    if(this.done)return
    this.checkpoint(true);this.done=true;this.taskGeneration++;if(this.pending)void this.options.cancelWork?.().catch(()=>{});this.silence();clearTimeout(this.closingTimer)
    this.output?.();this.pc.close()
    void this.context?.close().catch(()=>{})
    void this.checkpointLane.then(()=>desktop.liveVoice({action:'stop',request:this.request,finalSeconds:seconds})).catch(()=>{}).finally(()=>this.options.ended(this.memoryFailed?this.reason+' Some history could not be saved.':this.reason))
  }
}
