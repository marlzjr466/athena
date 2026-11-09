import type { MeetingAPI, MeetingSource } from '../../../shared/meetings'
export function pcmWav(pcm: Float32Array, rate: number): Uint8Array<ArrayBuffer> {
  const count = Math.floor(pcm.length * 16000/rate), bytes = new Uint8Array(44+count*2), v=new DataView(bytes.buffer)
  const label=(at:number,s:string)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i))}
  label(0,'RIFF');v.setUint32(4,bytes.length-8,true);label(8,'WAVE');label(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);label(36,'data');v.setUint32(40,count*2,true)
  for(let i=0;i<count;i++){const lo=Math.floor(i*rate/16000),hi=Math.max(lo+1,Math.floor((i+1)*rate/16000));let sum=0;for(let j=lo;j<hi&&j<pcm.length;j++)sum+=pcm[j];v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,sum/(hi-lo)))*32767),true)}return bytes
}
export class MeetingCapture {
  private stream?: MediaStream; private context?: AudioContext; private node?: AudioWorkletNode; private stopped=false; private started=0; private pending=0; private lastFrame=0; private monitor?: ReturnType<typeof setInterval>; private queue=Promise.resolve(); private captureId=crypto.randomUUID(); private segmentId=crypto.randomUUID(); private registered=false; private finishStarted=false; private flushReceived?:()=>void
  constructor(private api:MeetingAPI, private source:MeetingSource, private sessionId:string, private level:(n:number)=>void, private error:(s:string)=>void) {}
  async start(deviceId:string, partial=false) {
    try {
      const grant=await this.api.command({action:'capture-state',sessionId:this.sessionId,captureId:this.captureId,source:this.source,active:true}); if(!grant.ok)throw new Error(grant.message||'Capture not authorized'); this.registered=true; if(this.stopped){this.finish();return}
      const stream=this.source==='microphone' ? await navigator.mediaDevices.getUserMedia({audio:{deviceId:deviceId==='default'?undefined:{exact:deviceId},echoCancellation:true,noiseSuppression:true,channelCount:1},video:false}) : await navigator.mediaDevices.getDisplayMedia({audio:true,video:{width:1,height:1,frameRate:1}})
      this.stream=stream
      if(this.stopped){stream.getTracks().forEach(t=>t.stop());return}
      if(!stream.getAudioTracks().some(track=>track.readyState==='live')) throw new Error('No system audio track. Check OS permissions and select a supported display. Headphone audio requires system capture.')
      for(const t of stream.getAudioTracks()) t.onended=()=>{if(!this.stopped)this.fail('Audio device disconnected or capture ended. Re-enable the source to reconnect.')}
      // The required video track is never rendered, sampled or retained.
      const ctx=new AudioContext({sampleRate:16000}); this.context=ctx
      await ctx.audioWorklet.addModule(new URL('meeting-audio-worklet.js',window.location.href).href)
      if(this.stopped){await ctx.close();return}
      const node=new AudioWorkletNode(ctx,'meeting-pcm',{processorOptions:{partial}});this.node=node
      this.started=Date.now();this.lastFrame=Date.now()
      node.port.onmessage=event=>{
        if(event.data.flushed){this.flushReceived?.();return}
        if(event.data.level!==undefined){this.lastFrame=Date.now();this.level(Math.min(1,event.data.level*8));return}
        const pcm=event.data.pcm as Float32Array, rate=event.data.rate as number
        const provisional=event.data.partial===true
        const start=this.started, end=start+pcm.length/rate*1000; if(!provisional)this.started=end
        const id=this.segmentId,bytes=pcmWav(pcm,rate);if(!provisional)this.segmentId=crypto.randomUUID();this.pending++
        if(this.pending>8){this.fail('Audio storage is falling behind. Capture stopped; pending chunks will be saved.');}
        this.queue=this.queue.then(async()=>{let result=await this.api.command({action:'audio',partial:provisional,sessionId:this.sessionId,id,source:this.source,start,end,bytes});if(!result.ok){await new Promise(r=>setTimeout(r,500));result=await this.api.command({action:'audio',partial:provisional,sessionId:this.sessionId,id,source:this.source,start,end,bytes})}if(!result.ok)this.fail(`Audio storage failed: ${result.message}. This chunk could not be saved.`);this.pending--}).catch(e=>this.fail(String(e)))
      }
      ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(node)
      const mute=ctx.createGain();mute.gain.value=0;node.connect(mute);mute.connect(ctx.destination);await ctx.resume()
      this.monitor=setInterval(()=>{if(Date.now()-this.lastFrame>12000)this.fail('No audio frames received. Check System Audio Recording permission and re-enable this source.')},5000)
    } catch(e){this.fail(e instanceof Error?e.message:'Audio capture failed')}
  }
  private fail(message:string){if(this.stopped)return;this.error(message);void this.api.command({action:'source-error',sessionId:this.sessionId,source:this.source,message:message.slice(0,500)});this.stop()}
  private finish(){if(this.finishStarted||!this.registered)return;this.finishStarted=true;void this.queue.finally(()=>this.api.command({action:'capture-state',sessionId:this.sessionId,captureId:this.captureId,source:this.source,active:false})).catch(()=>{})}
  stop(){
    if(this.stopped)return;this.stopped=true;clearInterval(this.monitor)
    const flushed=new Promise<void>(resolve=>{this.flushReceived=resolve;if(!this.node)resolve();else {this.node.port.postMessage('flush');setTimeout(resolve,1500)}})
    this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop()})
    void flushed.then(async()=>{await this.context?.close();this.level(0);this.finish()})
  }
}
