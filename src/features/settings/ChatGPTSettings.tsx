import { CodexHistory } from './CodexHistory'
import { useEffect, useState } from 'react'
import { Section, SettingRow } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { desktop } from '../../services/desktop'
import { emptyChatGPTStatus, type ChatGPTAccountStatus, type ChatGPTStatus } from '../../../shared/chatgpt'
import { modelCapabilities, type ReasoningEffort } from '../../../shared/conversations'
import { useChat } from '../../store/chatStore'
import { emptyCodexCLIStatus, type CodexCLIStatus } from '../../../shared/codex'
import '../../styles/ai.css'
import { UsageDashboard } from './UsageDashboard'
import { ProviderUsageDashboard } from './ProviderUsageDashboard'
import { observedConversationUsage } from './observedUsage'

export function ChatGPTSettings({ onAccountsChanged }: { onAccountsChanged?: () => void } = {}) {
  const chat = useChat()
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
    try { const result = await operation(); setStatus(result); setPendingLabel(result.pendingAccount?.label ?? ''); setNotice(result.message); onAccountsChanged?.() }
    catch (error) {
      setNotice(error instanceof Error ? error.message : 'ChatGPT account operation failed. Try again.')
      // Refresh cached status after a terminal token error, without retrying OAuth.
      try { setStatus(await desktop.getChatGPTStatus()); onAccountsChanged?.() } catch { /* Keep the original error. */ }
    }
    finally { setBusy(false) }
  }
  const updateAccount = (accountId: string, update: Partial<ChatGPTAccountStatus>) => setStatus((current) => ({ ...current, accounts: current.accounts.map((account) => account.id === accountId ? { ...account, ...update } : account) }))
  const active = status.accounts.find((account) => account.active)
  const chatBusy = chat.snapshot.phase !== 'idle'
  const codingBackend = 'codex-cli'
  // Keep Settings in lockstep with the reasoning selector in the conversation.
  // Existing sessions can retain their own model even if the account default differs.
  const reasoningModel = chat.snapshot.config?.model ?? active?.model ?? null
  const codexEfforts = codexStatus.models.find((model) => model.id === reasoningModel)?.efforts ?? []
  const codexUsageActive = codingBackend === 'codex-cli'
  const observed = observedConversationUsage(chat.snapshot.messages, codexUsageActive ? ['codex-subscription'] : ['chatgpt-subscription'], codexUsageActive ? null : active?.id ?? 'no-active-chatgpt-account')
  const offeredEfforts = codingBackend === 'codex-cli'
    ? [...new Set<ReasoningEffort>(['auto', ...codexEfforts])]
    : reasoningModel ? modelCapabilities(reasoningModel).efforts : []
  const refreshCodex = async () => {
    if (checkingCodex) return
    setCheckingCodex(true)
    try { const result = await desktop.getCodexCLIStatus({ refresh: true }); setCodexStatus(result); setNotice(result.message) }
    catch { setNotice('Codex CLI status could not be refreshed.') }
    finally { setCheckingCodex(false) }
  }
  return <>
  <Section title="ChatGPT Subscription" description="Connect one ChatGPT account. Sign-in uses OpenAI’s official browser flow; Athena verifies the returned identity before saving the account. OAuth credentials remain in macOS Keychain and are never exposed to the renderer.">
    <SettingRow title="Active account" description={active ? `${active.label}${active.email ? ` · ${active.email}` : ''}` : 'No ChatGPT account is selected. Choose an enabled, authorized account below.'}>
      <span className={`ai-status ${active?.planEnabled && active.connected ? 'ai-active' : ''}`}>{active && !active.connected ? '○ Reconnect required' : active?.planEnabled ? '● In use' : '○ Not selected'}</span>
    </SettingRow>
    {active && <p className="card-description">Request account reference: {active.id.slice(0, 8)}. Conversation model: {chat.snapshot.config?.model ?? 'account default'}; account default: {active.model ?? 'not selected'}. An existing conversation keeps its own model. Workspace access is bound to this OAuth registration; Athena does not infer a workspace from your email or report a remaining-quota percentage.</p>}

    <SettingRow title="Execution engine" description="All ChatGPT subscription conversations use native Codex threads, tools, sandboxing, approvals, and context management. Historical Athena messages are preserved without replaying old tasks."><span>Codex App Server</span></SettingRow>
    <SettingRow title="Codex CLI status" description={codexStatus.authenticated ? `${codexStatus.version ?? 'Version unknown'} · ${codexStatus.identity ?? 'Account identity unavailable'} · ${codexStatus.models.length} models. This is a separate signed-in Codex connection; Athena never reads or copies its credential files.` : codexStatus.message}>
      <button className="button secondary" disabled={checkingCodex || chatBusy} onClick={() => void desktop.codexCommand({action:'login'}).then(r=>setNotice(r.message ?? 'Sign-in opened.')).catch(()=>setNotice('Could not start Codex sign-in.'))}>Sign in to Codex</button><button className="button secondary" disabled={checkingCodex} onClick={() => void refreshCodex()}>{checkingCodex ? 'Checking…' : 'Refresh Codex status'}</button>
    </SettingRow>
    {codingBackend === 'codex-cli' && <p className="card-description">Codex usage is enforced by OpenAI. Athena displays the CLI model catalog, not a guaranteed entitlement or fabricated remaining-usage estimate. Provider limits may still apply. Codex owns native tools and sub-agents. Local CLI configuration, project instructions, and skills apply. Athena forwards approval requests without overriding your decision. No API-key fallback is used.</p>}

    <CodexHistory />
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
          <span className={`ai-status ${account.planEnabled && account.connected ? 'ai-active' : ''}`}>{!account.connected ? '○ Reconnect required' : account.active ? '● Active account' : account.enabled ? account.planEnabled ? '● Connected' : '○ Reconnect required' : '○ Disabled'}</span>
        </div>
        <div className="chatgpt-account-card__controls">
          <label className="chatgpt-account-enabled"><input type="checkbox" checked={account.enabled} disabled={busy || account.active} onChange={(event) => void run(() => desktop.setChatGPTAccountEnabled({ accountId: account.id, enabled: event.target.checked }))} /> <span>Enabled</span></label>
          {!account.active && <button className="button primary" disabled={busy || chatBusy || !account.enabled || !account.planEnabled || !account.connected} title={chatBusy ? 'Finish or stop the current chat request before changing the active account.' : undefined} onClick={() => void run(() => desktop.selectChatGPTAccount({ accountId: account.id }))}>Use Account</button>}
          <button className="button secondary" disabled={busy} onClick={() => void run(() => desktop.reconnectChatGPTAccount({ accountId: account.id }))}>Reconnect</button>
          <button className="button secondary" disabled={busy} onClick={() => void run(() => desktop.removeChatGPTAccount({ accountId: account.id }))}>Remove</button>
        </div>
        {account.planEnabled && <div className="chatgpt-account-card__models"><button className="button secondary" disabled={busy || !account.enabled || !account.connected} onClick={() => void run(() => desktop.refreshChatGPTModels({ accountId: account.id }))}>Refresh models</button></div>}
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
      <button className="button secondary" disabled={busy || Boolean(status.pendingAccount) || status.accounts.length > 0} onClick={() => void run(() => desktop.addChatGPTAccount())}>Continue with ChatGPT</button>
    </div>
    <p className="card-description">The account chooser is provided by OpenAI’s official authorization page when available; Athena never reads browser cookies or assumes the browser’s active identity without showing it for confirmation. ChatGPT app-sharing and Codex CLI usage are separate execution paths; OpenAI controls actual model access and plan limits for both.</p>
    <div className="ai-feedback" role={notice && !status.planEnabled ? 'alert' : 'status'} aria-live="polite">{busy ? 'Working with ChatGPT…' : notice}</div>
  </Section>
  {codexUsageActive ? <UsageDashboard data={{ provider: 'ChatGPT Subscription', account: codexUsageActive ? `Codex CLI · ${codexStatus.identity ?? 'identity not exposed'}` : active ? `${active.label}${active.email ? ` · ${active.email}` : ''}` : 'No active ChatGPT account', usageType: 'Locally observed response usage · subscription quota is not exposed', availability: active?.planEnabled || codexUsageActive ? observed.metrics.length ? 'partial' : 'unavailable' : 'authentication-required', source: 'OpenAI response metadata where returned; scoped to this conversation and account', refreshedAt: observed.updatedAt, metrics: observed.metrics, officialUrl: 'https://chatgpt.com/settings/usage', officialLabel: 'Open ChatGPT Usage', explanation: 'Athena’s supported ChatGPT subscription integration does not expose an app-specific quota endpoint. These local response metrics are not ChatGPT plan allowance and are separate from OpenAI API billing. Refresh Usage reloads the saved conversation snapshot; it does not query ChatGPT plan quota. Interrupted requests may be billed; token usage remains unknown when no receipt was returned.' }} onRefresh={chat.refresh} /> : <ProviderUsageDashboard provider="chatgpt-subscription" account={active ? `${active.label}${active.email ? ` · ${active.email}` : ''}` : 'No active account'} accountId={active?.id ?? 'not-connected'} connected={Boolean(active?.connected && active.planEnabled)} />}
  </>
}
