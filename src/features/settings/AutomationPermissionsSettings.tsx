import { useState } from 'react'
import { ApplicationAutomationSettings } from './ApplicationAutomationSettings'
import { desktop } from '../../services/desktop'
import { APPLICATIONS } from '../../../shared/desktopActions'
import type { ComputerUseStatus } from '../../../shared/automation'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { Section, SettingRow, SettingsDisclosure, Slider, Toggle } from '../../components/ui/Controls'
import { useAthena } from '../../store/athenaStore'
import type { AutomationPermission } from '../../../shared/automation'

const rows: Array<{ key: AutomationPermission; title: string; description: string }> = [
  { key: 'internalNavigation', title: 'Athena navigation', description: 'Let the local assistant open Athena pages and conversation history.' },
  { key: 'conversationManagement', title: 'Conversation management', description: 'Let the local assistant create, open, switch, rename, and stop Athena conversations.' },
  { key: 'browserAccess', title: 'Public internet access', description: 'Allow the local assistant to search public websites and read public pages. Also enable Internet Access above.' },
  { key: 'desktopApplicationControl', title: 'Desktop application control', description: 'Allow supported open and focus actions. Accessible control also needs Accessibility UI Control under Privacy.' },
  { key: 'fileReading', title: 'File reading', description: 'Use the files and projects you explicitly authorize under Privacy.' },
  { key: 'fileModification', title: 'File modification', description: 'Allow edits within an explicitly authorized project, subject to its conversation permission mode.' },
  { key: 'terminalExecution', title: 'Terminal execution', description: 'Allow bounded commands within an authorized project when its permission mode allows them.' },
  { key: 'externalMessageSubmission', title: 'External message submission', description: 'Allow an explicit local request to submit dictated text to the selected online conversation provider. Reading a reply aloud requires a separate voice request.' },
  { key: 'destructiveOperations', title: 'Destructive operations', description: 'Allow delete actions after a separate confirmation dialog.' },
  { key: 'projectManagement', title: 'Project management', description: 'Open authorized projects, choose a folder, or create a folder at a location you approve. Project access and conversation permissions still apply.' },
  { key: 'gitOperations', title: 'Git operations', description: 'Inspect branches and working-tree changes. Explicit branch switches preserve local changes and stop if project tasks are active.' },
  { key: 'browserInteraction', title: 'Browser interaction', description: 'Control authorized browser tabs and public websites. Existing windows also require desktop access, or a browser connection you authorize.' },
  { key: 'desktopUIInteraction', title: 'Desktop UI interaction', description: 'Inspect and operate supported accessible application controls. Requires Desktop Automation and OS accessibility authorization separately.' },
  { key: 'screenObservation', title: 'Screen observation', description: 'Observe a screen or window only through the existing capture approval flow. Requires Screen Capture under Privacy and OS screen-recording permission.' },
]

export function AutomationPermissionsSettings() {
  const { snapshot, update } = useAthena()
  const permissions = snapshot?.settings.automationPermissions
  const [status,setStatus]=useState<ComputerUseStatus>()
  const [privacy,setPrivacy]=useState('')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [application,setApplication]=useState('')
  const settings=snapshot?.settings, computer=settings?.computerUse
  if (!permissions || !settings || !computer) return null
  const change=(patch:Partial<typeof computer>)=>void update({computerUse:{...computer,...patch}})
  const check=async(action:'status'|'test')=>{
    if(busy) return
    setBusy(true);setError('')
    try {
      const [result,grants]=await Promise.all([desktop.computerUseCheck(action),desktop.getPermissions()])
      setStatus(result)
      setPrivacy(grants.permissions.filter(p=>['accessibilityControl','screenCapture'].includes(p.permission)).map(p=>(p.permission==='screenCapture'?'Screen capture':'Accessibility')+' '+p.osStatus).join(' · '))
    } catch {setError('Could not check computer use. Reopen Settings and try again.')}
    finally{setBusy(false)}
  }
  return <><Section title="Automation permissions" description="Choose what Floating Athena can do. Athena checks these permissions whenever an action runs.">
    {rows.map(({ key, title, description }) => <SettingRow key={key} title={title} description={description}>
      <Toggle label={title} checked={permissions[key]} onChange={(enabled) => void update({ automationPermissions: { ...permissions, [key]: enabled } })} />
    </SettingRow>)}
  </Section>
  <Section title="Computer use" description="Manage voice actions, browser sessions and desktop access.">
    <SettingRow title="Enable computer use"><Toggle label="Enable computer use" checked={computer.enabled} onChange={enabled=>change({enabled})}/></SettingRow>
    <ApplicationAutomationSettings/>
    <SettingRow title="Voice-controlled automation"><Toggle label="Voice-controlled automation" checked={computer.voice} onChange={voice=>change({voice})}/></SettingRow>
    <SettingRow title="Allow routine browser searches" description="When you ask in Codex chat or by voice, Athena can open the site or tab you name, share its controls with Codex, and submit your search words without a popup. Screenshots and sensitive actions require separate approval.">
      <Toggle label="Allow routine browser searches" checked={computer.handsFreeBrowserSearches} onChange={handsFreeBrowserSearches=>change({handsFreeBrowserSearches})}/>
    </SettingRow>
    {settings.applicationAutomation.engine!=='codex' && <SettingRow title="Native planning model" description="Athena Native uses this model for complex tasks. Sending voice instructions to an online planner requires External message submission.">
      <CustomSelect ariaLabel="Native planning model" value={computer.planner} options={[{value:'selected',label:'Selected conversation model'},{value:'local',label:'Local companion model'}]} onChange={value=>change({planner:value==='local'?'local':'selected'})}/>
    </SettingRow>}
    <SettingRow title="Dedicated browser" description="Choose which browser Athena opens when you request a separate session.">
      <CustomSelect ariaLabel="Browser session" value={computer.browser} options={[{value:'playwright',label:'Chrome or Edge (Playwright)'},{value:'embedded',label:'Athena browser'}]} onChange={value=>change({browser:value==='embedded'?'embedded':'playwright'})}/>
    </SettingRow>
    <SettingsDisclosure title="Window awareness and interaction feedback">
      {([
        ['applicationAwareness', 'Real-time application awareness'],
        ['reuseBrowserWindows', 'Reuse existing browser windows'],
        ['visibleCursor', 'Visible automation cursor'],
        ['highlightTargets', 'Highlight interaction targets'],
        ['smoothCursor', 'Smooth cursor movement'],
        ['clickRipple', 'Click ripple animation'],
        ['pauseOnConflict', 'Pause on conflicting manual interaction'],
      ] as const).map(([key, title]) => <SettingRow key={key} title={title}><Toggle label={title} checked={computer[key]} onChange={value => change({[key]: value})}/></SettingRow>)}
      <Slider label="Automation animation speed" value={computer.animationSpeed} min={0.5} max={2} step={0.25} unit="×" onChange={animationSpeed => change({animationSpeed})}/>
      <SettingRow title="Authorized Chromium connection" description="Optional loopback debugging port for a browser you started for automation. Zero uses native window controls.">
        <input aria-label="Authorized Chromium port" className="settings-input" type="number" min={0} max={65535} key={computer.browserDebugPort} defaultValue={computer.browserDebugPort} onBlur={event => { if (event.currentTarget.validity.valid) change({browserDebugPort: Number(event.currentTarget.value)}) }}/>
      </SettingRow>
    </SettingsDisclosure>
    <SettingRow title="Vision-based automation" description="Allow a compatible model to inspect a window after you approve sharing its contents. Visual input requires a separate approval."><Toggle label="Vision-based automation" checked={computer.vision} onChange={vision=>change({vision})}/></SettingRow>
    <SettingRow title="Keyboard and mouse control"><Toggle label="Keyboard and mouse control" checked={computer.input} onChange={input=>change({input})}/></SettingRow>
    <SettingRow title="Clipboard shortcuts" description="Allow Copy and Paste in an authorized application after review."><Toggle label="Clipboard shortcuts" checked={computer.clipboard} onChange={clipboard=>change({clipboard})}/></SettingRow>
    <SettingsDisclosure title="Authorized applications">{Object.entries(APPLICATIONS).map(([id,app])=><SettingRow key={id} title={app.name}><Toggle label={'Allow '+app.name} checked={!computer.blockedApps.includes(id)} onChange={on=>change({blockedApps:on?computer.blockedApps.filter(k=>k!==id):[...computer.blockedApps,id]})}/></SettingRow>)}
      <button className="button secondary compact" disabled={busy} onClick={()=>void check('status')}>Find installed applications</button>
      {!!status?.installed?.length && <SettingRow title="Additional application">
        <CustomSelect ariaLabel="Additional application" value={application} options={[{label:'Choose application',value:''},...status.installed.map(app=>({label:app.name,value:app.key}))]} onChange={setApplication}/>
        {application && <Toggle label="Authorize selected application" checked={computer.trustedInstalled.includes(application)} onChange={enabled=>change({trustedInstalled:enabled?[...computer.trustedInstalled,application]:computer.trustedInstalled.filter(key=>key!==application)})}/>}
      </SettingRow>}
    </SettingsDisclosure>
    <div className="slider-row"><Slider label="Automation timeout" value={settings.voiceInteraction.aiResponseTimeoutSeconds} min={30} max={600} step={15} unit=" sec" onChange={aiResponseTimeoutSeconds=>void update({voiceInteraction:{...settings.voiceInteraction,aiResponseTimeoutSeconds}})}/></div>
    <SettingRow title="Floating activity indicator"><Toggle label="Floating activity indicator" checked={settings.taskActivityEnabled} onChange={taskActivityEnabled=>void update({taskActivityEnabled})}/></SettingRow>
    <SettingRow title="Automation status" description={status?[status.browser,status.locked?'Desktop locked':'',privacy].filter(Boolean).join(' · '):'Check browser and operating-system permissions on this computer.'}>
      <button className="button secondary compact" disabled={busy} onClick={()=>void check('status')}>Check status</button>
    </SettingRow>
    <SettingRow title="Test automation" description="Check local capability gates and the native executor. Voice, visual inference and input need an interactive test; this check does not submit paid requests.">
      <button className="button secondary compact" disabled={busy} onClick={()=>void check('test')}>Run test</button>
      <button className="button secondary compact" onClick={()=>void desktop.cancelHandsFreeReply(true).catch(()=>setError('Could not stop automation.'))}>Stop automation</button>
    </SettingRow>
    {(status?.test || error) && <p className="settings-note" role="status">{error||status?.test?.message}</p>}
    {status?.checks?.map(check=><SettingRow key={check.name} title={check.name} description={check.message}><span>{check.status}</span></SettingRow>)}
    <SettingsDisclosure title="Recent automation history">
      <SettingRow title="History diagnostics">
      <button className="button secondary compact" disabled={busy} onClick={()=>void check('status')}>Refresh history</button>
      <button className="button secondary compact" disabled={!status?.recent.length} onClick={()=>void navigator.clipboard.writeText(JSON.stringify(status?.recent,null,2)).catch(()=>setError('Could not copy diagnostics.'))}>Copy diagnostics</button>
      </SettingRow>
      {status && (status.recent.length?status.recent.map((r,i)=><SettingsDisclosure key={r.createdAt+i} title={`${r.actionId} · ${r.status}`}>
        <p className="settings-note">{new Date(r.createdAt).toLocaleString()}{r.durationMs!==undefined?` · ${r.durationMs} ms`:''}</p>
        {r.diagnostics?Object.entries(r.diagnostics).map(([key,value])=><SettingRow key={key} title={key.replace(/([a-z])([A-Z])/g,'$1 $2')} description={value}>{null}</SettingRow>):<p className="settings-note">This older entry contains no execution diagnostics.</p>}
      </SettingsDisclosure>):<p>No actions recorded.</p>)}
    </SettingsDisclosure>
  </Section></>
}
