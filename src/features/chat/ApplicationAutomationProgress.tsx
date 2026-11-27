import { useEffect, useState } from 'react'
import type { AutomationProgress } from '../../../shared/automation'
import { desktop } from '../../services/desktop'
import '../../styles/automationProgress.css'

export function ApplicationAutomationProgress({progress}:{progress:AutomationProgress}) {
  const running=progress.phase==='running'
  const [now,setNow]=useState(Date.now),[error,setError]=useState('')
  useEffect(()=>{
    setError('')
    if(!running)return
    const timer=setInterval(()=>setNow(Date.now()),1000)
    return ()=>clearInterval(timer)
  },[progress.id,running])
  async function control(action:'pause'|'resume'|'stop') {
    try{await desktop.computerUseCheck({action,taskId:progress.id});setError('')}
    catch{setError('This task could not be updated. Check its current status in Computer use settings.')}
  }
  const elapsed=Math.max(0,Math.floor(((running?now:progress.updatedAt)-progress.startedAt)/1000))
  const title=running?(progress.paused?'Pause requested':progress.task):({complete:'Automation complete',failed:'Automation failed',cancelled:'Automation stopped'} as const)[progress.phase as 'complete'|'failed'|'cancelled']
  return <section className="automation-progress" aria-label="Application automation">
    <header><strong role="status">{title}</strong>
      {running && <span className="automation-task-controls">
        <button type="button" onClick={()=>void control(progress.paused?'resume':'pause')}>{progress.paused?'Resume':'Pause'}</button>
        <button type="button" onClick={()=>void control('stop')}>Stop</button>
      </span>}
    </header>
    <p>{[progress.engine,progress.application,elapsed+'s',progress.verifiedSteps!==undefined && progress.verifiedSteps+' verified steps',
      !!progress.apiRequests && progress.apiRequests+' API requests'].filter(Boolean).join(' · ')}</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
