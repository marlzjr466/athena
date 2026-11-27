import { SettingsDisclosure } from '../../components/ui/Controls'
import { useState } from 'react'
import { desktop } from '../../services/desktop'
import type { CodexThreadSummary } from '../../../shared/codex'
export function CodexHistory(){
  const [threads,setThreads]=useState<CodexThreadSummary[]>([]),[text,setText]=useState(''),[notice,setNotice]=useState(''),[cursor,setCursor]=useState<string|null>(),[busy,setBusy]=useState(false)
  const load=async(next?:string)=>{setBusy(true);try{const r=await desktop.codexCommand({action:'threads',cursor:next});setThreads(t=>next?[...t,...r.threads??[]]:r.threads??[]);setCursor(r.nextCursor);setNotice(r.message??'Existing threads are read-only here; use their owning client to continue.')}catch{setNotice('Could not load Codex history. Refresh the connection status.')}finally{setBusy(false)}}
  return <SettingsDisclosure title="Native Codex history"><button className="button secondary" disabled={busy} onClick={()=>void load()}>Browse threads</button>{notice&&<p className="card-description">{notice}</p>}
    {threads.map(t=><div className="setting-row" key={t.id}><span>{t.title||'Untitled Codex thread'}</span><button className="button secondary" disabled={busy} onClick={()=>{setBusy(true);void desktop.codexCommand({action:'read',threadId:t.id}).then(r=>{setText(r.text??'');setNotice(r.message??'')}).catch(()=>setNotice('Could not read this native thread.')).finally(()=>setBusy(false))}}>View</button></div>)}
    {cursor&&<button className="button secondary" disabled={busy} onClick={()=>void load(cursor)}>More threads</button>}{text&&<pre className="activity-output" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{text}</pre>}
  </SettingsDisclosure>
}
