import { useEffect, useState } from 'react'
import { Section, SettingRow } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { desktop } from '../../services/desktop'
import { emptyChatGPTStatus, type ChatGPTAccountStatus, type ChatGPTStatus } from '../../../shared/chatgpt'
import { modelCapabilities, type ReasoningEffort } from '../../../shared/conversations'
import { useChat } from '../../store/chatStore'
import { useAthena } from '../../store/athenaStore'
import { emptyCodexCLIStatus, type CodexCLIStatus } from '../../../shared/codex'
import '../../styles/ai.css'

export function ChatGPTSettings() {
  const chat = useChat()
  const savedSettings = useAthena((state) => state.snapshot?.settings)
  const updateSettings = useAthena((state) => state.update)
  const [status, setStatus] = useState<ChatGPTStatus>(emptyChatGPTStatus)
  const [codexStatus, setCodexStatus] = useState<CodexCLIStatus>(emptyCodexCLIStatus)
  const [busy, setBusy] = useState(false)
  const [checkingCodex, setCheckingCodex] = useState(false)
  const [notice, setNotice] = useState('')
  const [pendingLabel, setPendingLabel] = useState('')
  useEffect(() => { let live = true; void Promise.all([desktop.getChatGPTStatus(), desktop.getCodexCLIStatus({ refresh: true })]).then(([value, codex]) => { if (live) { setStatus(value); setPendingLabel(value.pendingAccount?.label ?? ''); setCodexStatus(codex) } }).catch(() => { if (live) setNotice('Could not read ChatGPT or Codex connection status.') }); return () => { live = false } }, [])
  const run = async (operation: () => Promise<ChatGPTStatus>) => {
    if (busy) return
    setBusy(true); setNotice('')
    try { const result = await operation(); setStatus(result); setPendingLabel(result.pendingAccount?.label ?? ''); setNotice(result.message) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'ChatGPT account operation failed. Try again.') }
    finally { setBusy(false) }
  }
  const updateAccount = (accountId: string, update: Partial<ChatGPTAccountStatus>) => setStatus((current) => ({ ...current, accounts: current.accounts.map((account) => account.id === accountId ? { ...account, ...update } : account) }))
  const active = status.accounts.find((account) => account.active)
  const chatBusy = chat.snapshot.phase !== 'idle'
  const codingBackend = savedSettings?.chatGPTCodingBackend ?? 'athena'
  // Keep Settings in lockstep with the reasoning selector in the conversation.
  // Existing sessions can retain their own model even if the account default differs.
  const reasoningModel = chat.snapshot.config?.model ?? active?.model ?? null
  const codexEfforts = codexStatus.models.find((model) => model.id === reasoningModel)?.efforts ?? []
  const offeredEfforts = codingBackend === 'codex-cli' && chat.snapshot.workspaces?.length
    ? [...new Set<ReasoningEffort>(['auto', ...codexEfforts])]
    : reasoningModel ? modelCapabilities(reasoningModel).efforts : []
  const refreshCodex = async () => {
    if (checkingCodex) return
    setCheckingCodex(true)
    try { const result = await desktop.getCodexCLIStatus({ refresh: true }); setCodexStatus(result); setNotice(result.message) }
    catch { setNotice('Codex CLI status could not be refreshed.') }
    finally { setCheckingCodex(false) }
  }
  return <Section title="ChatGPT Subscription" description="Connect and choose among separate ChatGPT account registrations. Sign-in uses OpenAI’s official browser flow; Athena verifies the returned identity before saving any new account. OAuth credentials remain in macOS Keychain and are never exposed to the renderer.">
    <SettingRow title="Active account" description={active ? `${active.label}${active.email ? ` · ${active.email}` : ''}` : 'No ChatGPT account is selected. Choose an enabled, authorized account below.'}>
      <span className={`ai-status ${active?.planEnabled ? 'ai-active' : ''}`}>{active?.planEnabled ? '● In use' : '○ Not selected'}</span>
    </SettingRow>
    {active && <><p className="card-description">Request account reference: {active.id.slice(0, 8)}. Conversation model: {chat.snapshot.config?.model ?? 'account default'}; account default: {active.model ?? 'not selected'}. An existing conversation keeps its own model. Workspace access is bound to this OAuth registration; Athena does not infer a workspace from your email or report a remaining-quota percentage. Compare ChatGPT Settings → Usage using this same account and workspace, including this app’s limit—not a separate Codex connection.</p><button className="button secondary" onClick={() => void desktop.openChatGPTUsage()}>Open ChatGPT Usage</button></>}

    <SettingRow title="Coding execution backend" description="Only project-linked coding conversations use this selection. General ChatGPT conversation remains on Athena’s existing subscription connection. Codex uses the account already signed in to the official CLI; it is not an automatic fallback or an API key.">
      <CustomSelect ariaLabel="ChatGPT coding execution backend" value={codingBackend} disabled={busy || chatBusy} options={[
        { value: 'athena', label: 'Athena agent · ChatGPT Subscription' },
        { value: 'codex-cli', label: 'Official Codex CLI' },
      ]} onChange={(value) => { void updateSettings({ chatGPTCodingBackend: value as 'athena' | 'codex-cli' }) }} />
    </SettingRow>
    <SettingRow title="Codex CLI status" description={codexStatus.authenticated ? `${codexStatus.version ?? 'Version unknown'} · ${codexStatus.identity ?? 'Account identity unavailable'} · ${codexStatus.models.length} models. This is a separate signed-in Codex connection; Athena never reads or copies its credential files.` : codexStatus.message}>
      <button className="button secondary" disabled={checkingCodex} onClick={() => void refreshCodex()}>{checkingCodex ? 'Checking…' : 'Refresh Codex status'}</button>
    </SettingRow>
    {codingBackend === 'codex-cli' && <p className="card-description">Codex usage is enforced by OpenAI. Athena displays the CLI model catalog, not a guaranteed entitlement or fabricated remaining-usage estimate. Provider limits may still apply. The permission-preserving dynamic-tool bridge is currently capability-gated by Codex app-server; Athena reports incompatibility instead of falling back. Codex child sub-agents stay unavailable until Athena can enforce their independent iteration and output-token budgets.</p>}

    {status.accounts.length > 0 && <div className="chatgpt-account-list" aria-label="Connected ChatGPT accounts">
      {status.accounts.map((account) => <article key={account.id} className={`chatgpt-account-card${account.active ? ' is-active' : ''}`}>
        <div className="chatgpt-account-card__heading">
          <div className="chatgpt-account-card__identity">
            <textarea aria-label={`${account.label} account label`} rows={1} value={account.label} maxLength={80} disabled={busy} onChange={(event) => updateAccount(account.id, { label: event.target.value })} onBlur={(event) => {
            const label = event.currentTarget.value.trim()
              if (label) void run(() => desktop.renameChatGPTAccount({ accountId: account.id, label }))
            }} />
            <span>{account.email ?? 'Email not provided by OpenAI'} · Account reference {account.id.slice(0, 8)}</span>
          </div>
          <span className={`ai-status ${account.planEnabled ? 'ai-active' : ''}`}>{account.active ? '● Active account' : account.enabled ? account.planEnabled ? '● Connected' : '○ Reconnect required' : '○ Disabled'}</span>
        </div>
        <div className="chatgpt-account-card__controls">
          <label className="chatgpt-account-enabled"><input type="checkbox" checked={account.enabled} disabled={busy || account.active} onChange={(event) => void run(() => desktop.setChatGPTAccountEnabled({ accountId: account.id, enabled: event.target.checked }))} /> <span>Enabled</span></label>
          {!account.active && <button className="button primary" disabled={busy || chatBusy || !account.enabled || !account.planEnabled} title={chatBusy ? 'Finish or stop the current chat request before changing the active account.' : undefined} onClick={() => void run(() => desktop.selectChatGPTAccount({ accountId: account.id }))}>Use Account</button>}
          <button className="button secondary" disabled={busy} onClick={() => void run(() => desktop.reconnectChatGPTAccount({ accountId: account.id }))}>Reconnect</button>
          <button className="button secondary" disabled={busy} onClick={() => void run(() => desktop.removeChatGPTAccount({ accountId: account.id }))}>Remove</button>
        </div>
        {account.planEnabled && <div className="chatgpt-account-card__models"><button className="button secondary" disabled={busy || !account.enabled} onClick={() => void run(() => desktop.refreshChatGPTModels({ accountId: account.id }))}>Refresh models</button></div>}
      </article>)}
    </div>}

    {status.pendingAccount && <div className="chatgpt-pending-card" role="group" aria-label="Confirm ChatGPT account">
      <div><strong>Verify the account before adding it</strong><p>OpenAI authenticated <strong>{status.pendingAccount.label}</strong>{status.pendingAccount.email ? ` (${status.pendingAccount.email})` : ''}. Athena has not saved its credentials yet. If this is not the account you intended, cancel or try again and choose a different account in OpenAI’s page if offered.</p></div>
      {status.pendingAccount.sameIdentityAlreadyConnected && <p className="chatgpt-account-warning">This verified identity already has another saved registration. OpenAI supports separate registrations for distinct profiles/workspaces, but confirm this only if you intended to add a separate registration.</p>}
      <label className="chatgpt-pending-label">Athena label<input value={pendingLabel} maxLength={80} onChange={(event) => setPendingLabel(event.target.value)} /></label>
      <div className="ai-actions chatgpt-pending-actions">
        <button className="button primary" disabled={busy || !pendingLabel.trim()} onClick={() => void run(() => desktop.confirmChatGPTAccount({ pendingId: status.pendingAccount!.id, label: pendingLabel }))}>{status.pendingAccount.sameIdentityAlreadyConnected ? 'Confirm Separate Registration' : 'Confirm and Add Account'}</button>
        <button className="button secondary" disabled={busy} onClick={() => void run(() => desktop.retryAddChatGPTAccount())}>Try Another Account</button>
        <button className="button secondary" disabled={busy} onClick={() => void run(() => desktop.cancelChatGPTAccount({ pendingId: status.pendingAccount!.id }))}>Cancel</button>
      </div>
      <p className="chatgpt-account-note">Athena does not force an unsupported account-chooser parameter. If OpenAI selects an existing browser identity automatically, verify the displayed email, then use OpenAI’s own account switcher/sign-out and retry when needed.</p>
    </div>}

    {(active?.planEnabled || (codingBackend === 'codex-cli' && codexStatus.authenticated)) && reasoningModel && offeredEfforts.length > 0 && <SettingRow title="Reasoning effort" description={`Matches the active conversation model (${reasoningModel}); only settings supported by that model are offered.`}>
      <CustomSelect ariaLabel="ChatGPT Subscription reasoning effort" value={chat.snapshot.config?.effort ?? 'auto'} disabled={busy || !chat.snapshot.sessionId || chatBusy} options={offeredEfforts.map((effort) => ({ value: effort, label: effort === 'xhigh' ? 'Extra High' : effort[0].toUpperCase() + effort.slice(1) }))} onChange={(effort) => { if (chat.snapshot.sessionId) void chat.command({ action: 'configure-effort', id: chat.snapshot.sessionId, effort: effort as ReasoningEffort }) }} />
    </SettingRow>}
    <div className="ai-actions">
      <button className="button secondary" disabled={busy || Boolean(status.pendingAccount)} onClick={() => void run(() => desktop.addChatGPTAccount())}>{status.accounts.length ? 'Add ChatGPT Account' : 'Continue with ChatGPT'}</button>
    </div>
    <p className="card-description">The account chooser is provided by OpenAI’s official authorization page when available; Athena never reads browser cookies or assumes the browser’s active identity without showing it for confirmation. ChatGPT app-sharing and Codex CLI usage are separate execution paths; OpenAI controls actual model access and plan limits for both.</p>
    <div className="ai-feedback" role={notice && !status.planEnabled ? 'alert' : 'status'} aria-live="polite">{busy ? 'Working with ChatGPT…' : notice}</div>
  </Section>
}
