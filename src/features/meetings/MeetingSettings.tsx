import { CustomSelect } from '../../components/ui/CustomSelect'
import type { MeetingCommand, MeetingPreferences, MeetingResult, MeetingSession, MeetingSnapshot, MeetingSource } from '../../../shared/meetings'

export const meetingTemplates = [
  {value:'general',label:'General meeting'}, {value:'technical',label:'Technical discussion'},
  {value:'standup',label:'Daily standup'}, {value:'interview',label:'Interview practice'},
]
export function MeetingModelSelect({preferences:p,models,change}:{preferences:MeetingPreferences;models:NonNullable<MeetingResult['models']>;change:(patch:Partial<MeetingPreferences>)=>void}) {
  const options=[{value:`${p.provider}|${p.model}`,label:`${p.provider==='local'?'Local':p.provider} · ${p.model}`},...models.filter(m=>m.id!==p.model||m.provider!==p.provider).map(m=>({value:`${m.provider}|${m.id}`,label:`${m.provider==='local'?'Local':m.provider} · ${m.id}${m.vision?' · Vision':''}`}))]
  return <CustomSelect menuPlacement="auto" ariaLabel="Meeting AI model" value={`${p.provider}|${p.model}`} options={options} onChange={value=>{const [provider,model]=value.split('|');change({provider:provider as MeetingPreferences['provider'],model})}}/>
}

export function MeetingSettings({session:s,snapshot,devices,models,section,command,refreshModels}:{session:MeetingSession;snapshot:MeetingSnapshot;devices:MediaDeviceInfo[];models:NonNullable<MeetingResult['models']>;section:'audio'|'ai'|'panel';command:(c:MeetingCommand)=>Promise<MeetingResult>;refreshModels:()=>Promise<void>}) {
  const p=s.preferences,patch=(value:Partial<MeetingPreferences>)=>void command({action:'preferences',patch:value})
  return <div className="meeting-settings" aria-label="Meeting settings">
    <details open={section==='audio'}><summary>Audio & recording</summary><div className="meeting-setting-fields">
      <label><input type="checkbox" checked={p.microphone} onChange={e=>patch({microphone:e.target.checked})}/>My microphone</label>
      <CustomSelect menuPlacement="auto" ariaLabel="Microphone device" value={p.deviceId} onChange={deviceId=>patch({deviceId})} options={[{value:'default',label:'Default microphone'},...devices.filter(d=>d.deviceId&&d.deviceId!=='default').map(d=>({value:d.deviceId,label:d.label||'Microphone'}))]}/>
      <label><input type="checkbox" checked={p.system} onChange={e=>patch({system:e.target.checked,systemSource:''})}/>Meeting audio from other apps</label>
      <small>Uses native system audio, including headphone output where supported. Other apps playing audio may also be recorded.</small>
      <label><input type="checkbox" checked={p.retainAudio} onChange={e=>patch({retainAudio:e.target.checked})}/>Save audio with this meeting</label>
      <small>Transcription stays local. Failed audio chunks remain available for retry until deleted.</small>
      <details><summary>Advanced transcription</summary><div className="meeting-setting-fields">
        <label><input type="checkbox" checked={p.partialTranscripts} onChange={e=>patch({partialTranscripts:e.target.checked})}/>Show early transcript previews</label><small>Updates after three seconds when the speech engine is available. Final wording may change.</small>
        <label>Recognition language<input key={`${s.id}-language`} defaultValue={p.language} placeholder="auto, en, es…" onBlur={e=>{if(/^(auto|[a-z]{2,3})$/.test(e.target.value))patch({language:e.target.value});else e.target.value=p.language}}/></label>
        <label>Whisper model path<input key={`${s.id}-model`} defaultValue={p.whisperModel} placeholder="Use Local AI setup" onBlur={e=>patch({whisperModel:e.target.value})}/></label>
        <label>Whisper executable path<input key={`${s.id}-binary`} defaultValue={p.whisperBinary} placeholder="Use installed Whisper" onBlur={e=>patch({whisperBinary:e.target.value})}/></label>
      </div></details>
    </div></details>
    <details open={section==='ai'}><summary>AI model & answers</summary><div className="meeting-setting-fields">
      <label><input type="checkbox" checked={p.aiConsent} onChange={e=>patch({aiConsent:e.target.checked})}/>Allow AI to analyze this meeting</label>
      <MeetingModelSelect preferences={p} models={models} change={patch}/><button onClick={()=>void refreshModels()}>Refresh models</button>
      {p.provider!=='local'&&<label><input type="checkbox" checked={p.cloudConsent} onChange={e=>patch({cloudConsent:e.target.checked})}/>Allow meeting context to be sent to this online provider. Existing account charges may apply.</label>}
      <label><input type="checkbox" checked={p.autoNotes} onChange={e=>patch({autoNotes:e.target.checked})}/>Update notes automatically</label>
      <div className="meeting-field"><span>Question assistance</span><CustomSelect menuPlacement="auto" ariaLabel="Question assistance" value={p.questions} onChange={questions=>patch({questions:questions as MeetingPreferences['questions']})} options={[{value:'off',label:'Off'},{value:'suggest',label:'Show detected questions'},{value:'request',label:'Answer when I ask'},{value:'automatic',label:'Prepare answers for review'}]}/></div>
      <div className="meeting-field"><span>Answer length</span><CustomSelect menuPlacement="auto" ariaLabel="Response style" value={p.style} onChange={style=>patch({style:style as MeetingPreferences['style']})} options={[{value:'quick',label:'Quick answer'},{value:'standard',label:'Short explanation'},{value:'detailed',label:'Detailed explanation'},{value:'coding',label:'Explanation with code'}]}/></div>
      <div className="meeting-field"><span>Meeting type</span><CustomSelect menuPlacement="auto" ariaLabel="Session template" value={p.template} onChange={template=>patch({template:template as MeetingPreferences['template']})} options={meetingTemplates}/></div>
      {p.template==='interview'&&<small>Practice questions and get feedback on your answers. Follow the interviewer’s rules during actual assessments.</small>}
    </div></details>
    <details><summary>Screen access & privacy</summary><div className="meeting-setting-fields">
      <label><input type="checkbox" checked={p.screenConsent} onChange={e=>patch({screenConsent:e.target.checked})}/>Allow active-screen analysis when requested</label>
      <label><input type="checkbox" checked={p.retainScreens} onChange={e=>patch({retainScreens:e.target.checked})}/>Save requested screenshots with this meeting</label>
      <small>Screenshots stay temporary unless you choose to save them. Text recognition runs locally on macOS; vision models can inspect the image.</small>
      <button onClick={()=>void command({action:'delete-screens'})}>Delete saved screenshots</button>
    </div></details>
    <details open={section==='panel'}><summary>Floating panel & screen sharing</summary><div className="meeting-setting-fields">
      <label><input type="checkbox" checked={p.alwaysOnTop} onChange={e=>patch({alwaysOnTop:e.target.checked})}/>Always on top</label>
      <label>Opacity<input type="range" min="0.4" max="1" step="0.05" value={p.opacity} onChange={e=>patch({opacity:Number(e.target.value)})}/></label>
      <label><input type="checkbox" checked={p.protection} onChange={e=>patch({protection:e.target.checked})}/>Request exclusion from screen capture</label>
      <small>{snapshot.protection}. Check your sharing preview; some capture tools can still include Athena.</small>
      <button onClick={()=>void command({action:'panel',mode:'safe'})}>Hide panel for screen sharing</button>
    </div></details>
    <details><summary>Speaker names</summary><div className="meeting-setting-fields">
      {(['microphone','system'] as MeetingSource[]).map(source=><label key={source}>{source==='microphone'?'My microphone':'Other participants'}<input key={`${s.id}-${source}`} defaultValue={s.speakers[source]} onBlur={e=>{if(e.target.value)void command({action:'speaker',source,name:e.target.value})}}/></label>)}
      <small>You can also label individual transcript segments. Remote voices are not automatically identified.</small>
    </div></details>
    <details><summary>Export & saved recordings</summary><div className="meeting-setting-fields">
      <div className="meeting-row">{(['md','txt','pdf','docx','json','audio'] as const).map(format=><button key={format} onClick={()=>void command({action:'export',format})}>{format==='audio'?'Audio ZIP':format.toUpperCase()}</button>)}</div>
      <button onClick={()=>{if(confirm('Delete all stored audio for this meeting?'))void command({action:'delete-audio'})}}>Delete saved audio</button>
    </div></details>
  </div>
}
