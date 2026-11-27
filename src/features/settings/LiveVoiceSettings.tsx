import { useEffect, useRef, useState } from 'react'
import { Section, SettingRow, SettingsDisclosure, Slider, Toggle } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { useAthena } from '../../store/athenaStore'
import { desktop } from '../../services/desktop'
import { LivePeer } from '../../services/speech/livePeer'
import { MicrophoneSource, onAudioDevices } from '../../services/speech/audioDevices'
import { acousticTraits, BUILTIN_VOICES, initialDesign, sampleLines, designSchema, type LiveReply, type LiveVoiceSettings, type VoiceDesign, type VoiceMemoryView, type LiveCommand } from '../../../shared/liveVoice'

const currency=(value=0)=>'$'+value.toFixed(4)
const options=(values:readonly string[])=>values.map(value=>({value,label:value}))
const message=(error:unknown)=>error instanceof Error?error.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'Voice operation failed.'
export function LiveVoiceSettings() {
  const settings=useAthena(s=>s.snapshot!.settings), update=useAthena(s=>s.update)
  const live=settings.liveVoice
  const [status,setStatus]=useState<LiveReply>({})
  const [notice,setNotice]=useState(''),[working,setWorking]=useState('')
  const [design,setDesign]=useState<VoiceDesign>(live.design)
  const [language,setLanguage]=useState<keyof typeof sampleLines>('English')
  const [library,setLibrary]=useState(''),[rename,setRename]=useState('')
  const peer=useRef<LivePeer|null>(null), source=useRef<MicrophoneSource|null>(null)
  const ownsMic=useRef(false),generation=useRef(0),busy=useRef(false)
  const saved=live.voices.find(v=>v.id===library)
  const change=(patch:Partial<LiveVoiceSettings>)=>update({liveVoice:{...useAthena.getState().snapshot!.settings.liveVoice,...patch}})
  const refresh=async()=>setStatus(await desktop.liveVoice({action:'status'}))
  const release=()=>{
    source.current?.close();source.current=null
    if(ownsMic.current){ownsMic.current=false;void desktop.audioDevices({action:'test-stop'}).catch(()=>{})}
  }
  function stop(){
    generation.current++
    peer.current?.close();peer.current=null;release()
    busy.current=false;setWorking('')
  }
  useEffect(()=>{
    let mounted=true
    const read=()=>void desktop.liveVoice({action:'status'}).then(value=>{if(mounted)setStatus(value)}).catch(error=>{if(mounted)setNotice(message(error))})
    read()
    const timer=setInterval(read,5000)
    const off=onAudioDevices(state=>{if(ownsMic.current&&!state.testActive){stop();setNotice('Microphone test ended.')}})
    const offSpeech=desktop.onLocalVoicePlaybackStopped(()=>{if(peer.current)stop()})
    return ()=>{mounted=false;clearInterval(timer);off();offSpeech();stop()}
  },[])
  useEffect(()=>{
    if(settings.strictOffline || settings.voiceMuted || !settings.voiceEnabled || settings.doNotDisturb || live.engine!=='live')stop()
    else peer.current?.setVolume(settings.voiceVolume)
  },[settings.strictOffline,settings.voiceMuted,settings.voiceEnabled,settings.doNotDisturb,settings.voiceVolume,live.engine])
  async function run(label:string,fn:()=>Promise<void>){
    if(busy.current)return
    busy.current=true;setWorking(label);setNotice('')
    try{await fn()}catch(error){setNotice(message(error))}
    finally{if(!peer.current){release();busy.current=false;setWorking('')}void refresh().catch(()=>{})}
  }
  const start=(mode:'preview'|'test',voice?:string)=>run(mode,async()=>{
    const token=++generation.current
    await desktop.stopAllSpeech()
    await desktop.audioDevices({action:'confirm-output'})
    let stream:MediaStream|undefined
    if(mode==='test'){
      if(settings.voiceInteraction.handsFreeEnabled){setNotice('Say “Hey Athena” to the floating assistant to test the active hands-free microphone.');return}
      await desktop.audioDevices({action:'test-start'})
      ownsMic.current=true
      source.current=new MicrophoneSource(()=>({echoCancellation:true,autoGainControl:true,noiseSuppression:true}),()=>{
        const capture=source.current
        if(!capture)return
        void capture.getStream().then(next=>{if(source.current===capture)return peer.current?.replaceMicrophone(next)}).catch(()=>{setNotice('Microphone unavailable. Reconnect a device to continue.')})
      })
      stream=await source.current.getStream()
    }
    if(token!==generation.current){release();return}
    const connection=new LivePeer({mode,settings:live,volume:settings.voiceVolume,language,stream,voice,
      state:(phase,detail)=>setNotice(detail??({connecting:'Connecting to OpenAI…',speaking:'Playing GPT-Live audio.',listening:'GPT-Live connected.',working:'Processing…'}[phase])),
      ended:reason=>{if(peer.current===connection){peer.current=null;release();busy.current=false;setWorking('');const {connectedMs,firstAudioMs,receivedPackets,outputFragments}=connection.metrics
        setNotice([reason,connectedMs?'Connected in '+connectedMs+' ms.':'',firstAudioMs?'First audible output in '+firstAudioMs+' ms.':connectedMs?'No audible output detected. Received '+receivedPackets+' audio packets and '+outputFragments+' speech updates.':''].filter(Boolean).join(' '));void refresh().catch(()=>{})}}})
    peer.current=connection
    try{await connection.start()}catch(error){peer.current=null;throw error}
  })
  const generate=(regenerate=false)=>run('generation',async()=>{
    const result=await desktop.liveVoice({action:'generate',design:designSchema.parse(design),regenerate})
    if(result.saved){setLibrary(result.saved.id);setRename(result.saved.name)}
    setNotice(result.message??'OpenAI returned no voice.')
  })
  const [memory,setMemory]=useState<VoiceMemoryView>(),[note,setNote]=useState(''),[noteId,setNoteId]=useState('')
  const manage=async(operation:Extract<LiveCommand,{action:'memory'}>['operation'],id?:string,text?:string)=>{
    try{
      const reply=await desktop.liveVoice({action:'memory',operation,id,text})
      setMemory(reply.memory);setNote('');setNoteId('');setNotice('')
    }catch(error){setMemory(undefined);setNotice(message(error))}
  }
  const paidUnavailable=!!working || !status.credential || settings.strictOffline || !settings.voiceEnabled || settings.voiceMuted || settings.doNotDisturb
  return <Section title="GPT-Live 1.1" description="Floating conversations use OpenAI speech-to-speech. Wake-word detection stays on this device.">
    <SettingRow title="Allow cloud voice after wake" description="Sends microphone audio and delegated task results to OpenAI while a voice session is active. API usage is billed."><Toggle label="Allow cloud voice after wake" checked={live.cloudAllowed} onChange={cloudAllowed=>void change({cloudAllowed})}/></SettingRow>
    <SettingRow title="OpenAI API connection" description={status.credential===undefined?'Checking the saved credential…':status.credential?'Using the verified key from AI Settings.':'Connect an OpenAI API key in AI Settings.'}><button className="button secondary" disabled={!!working||settings.strictOffline} onClick={()=>void run('check',async()=>{const r=await desktop.liveVoice({action:'check'});setNotice(r.message??'Connection checked.')})}>Test connection</button></SettingRow>
    <SettingRow title="Speaking voice" description="Voice changes take effect at the next session."><CustomSelect ariaLabel="GPT-Live speaking voice" value={live.voice} options={[...options(BUILTIN_VOICES),...live.voices.map(v=>({value:v.id,label:v.name}))]} onChange={voice=>void change({voice,chosen:true})}/></SettingRow>
    <SettingRow title="Preview language"><CustomSelect ariaLabel="Preview language" value={language} options={options(Object.keys(sampleLines))} onChange={v=>setLanguage(v as typeof language)}/></SettingRow>
    <SettingRow title="Test GPT-Live" description="Previews send silence and play a short sample. Conversation tests use the microphone. Both use the voice budget."><div className="voice-actions"><button className="button secondary" disabled={paidUnavailable} onClick={()=>void start('preview')}>Preview voice</button><button className="button secondary" disabled={paidUnavailable} onClick={()=>void start('test')}>Test voice conversation</button>{(working==='test'||working==='preview')&&<button className="button secondary" onClick={stop}>Stop</button>}</div></SettingRow>
    <SettingRow title="Full-duplex conversation" description="Keep listening during Athena’s spoken reply."><Toggle label="Full-duplex conversation" checked={live.fullDuplex} onChange={fullDuplex=>void change({fullDuplex})}/></SettingRow>
    <SettingRow title="Automatic local fallback"><Toggle label="Automatic local fallback" checked={live.fallback} onChange={fallback=>void change({fallback})}/></SettingRow>
    <SettingRow title="Conversation instructions"><textarea aria-label="Conversation instructions" className="settings-input" defaultValue={live.personality} maxLength={3000} onBlur={e=>void change({personality:e.target.value})}/></SettingRow>
    <SettingsDisclosure title="Voice conversation memory">
      <SettingRow title="Conversation retention" description="Keep recent dialogue and older conversation notes on this device. Athena shares a bounded history with GPT-Live when reconnecting. Saved preferences carry across conversations.">
        <CustomSelect ariaLabel="Voice conversation retention" value={String(live.historyDays)} options={[{value:'0',label:'Until Athena quits'},...([1,7,30] as const).map(d=>({value:String(d),label:d+' days after last activity'}))]} onChange={days=>{setMemory(undefined);void change({historyDays:Number(days) as LiveVoiceSettings['historyDays']})}}/>
      </SettingRow>
      <SettingRow title="Conversation history"><div className="voice-actions"><button className="button secondary" onClick={()=>void manage('inspect')}>Review history</button><button className="button secondary" disabled={status.active} onClick={()=>void manage('new')}>New conversation</button></div></SettingRow>
      {memory&&<>
        <SettingRow title="Saved conversation" description={memory.persistent?'Encrypted on this device.':'Available until Athena quits.'}><CustomSelect ariaLabel="Saved voice conversation" value={memory.id} options={memory.conversations.map((c,i)=>({value:c.id,label:(i+1)+' · '+new Date(c.updated).toLocaleString()}))} onChange={id=>void manage('select',id)}/></SettingRow>
        <div className="card-description">{memory.summary.map((s,i)=><p key={i}>{s}</p>)}{memory.recent.map(e=><p key={e.id}><strong>{e.role==='user'?'You':e.role==='task'?'Task':'Athena'}</strong> {e.text}{e.partial?' (partial)':''}</p>)}</div>
        <SettingRow title="Clear this conversation" description="Removes this conversation’s transcript and summary."><button className="button secondary" disabled={status.active} onClick={()=>{if(window.confirm('Clear this saved voice conversation?'))void manage('clear')}}>Clear conversation</button></SettingRow>
        <SettingRow title="Explicitly saved memories"><CustomSelect ariaLabel="Saved voice memory" value={noteId} options={[{label:'New memory',value:''},...memory.notes.map(n=>({value:n.id,label:n.text}))]} onChange={id=>{setNoteId(id);setNote(memory.notes.find(n=>n.id===id)?.text??'')}}/></SettingRow>
        <SettingRow title="Memory text"><input className="settings-input" aria-label="Memory text" value={note} maxLength={400} onChange={e=>setNote(e.target.value)}/></SettingRow>
        <div className="voice-actions"><button className="button secondary" disabled={status.active||!note.trim()} onClick={()=>void manage(noteId?'edit-note':'save-note',noteId||undefined,note.trim())}>Save memory</button><button className="button secondary" disabled={status.active||!noteId} onClick={()=>void manage('remove-note',noteId)}>Remove memory</button></div>
      </>}
    </SettingsDisclosure>
    <SettingsDisclosure title="Custom Voice Designer">
      <SettingRow title="Adult voice profile"><CustomSelect ariaLabel="Adult voice profile" value={design.profile} options={options(['Athena Youthful','Calm guide','Custom adult voice'])} onChange={profile=>setDesign(profile==='Athena Youthful'?initialDesign:profile==='Calm guide'?{...initialDesign,name:'Calm guide',profile,description:'An original adult voice with a warm mid-range pitch, smooth resonance, and unhurried, clear conversational delivery.',traits:[3,3,4,5,3,2,2]}:{...design,profile:'Custom adult voice'})}/></SettingRow>
      <SettingRow title="Voice name"><input className="settings-input" aria-label="Voice name" maxLength={80} value={design.name} onChange={e=>setDesign({...design,name:e.target.value})}/></SettingRow>
      <SettingRow title="Acoustic description" description="Describe an original adult voice. Adjustments below become part of the design prompt."><textarea className="settings-input" aria-label="Acoustic description" rows={4} maxLength={2200} value={design.description} onChange={e=>setDesign({...design,description:e.target.value})}/></SettingRow>
      {acousticTraits.map((name,i)=><div className="slider-row" key={name}><Slider label={'Acoustic '+name.toLowerCase()} value={design.traits[i]} min={1} max={5} onChange={value=>setDesign(d=>({...d,traits:d.traits.map((v,j)=>j===i?value:v)}))}/></div>)}
      <SettingRow title="Create a custom voice" description="OpenAI saves the design to your API organization. Creation is free. Listening uses billed GPT-Live audio."><div className="voice-actions"><button className="button secondary" disabled={!!working || !status.credential || settings.strictOffline || !designSchema.safeParse(design).success} onClick={()=>void generate()}>Generate voice</button><button className="button secondary" disabled={!!working||!designSchema.safeParse(design).success} onClick={()=>void run('save',async()=>{await change({design});setNotice('Voice design saved.')})}>Save design</button></div></SettingRow>
      {live.voices.length>0&&<><SettingRow title="Saved custom voices"><CustomSelect ariaLabel="Saved custom voices" value={library} options={[{value:'',label:'Select a voice'},...live.voices.map(v=>({value:v.id,label:v.name}))]} onChange={value=>{const v=live.voices.find(item=>item.id===value);setLibrary(value);setRename(v?.name??'');if(v)setDesign(v.design)}}/></SettingRow>
      {saved&&<><SettingRow title="Library name"><input aria-label="Library name" className="settings-input" maxLength={80} value={rename} onChange={e=>setRename(e.target.value)}/><button className="button secondary" disabled={!rename.trim()} onClick={()=>void change({voices:live.voices.map(v=>v.id===saved.id?{...v,name:rename.trim()}:v)})}>Save voice</button></SettingRow>
      <div className="voice-actions"><button className="button secondary" disabled={paidUnavailable} onClick={()=>void start('preview',saved.id)}>Preview saved voice</button><button className="button secondary" disabled={!!working||!status.credential||settings.strictOffline||!designSchema.safeParse(design).success} onClick={()=>void generate(true)}>Regenerate voice</button><button className="button secondary" onClick={()=>void change({voice:saved.id,chosen:true})}>Set as default</button><button className="button secondary" onClick={()=>{void change({voices:live.voices.filter(v=>v.id!==saved.id),...(live.voice===saved.id?{voice:'marin'}:{})});setLibrary('')}}>Remove local reference</button></div></>}</>}
    </SettingsDisclosure>
    <SettingsDisclosure title="Usage and budget">
      {([['monthlyUSD','Monthly voice budget (USD)',0,10000],['idleSeconds','Inactivity timeout (seconds)',5,600],['maxSeconds','Maximum session duration (seconds)',15,3600]] as const).map(([key,title,min,max])=><SettingRow key={key} title={title}><input className="settings-input" aria-label={title} type="number" defaultValue={live[key]} min={min} max={max} step={key==='monthlyUSD'?0.01:1} onBlur={e=>{if(e.target.value&&e.target.validity.valid)void change({[key]:e.target.valueAsNumber});else{e.target.value=String(live[key]);setNotice('Enter a value between '+min+' and '+max+'.')}}}/></SettingRow>)}
      <SettingRow title="Estimated voice usage" description="UTC reporting periods. Active time is $0.05/min with a 15-second initialization minimum. Athena closes idle sessions. Backend model usage is billed separately."><span>Today {currency(status.daily)} · Month {currency(status.monthly)}</span></SettingRow>
      <SettingRow title="Athena voice budget remaining"><span>{status.monthly===undefined?'Checking…':currency(Math.max(0,live.monthlyUSD-status.monthly))}</span></SettingRow>
      {!!status.uncertain&&<SettingRow title="Unconfirmed session allowance held" description="Athena reserves the maximum authorized duration when OpenAI does not confirm the outcome."><span>{currency(status.uncertain)}</span></SettingRow>}
      {status.active&&<SettingRow title="Current session" description={'Provider-reported duration: '+(status.reported??0)+' seconds'}><span>{status.seconds}s · {currency(status.cost)}</span></SettingRow>}
      {(status.threshold??0)>0&&<p role="status" className="card-description">{status.threshold}% of the monthly voice budget used.</p>}
      <SettingRow title="OpenAI account credits"><button className="button secondary" onClick={()=>void desktop.liveVoice({action:'billing'})}>Open billing dashboard</button></SettingRow>
    </SettingsDisclosure>
    {(notice||working)&&<p className="card-description" role="status">{notice|| (working==='generation'?'Generating voice…':'Working…')}</p>}
  </Section>
}
