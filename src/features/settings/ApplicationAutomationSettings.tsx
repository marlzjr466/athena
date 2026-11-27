import { useEffect, useState } from 'react'
import { useAthena } from '../../store/athenaStore'
import { desktop } from '../../services/desktop'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { SettingRow, SettingsDisclosure, Toggle } from '../../components/ui/Controls'
import { applicationAutomationDefaults, type ApplicationAutomationConfig, type AutomationControl, type AutomationEngineStatus } from '../../../shared/applicationAutomation'

export function ApplicationAutomationSettings() {
  const {snapshot,update}=useAthena()
  const config=snapshot?.settings.applicationAutomation ?? applicationAutomationDefaults
  const [status,setStatus]=useState<AutomationEngineStatus>(), [environment,setEnvironment]=useState<AutomationEngineStatus['environment']>()
  const [notice,setNotice]=useState(''), [checking,setChecking]=useState(false)
  const change=(patch:Partial<ApplicationAutomationConfig>)=>void update({applicationAutomation:{...config,...patch}})
  useEffect(()=>{
    let mounted=true, timer:ReturnType<typeof setTimeout>
    const refresh=async()=>{
      try {const result=await desktop.computerUseCheck('activity'); if(mounted)setStatus(result.automation)}
      catch { /* Explicit connection checks show errors. */ }
      if(mounted)timer=setTimeout(refresh,2500)
    }
    void refresh()
    return ()=>{mounted=false;clearTimeout(timer)}
  },[])
  const control=async(command:AutomationControl)=>{
    setChecking(true);setNotice('')
    try {
      const result=await desktop.computerUseCheck(command)
      setStatus(result.automation)
      if(typeof command==='string')setEnvironment(result.automation?.environment)
      if(command==='status' && config.engine!=='codex')setNotice(result.automation?.credential?'Verified OpenAI API credential saved. Account access is checked when each capability runs.':'Add and verify an OpenAI API key in AI settings, or select Athena Native Automation.')
    } catch {setNotice('Could not complete the request. Check the API connection, account permissions and current task.')}
    finally{setChecking(false)}
  }
  const task=status?.task
  return <>
    <SettingRow title="Automation engine" description="Codex uses your ChatGPT subscription and prefers native computer use for supported applications.">
      <CustomSelect ariaLabel="Automation engine" value={config.engine} options={[{value:'codex',label:'Codex App Server · ChatGPT'},{value:'openai',label:'OpenAI Automation'},{value:'native',label:'Athena Native Automation'}]} onChange={v=>change({engine:v==='codex'?'codex':v==='native'?'native':'openai'})}/>
    </SettingRow>
    {config.engine==='codex' && <SettingRow title="Codex connection" description={status?.codex ? (status.codex.connected ? 'ChatGPT subscription connected' : 'ChatGPT sign-in required')+' · '+status.codex.model+(status.codex.available?'':' · model unavailable') : 'Check the subscription connection and model availability. Voice audio uses your GPT-Live budget.'}>
      <button type="button" className="button secondary compact" disabled={checking} onClick={()=>void control('status')}>Check connection</button>
    </SettingRow>}
    {config.engine!=='native' && <SettingRow title="Automation model"><CustomSelect ariaLabel="Automation model" value={config.model} options={[{value:'gpt-6.2-sol',label:'GPT-6.2 Sol'},{value:'gpt-6-astra',label:'GPT-6 Astra'}]} onChange={v=>{setEnvironment(undefined);change({model:v==='gpt-6-astra'?'gpt-6-astra':'gpt-6.2-sol'})}}/></SettingRow>
    }
    {config.engine==='openai' && <>
      <SettingRow title="Execution environment" description="Desktop input always runs on this computer. An optional isolated executor can host a managed planning session.">
        <CustomSelect ariaLabel="Execution environment" value={config.environment} options={[{value:'local',label:'Local computer'},{value:'self_hosted',label:'Self-hosted sandbox'}]} onChange={v=>{setEnvironment(undefined);change({environment:v==='self_hosted'?'self_hosted':'local'})}}/>
      </SettingRow>
      {config.environment==='self_hosted' && <SettingsDisclosure title="Connect an isolated executor">
        <SettingRow title="Self-hosted executor" description="Use a dedicated sandbox with an empty /workspace, an environment-scoped key and no host mounts or credentials. Connect its Codex exec-server using the remote URL and environment ID below.">
          <button type="button" className="button secondary compact" disabled={checking} onClick={()=>void control('prepare-environment')}>Prepare executor</button>
          <button type="button" className="button secondary compact" disabled={checking} onClick={()=>void control('status')}>Check connection</button>
        </SettingRow>
        {environment && <><SettingRow title="Executor status"><span>{environment.connected?'Connected':'Waiting for executor'}</span></SettingRow><SettingRow title="Environment ID" description={environment.id}>{null}</SettingRow><SettingRow title="Remote URL" description={environment.remote}>{null}</SettingRow></>}
      </SettingsDisclosure>}
      <SettingRow title="Automatic fallback" description="Use Athena Native Automation when OpenAI is unavailable. Athena checks completed steps before continuing.">
        <Toggle label="Automatic automation fallback" checked={config.fallback} onChange={fallback=>change({fallback})}/>
      </SettingRow>
    </>}
    {config.engine!=='codex' && <>
    <SettingRow title="Persist task sessions" description="Save encrypted task context when OS secure storage is available. Say “resume my last automation” in the same conversation to continue.">
      <Toggle label="Persist automation sessions" checked={config.persist} onChange={persist=>change({persist})}/>
    </SettingRow>
    <SettingsDisclosure title="Automation limits and usage">
      <SettingRow title="Maximum steps per task"><input className="settings-input" type="number" aria-label="Maximum automation steps" min={1} max={16} defaultValue={config.maxSteps} key={config.maxSteps} onBlur={e=>{if(e.target.value && e.target.validity.valid)change({maxSteps:Number(e.target.value)})}}/></SettingRow>
      <SettingRow title="Monthly OpenAI request budget" description="Counts managed planning turns and visual model requests. Set to zero to use native fallback.">
        <input className="settings-input" type="number" aria-label="Monthly OpenAI automation requests" min={0} max={5000} defaultValue={config.monthlyRequests} key={config.monthlyRequests} onBlur={e=>{if(e.target.value && e.target.validity.valid)change({monthlyRequests:Number(e.target.value)})}}/>
      </SettingRow>
      <SettingRow title="Monthly estimated-cost threshold" description="USD. Athena checks reported usage before the next request. An individual request can cross the threshold. Unknown charges pause further OpenAI requests.">
        <input className="settings-input" type="number" aria-label="Monthly automation cost threshold" placeholder="No limit" min={0} max={10000} step="0.01" defaultValue={config.monthlyEstimateUSD??''} key={config.monthlyEstimateUSD??'none'} onBlur={e=>{if(e.target.validity.valid)change({monthlyEstimateUSD:e.target.value===''?null:Number(e.target.value)})}}/>
      </SettingRow>
      <SettingRow title="This month" description={status?status.requests+' requests · $'+status.estimatedUSD.toFixed(4)+' estimated from reported tokens'+(status.unreported?' · '+status.unreported+' with unreported usage':''):'Checking local usage…'}>{null}</SettingRow>
      <SettingRow title="OpenAI connection" description={status?(status.credential?'Verified API key saved':'API key unavailable'):'Checking credential status…'}>
        <button type="button" className="button secondary compact" disabled={checking} onClick={()=>void control('status')}>Check status</button>
      </SettingRow>
    </SettingsDisclosure></>}
    {task && <SettingRow title={task.paused?'Automation paused':task.action} description={[task.engine,task.model,task.application,task.steps+' verified steps',Math.max(0,Math.floor((Date.now()-task.started)/1000))+'s'].filter(Boolean).join(' · ')}>
      <button type="button" className="button secondary compact" onClick={()=>void control({action:task.paused?'resume':'pause',taskId:task.id})}>{task.paused?'Resume':'Pause'}</button>
      <button type="button" className="button secondary compact" onClick={()=>void control({action:'stop',taskId:task.id})}>Stop</button>
    </SettingRow>}
    {notice && <p className="settings-note" role="status">{notice}</p>}
  </>
}
