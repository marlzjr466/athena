import { useEffect, useRef, useState } from 'react'
import { Section, SettingRow } from '../../components/ui/Controls'
import { desktop } from '../../services/desktop'
import type { AthenaAPI } from '../../../shared/contracts'
type CursorStatus = Awaited<ReturnType<AthenaAPI['getCursorStatus']>>
const initialStatus: CursorStatus = { installed: false, authenticated: false, authenticationStatus: 'unknown', identity: null, version: null, message: 'Choose Check Cursor status to connect your existing CLI account.', models: [], modelCatalogAvailable: false }

export function CursorSettings() {
  const [status, setStatus] = useState<CursorStatus>(initialStatus)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const operationId = useRef(0)
  const inFlight = useRef(false)
  useEffect(() => {
    const id = ++operationId.current
    // Reading the main-process cache never starts the CLI or authenticates.
    void desktop.getCursorStatus({ cachedOnly: true }).then((value) => {
      if (id === operationId.current) setStatus(value)
    }).catch(() => {
      if (id === operationId.current) setNotice('Could not read the saved Cursor status. Use Check Cursor status to retry.')
    })
    return () => { operationId.current++ }
  }, [])
  const act = async (operation: () => Promise<CursorStatus>, label: string) => {
    if (inFlight.current) return
    inFlight.current = true
    const id = ++operationId.current
    setBusy(true); setNotice(label)
    try { const value = await operation(); if (id === operationId.current) { setStatus(value); setNotice('') } }
    catch (error) { if (id === operationId.current) setNotice(error instanceof Error ? error.message : 'Cursor CLI operation failed. Retry status.') }
    finally { inFlight.current = false; if (id === operationId.current) setBusy(false) }
  }
  const refresh = () => act(() => desktop.getCursorStatus({ refreshModels: true }), 'Checking Cursor status and models…')
  return <Section title="Cursor Subscription · Cursor CLI" description="Athena connects through Cursor’s documented Agent Client Protocol (ACP) and Cursor CLI authentication. The CLI retains one active account profile managed by Cursor; Athena does not copy its credentials or rotate accounts.">
    <SettingRow title="Cursor CLI status" description={`${status.message}${status.version ? ` · ${status.version}` : ''}`}><span className={`ai-status ${status.authenticated ? 'ai-active' : ''}`}>{busy ? '○ Connecting…' : status.authenticated ? '● Connected' : status.authenticationStatus === 'unknown' ? '○ Status not verified' : !status.installed ? '○ CLI not installed' : '○ Sign in required'}</span></SettingRow>
    {status.authenticated && <SettingRow title="Signed-in identity" description="Identity reported by the official Cursor CLI; not stored separately by Athena."><span>{status.identity ?? 'Authenticated Cursor CLI profile'}</span></SettingRow>}
    <SettingRow title="Capabilities" description="Streams Cursor Agent responses and project coding actions through ACP. Each Cursor permission prompt is sent to Athena’s existing approval UI. Cursor controls its plan limits and model availability."><span>Project agent · streaming · cancellable</span></SettingRow>
    <SettingRow title="Workspace and safety" description="Cursor uses this conversation’s authorized project folder. Without a project, Athena creates a private, separately granted Cursor chat folder in Athena’s application data. Each run is confined to that exact root; terminal, network, and MCP actions stay blocked, and Cursor file operations still require Athena approval."><span>{status.authenticated ? 'Project or private chat workspace' : 'Not active'}</span></SettingRow>
    <p className="card-description">Choose an available Cursor model in Chat Conversation. Refresh status here if the chat model list is out of date.</p>
    <div className="ai-actions">{!status.authenticated ? <button className="button primary" disabled={busy || (!status.installed && status.authenticationStatus !== 'unknown')} onClick={() => void act(() => desktop.signInCursor(), 'Waiting for Cursor browser sign-in…')}>Sign in with Cursor</button> : <button className="button secondary" disabled={busy} onClick={() => void act(() => desktop.signOutCursor(), 'Signing out of Cursor…')}>Sign out</button>}<button className="button secondary" disabled={busy} onClick={() => void refresh()}>{status.authenticated ? 'Refresh status & models' : 'Check Cursor status'}</button></div>
    {!status.installed && status.authenticationStatus !== 'unknown' && !busy && <p className="card-description">Install Cursor CLI from <a href="https://cursor.com/docs/cli/overview">Cursor’s official CLI documentation</a>, then refresh this page. Athena never runs an installer or shell setup automatically.</p>}
    <p className="card-description">Cursor plan limits apply. Athena does not rotate accounts, bypass limits, or fall back to API billing. ACP access is coding/project-oriented; Athena’s separate desktop automation tools are not exposed through Cursor.</p>
    <p className="ai-feedback" role="status" aria-live="polite">{notice}</p>
  </Section>
}
