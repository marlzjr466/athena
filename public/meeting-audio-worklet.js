/* Six-second PCM frames; no audio is routed to the speakers. */
class MeetingPCM extends AudioWorkletProcessor {
  constructor(options) { super(); this.partial = options.processorOptions?.partial === true; this.samples = new Float32Array(sampleRate * 6); this.size = 0; this.ticks = 0; this.port.onmessage = () => { this.flush(); this.port.postMessage({flushed:true}); }; }
  flush() { if (!this.size) return; const pcm = this.samples.slice(0,this.size); this.port.postMessage({pcm,rate:sampleRate},[pcm.buffer]); this.size=0; }
  process(inputs) {
    const channels=inputs[0]; if(!channels?.length) return true;
    const n=channels[0].length; let energy=0;
    for(let i=0;i<n;i++) { let value=0; for(const ch of channels) value += ch[i]/channels.length; this.samples[this.size++]=value; energy+=value*value; if(this.partial && this.size===sampleRate*3){const pcm=this.samples.slice(0,this.size);this.port.postMessage({pcm,rate:sampleRate,partial:true},[pcm.buffer]);} if(this.size===this.samples.length) this.flush(); }
    if(++this.ticks%32===0) this.port.postMessage({level:Math.sqrt(energy/n)});
    return true;
  }
}
registerProcessor('meeting-pcm',MeetingPCM);
