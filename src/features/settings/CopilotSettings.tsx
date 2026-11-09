import { useEffect, useState } from 'react'
import { Section, SettingRow } from '../../components/ui/Controls'
import { desktop } from '../../services/desktop'
import type { CopilotCommand, CopilotStatus } from '../../../shared/copilot'

export function CopilotSettings() {
  const [status, setStatus] = useState<CopilotStatus>({accounts:[],activeId:null,message:''})
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState('')
  const run = async (command: CopilotCommand) => {
    setBusy(true)
    try {
      const next = await desktop.copilot(command)
      setStatus(next)
      const signedIn = next.accounts.some(account => account.id === next.activeId && account.enabled)
      setNotice(command.action === 'status' && signedIn ? '' : next.message)
    }
    catch { setNotice('Copilot operation failed. Verify your connection, OAuth registration, or CLI login and retry.') }
    finally { setBusy(false); setLoaded(true) }
  }
  useEffect(()=>{ void run({action:'status'}) },[])
  const authenticating = ['starting','waiting','verifying'].includes(status.cli?.phase ?? '')
  useEffect(()=>{
    if (!authenticating) return
    let live = true, timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { const next = await desktop.copilot({action:'status'}); if(live) setStatus(next) } catch { /* Keep the cancel action available. */ }
      if(live) timer = setTimeout(refresh, 1000)
    }
    timer = setTimeout(refresh,1000)
    return ()=>{live=false;clearTimeout(timer)}
  },[authenticating])
  const disabled = busy || authenticating || status.requestsActive
  const active = status.accounts.find(account => account.id === status.activeId && account.enabled)
  const connected = Boolean(active) && !authenticating
  const refreshModels = async () => {
    setBusy(true)
    setNotice('Checking Copilot status and models…')
    try {
      const next = await desktop.copilot({action:'status'})
      setStatus(next)
      const result = await desktop.getAIStatus()
      setNotice(result.ok ? `${result.message} ${result.status.models.length} models available; select in Conversation.` : result.message)
    } catch { setNotice('Could not refresh Copilot models.') }
    finally { setBusy(false) }
  }
  const signOut = async () => {
    if (!active) return
    setBusy(true)
    setNotice('Signing out of Copilot…')
    try {
      const next = await desktop.copilot({action:'remove', id: active.id})
      setStatus(next)
      setNotice('Copilot account disconnected. GitHub authorization for other CLI applications was not revoked.')
    } catch { setNotice('Copilot operation failed. Verify your connection, OAuth registration, or CLI login and retry.') }
    finally { setBusy(false) }
  }

  return <Section title="GitHub Copilot Subscription" description="Use your eligible GitHub Copilot plan. Premium usage and model eligibility apply. No model-provider API key is required.">
    {!loaded ? <SettingRow title="Copilot CLI status" description="Checking the saved Copilot account."><span className="ai-status">○ Connecting…</span></SettingRow> : connected && active ? <>
      <SettingRow title="Copilot CLI status" description={`${status.cli?.message || 'Copilot CLI is signed in.'}${status.cli?.version ? ` · ${status.cli.version}` : ''}`}><span className="ai-status ai-active">{busy ? '○ Connecting…' : '● Connected'}</span></SettingRow>
      <SettingRow title="Signed-in identity" description={active.kind === 'oauth' ? 'Independent OAuth account saved in operating-system credential storage.' : 'Identity verified through the official Copilot CLI. Athena does not read CLI credential files.'}><span>{active.login}</span></SettingRow>
      <SettingRow title="Capabilities" description="Streams Copilot subscription responses and approved project tools. Copilot controls plan eligibility, model access, and usage multipliers."><span>Subscription models · streaming · cancellable</span></SettingRow>
      <SettingRow title="Workspace and safety" description="Copilot uses this conversation’s authorized project context. Athena rechecks the signed-in identity before every request. Copilot host tools, skills, and MCP servers stay disabled."><span>Authorized project workspace</span></SettingRow>
      <p className="card-description">Choose an available Copilot model in Chat Conversation. Refresh status here if the chat model list is out of date.</p>
      <div className="ai-actions">
        <button className="button secondary" disabled={disabled} onClick={() => void signOut()}>Sign out</button>
        <button className="button secondary" disabled={busy} onClick={() => void refreshModels()}>Refresh status & models</button>
      </div>
      <p className="card-description">Copilot plan limits apply. Sign out removes Athena’s saved account binding. It does not revoke GitHub authorization or sign out other Copilot CLI applications.</p>
    </> : <>
      <div className="ai-actions">
        <button className="button primary" disabled={disabled} onClick={()=>void run({action:'cli-login',flow:'browser'})}>Sign in with GitHub (Browser)</button>
        <button className="button secondary" disabled={disabled} onClick={()=>void run({action:'cli-login',flow:'device'})}>Sign in with GitHub (Device Code)</button>
        <button className="button secondary" disabled={disabled} onClick={()=>void run({action:'connect-cli'})}>Connect Existing Copilot CLI</button>
        <button className="button secondary" disabled={disabled || status.managing} onClick={()=>void run({action:'cli-manage'})}>Manage CLI accounts in Terminal</button>
        <button className="button secondary" disabled={disabled} onClick={()=>void run({action:'cli-check'})}>Check CLI installation</button>
      </div>
      {status.managing && <p role="status">Exit the account-management CLI, then click Connect Existing Copilot CLI. Copilot requests are paused until reconnection.</p>}
      <p>No OAuth Client ID is required for these methods. The official Copilot CLI opens your browser and stores your login.</p>
      {status.cli && <div role="status"><p>{status.cli.installed ? `Copilot CLI ${status.cli.version}` : 'CLI installation not verified'} · {status.cli.message}</p>
        {status.cli.code && <><strong>{status.cli.code}</strong><button className="button secondary" onClick={()=>void navigator.clipboard.writeText(status.cli!.code!)}>Copy code</button><button className="button secondary" onClick={()=>void desktop.openExternalLink({url:'https://github.com/login/device'})}>Open GitHub verification</button></>}
        {authenticating && <button className="button secondary" onClick={()=>void run({action:'cancel'})}>Cancel GitHub sign-in</button>}
      </div>}
      <details><summary>Advanced: independent OAuth App accounts</summary>
      <p className="card-description">Independent accounts use GitHub device authorization and operating-system credential storage. Register a GitHub OAuth App with device flow enabled, then enter its public Client ID. No client secret is needed.</p>
      <label>OAuth App Client ID <input aria-label="GitHub OAuth Client ID" value={clientId} onChange={e=>setClientId(e.target.value)} autoComplete="off" /></label>
      <div className="ai-actions">
        <button className="button primary" disabled={disabled || !clientId.trim()} onClick={()=>void run({action:'login',clientId})}>Add / reconnect GitHub account</button>
        <button className="button secondary" disabled={busy} onClick={() => void refreshModels()}>Refresh models / test connection</button>
      </div>
      </details>
      <p className="card-description">For CLI authentication, run <code>copilot login</code> in your terminal. Use its browser or device-code flow, then connect above. Athena checks the account identity before every request; it does not read CLI credential files. For account management, open Copilot in your terminal, run /user list, /user switch, or /logout, then reconnect here. Stop active Athena requests first. Athena revalidates identity and does not automatically rotate accounts.</p>
      {status.device && <div className="ai-removal"><p>Enter <strong>{status.device.code}</strong> at GitHub. Expires {new Date(status.device.expiresAt).toLocaleTimeString()}.</p><button className="button secondary" onClick={()=>void desktop.openExternalLink({url:status.device!.url})}>Open GitHub authorization</button><button className="button primary" disabled={busy} onClick={()=>void run({action:'poll'})}>I have authorized — check connection</button><button className="button secondary" disabled={busy} onClick={()=>void run({action:'cancel'})}>Cancel sign-in</button></div>}
      {status.accounts.map(account=><div className="setting-row" key={account.id}><div><strong>{account.login}</strong><p>{account.kind === 'oauth' ? 'Independent OAuth account' : 'CLI account binding'} · {account.enabled ? 'Enabled' : 'Disabled'}{status.activeId === account.id ? ' · Selected' : ''}</p></div><div className="ai-actions"><button disabled={disabled || !account.enabled || account.id===status.activeId} onClick={()=>void run({action:'select',id:account.id})}>Select</button><button disabled={disabled} onClick={()=>void run({action:'enable',id:account.id,enabled:!account.enabled})}>{account.enabled?'Disable':'Enable'}</button><button disabled={disabled} onClick={()=>void run({action:'remove',id:account.id})}>Disconnect account</button></div></div>)}
      <p className="card-description">Disconnect removes Athena’s saved authorization. It does not revoke GitHub authorization or sign out other CLI applications. Revoke access in GitHub Settings when needed. Expired or revoked tokens require sign-in again.</p>
    </>}
    <p className="ai-feedback" role="status">{busy ? 'Connecting…' : notice}</p>
  </Section>
}
