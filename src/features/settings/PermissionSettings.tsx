import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react'
import { PERMISSION_DESCRIPTIONS, PERMISSION_LABELS, type AthenaPermission, type FilesystemAccessMode, type OSPermissionStatus } from '../../../shared/permissions'
import type { ApplicationDetectionResult } from '../../../shared/applicationDetection'
import { usePermissions } from '../../store/permissionStore'
import { desktop } from '../../services/desktop'
import { Section, SettingRow, Toggle } from '../../components/ui/Controls'
import '../../styles/permissions.css'

const statusLabel: Record<OSPermissionStatus, string> = { 'not-requested': 'Not requested', allowed: 'Allowed', denied: 'Denied', restricted: 'Restricted', unavailable: 'Unavailable', 'not-required': 'No blanket OS permission' }
export function PermissionSettings() {
  const { snapshot, pending, error, notice, refresh, setEnabled, setFilesystemAccess, request, openSettings, updateRemembered } = usePermissions()
  const [confirm, setConfirm] = useState<AthenaPermission | null>(null)
  const [applications, setApplications] = useState<ApplicationDetectionResult | null>(null)
  const [checkingApplications, setCheckingApplications] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
  useEffect(() => { if (confirm) dialog.current?.showModal(); else dialog.current?.close() }, [confirm])
  const applicationAllowed = snapshot?.permissions.find((entry) => entry.permission === 'applicationDetection')?.capabilityAllowed ?? false
  useEffect(() => { if (!applicationAllowed) setApplications(null) }, [applicationAllowed])
  const checkApplications = async () => {
    setCheckingApplications(true)
    try { setApplications(await desktop.getApplications()) }
    catch { setApplications({ ok: false, message: 'Could not read application names from macOS. Try again.' }) }
    finally { setCheckingApplications(false) }
  }
  return <>
    <div className="privacy-banner"><ShieldCheck size={30} /><div><h2>Your company. Your computer.</h2><p>Permission preferences and OS consent are separate. Athena starts with project-scoped file access. Full Mac Access requires a separate, explicit authorization and remains subject to macOS privacy controls.</p></div></div>
    <Section title="Permissions" description="Turning a switch off blocks Athena immediately. It does not revoke OS consent. Enabling a preference never approves a particular action or file.">
      <div className="permission-toolbar"><span>OS status refreshes when you return to this window.</span><button className="button secondary" disabled={pending} onClick={() => void refresh()}><RefreshCw size={13} /> Refresh permissions</button></div>
      {!snapshot && !error && <p role="status">Reading OS permissions…</p>}
      {snapshot?.permissions.map((entry) => <div key={entry.permission} className="permission-card" aria-label={PERMISSION_LABELS[entry.permission]}>
        <div className="permission-card-heading"><div><h3>{PERMISSION_LABELS[entry.permission]}</h3><p>{PERMISSION_DESCRIPTIONS[entry.permission]}</p></div><Toggle label={PERMISSION_LABELS[entry.permission]} checked={entry.enabled} disabled={pending || (!entry.enabled && entry.osStatus === 'unavailable')} onChange={(enabled) => { if (enabled) setConfirm(entry.permission); else void setEnabled(entry.permission, false) }} /></div>
        <div className="permission-statuses"><span>Athena opt-in: <strong>{entry.enabled ? 'On' : 'Off'}</strong></span><span>OS status: <strong>{entry.permission === 'desktopAutomation' && entry.osStatus === 'not-requested' ? 'Not granted' : statusLabel[entry.osStatus]}</strong></span><span className={entry.capabilityAllowed ? 'permission-allowed' : ''}>Capability gate: {entry.capabilityAllowed ? 'Allowed' : 'Blocked'}</span></div>
        <p className="permission-detail">{entry.detail}</p>
        {(entry.canRequest || entry.canOpenSettings) && <div className="permission-actions">{entry.canRequest && <button className="button secondary" disabled={pending || !entry.enabled} onClick={() => void request(entry.permission)}>Request macOS access<span className="permission-sr-only"> for {PERMISSION_LABELS[entry.permission]}</span></button>}{entry.canOpenSettings && <button className="button secondary" disabled={pending} onClick={() => void openSettings(entry.permission)}><ExternalLink size={13} /> System Settings<span className="permission-sr-only"> for {PERMISSION_LABELS[entry.permission]}</span></button>}</div>}
        {entry.permission === 'applicationDetection' && entry.capabilityAllowed && <div className="application-preview"><button className="button secondary" disabled={checkingApplications} onClick={() => void checkApplications()}><RefreshCw size={13} /> {checkingApplications ? 'Checking apps…' : 'Check active and running apps'}</button>{applications && (applications.ok ? <div className="application-preview-result" role="status"><p>Active app: <strong>{applications.active?.name ?? 'None detected'}</strong></p><p>{applications.running.length} user-facing apps running</p><ul>{applications.running.slice(0, 12).map((app) => <li key={`${app.bundleId ?? app.name}-${app.pid}`}>{app.name}</li>)}</ul>{applications.running.length > 12 && <p>Showing the first 12. Ask Athena in Conversation for the full list.</p>}</div> : <p className="permission-error" role="alert">{applications.message}</p>)}</div>}
      </div>)}
    </Section>
    <Section title="Remembered permissions" description="Exact operations and resources explicitly approved with Always allow. OS consent, project access, read-only mode, and mandatory sensitive-action confirmations still apply.">
      <SettingRow title="Enable Always allow" description="Use active remembered permissions for future matching requests."><Toggle label="Enable Always allow" checked={snapshot?.remembered?.enabled ?? true} disabled={pending || !snapshot?.remembered} onChange={enabled => void updateRemembered({ action: 'enable', enabled })} /></SettingRow>
      <p className="permission-detail">Disabling pauses all remembered grants without deleting their history. Re-enabling restores grants that have not been revoked.</p>
      <button className="button secondary" disabled={pending || !snapshot?.remembered?.rules.some(rule => !rule.revokedAt)} onClick={() => void updateRemembered({ action: 'revoke-all' })}>Revoke all remembered permissions</button>
      {!snapshot?.remembered?.rules.length && <p>No remembered permissions.</p>}
      {snapshot?.remembered?.rules.map(rule => <div className="permission-card" key={rule.id}>
        <h3>{rule.scope.operation.replaceAll('_', ' ')}</h3>
        <p style={{ overflowWrap: 'anywhere' }}>Scope: {rule.scope.project}</p>
        {rule.scope.resources.map(resource => <p key={resource} style={{ overflowWrap: 'anywhere' }}><code>{resource}</code></p>)}
        {rule.scope.command && <p style={{ overflowWrap: 'anywhere' }}><code>{rule.scope.command.manager} {rule.scope.command.args.join(' ')}</code><br />Offline sandbox · source and dependency writes blocked · configuration-bound</p>}
        <p>Granted {new Date(rule.grantedAt).toLocaleString()} · {rule.revokedAt ? `Revoked ${new Date(rule.revokedAt).toLocaleString()}` : snapshot.remembered?.enabled ? 'Active — subject to current resource and project validation' : 'Inactive — Always allow disabled'}</p>
        {!rule.revokedAt && <button className="button secondary" disabled={pending} onClick={() => void updateRemembered({ action: 'revoke', id: rule.id })}>Revoke</button>}
      </div>)}
    </Section>
    <Section title="Filesystem Access" description="Your selected project remains Athena’s default working directory. Choose whether it is also the filesystem boundary.">
      <div className="filesystem-access-options" role="group" aria-label="Filesystem access scope">
        {([
          ['project-only', 'Project Only', 'Restrict Athena’s file tools to the selected repository. This is the default.'],
          ['full-read-only', 'Full Mac — Read Only', 'Browse and read accessible locations beyond the project. File changes remain blocked.'],
          ['full-read-write', 'Full Mac — Read & Write', 'Create and edit ordinary files in accessible locations. Destructive actions and sensitive configuration changes still require approval.'],
        ] as const).map(([mode, label, description]) => <button key={mode} type="button" className={`filesystem-access-option ${((snapshot?.filesystemAccess?.active ? snapshot.filesystemAccess.mode : 'project-only') === mode) ? 'selected' : ''}`} aria-pressed={(snapshot?.filesystemAccess?.active ? snapshot.filesystemAccess.mode : 'project-only') === mode} disabled={pending || (mode !== 'project-only' && !snapshot?.permissions.find((entry) => entry.permission === 'personalFiles')?.capabilityAllowed)} onClick={() => void setFilesystemAccess(mode as FilesystemAccessMode)}><strong>{label}</strong><span>{description}</span></button>)}
      </div>
      <p className="permission-detail">Full Mac Access applies only to the currently selected AI provider/account. Switching providers leaves it inactive until you authorize that provider. Files inside .claude and .codex folders, including credentials, require separate approval for each AI tool action; approved contents may be sent to that provider and saved in the conversation. Other credential-named files, including fixtures, require approval for each explicit read. Commands need a separate exact-file read_paths approval. Environment files, key material, protected directories, and symlink escapes remain blocked. Athena never bypasses macOS permissions. For Desktop, Documents, Downloads, removable volumes, or other protected locations, review macOS System Settings → Privacy &amp; Security → Files and Folders or Full Disk Access. An app restart may be required after an OS permission change.</p>
      {snapshot?.filesystemAccess && !snapshot.filesystemAccess.active && snapshot.filesystemAccess.mode !== 'project-only' && <p className="permission-detail">A Full Mac grant exists for a different AI provider/account; Project Only is active for the current provider.</p>}
    </Section>
    {error && <p role="alert" className="permission-error">{error}</p>}
    {notice && <p role="status" className="permission-notice">{notice}</p>}
    <dialog ref={dialog} className="permission-dialog" aria-labelledby="permission-confirm-title" onCancel={() => setConfirm(null)}>
      {confirm && <><ShieldCheck size={25} /><h2 id="permission-confirm-title">Enable {PERMISSION_LABELS[confirm]}?</h2><p>{PERMISSION_DESCRIPTIONS[confirm]}</p><p>This saves your Athena opt-in only. If macOS consent is needed, use the separate request button afterward. No capability runs now.</p><div><button autoFocus className="button secondary" onClick={() => setConfirm(null)}>Cancel</button><button className="button primary" disabled={pending} onClick={() => void setEnabled(confirm, true).then((ok) => { if (ok) setConfirm(null) })}>Enable preference</button></div>{error && <p role="alert" className="permission-error">{error}</p>}</>}
    </dialog>
  </>
}
