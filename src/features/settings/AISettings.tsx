import { CopilotSettings } from './CopilotSettings'
import { useEffect, useRef, useState } from 'react'
import { Bot, Cloud, Github, RefreshCw, ShieldCheck } from 'lucide-react'
import { Section, SettingRow, Toggle } from '../../components/ui/Controls'
import { desktop, isDesktop } from '../../services/desktop'
import { emptyAIStatus, type AIResult } from '../../../shared/ai'
import '../../styles/ai.css'
import { GenerationSettings } from './GenerationSettings'
import { ContextSettings } from './ContextSettings'
import { connectChat, useChat } from '../../store/chatStore'
import { useAthena } from '../../store/athenaStore'
import { ChatGPTSettings } from './ChatGPTSettings'
import { ClaudeAPISettings } from './ClaudeAPISettings'
import { CursorSettings } from './CursorSettings'
import { WebToolsSettings } from './WebToolsSettings'
import { SubagentSettings } from './SubagentSettings'
import { AutomationPermissionsSettings } from './AutomationPermissionsSettings'
import { AntigravitySettings } from './AntigravitySettings'
import { ProviderUsageDashboard } from './ProviderUsageDashboard'
import { ThirdPartyInferenceSettings } from './ThirdPartyInferenceSettings'
import { accountPreferenceKey, type AccountProvider, type UnifiedAccountCatalog } from '../../../shared/unifiedAccounts'

const providers = [
  { mode: 'copilot', label: 'GitHub Copilot Subscription', detail: 'Use your eligible GitHub Copilot subscription.' },
  { mode: 'antigravity', label: 'Google Antigravity Subscription', detail: 'Use Google’s official Antigravity ACP runtime.' },
  { mode: 'subscription', label: 'ChatGPT Subscription', detail: 'Use a connected ChatGPT account.' },
  { mode: 'claude-api', label: 'Claude API', detail: 'Use a separately billed Anthropic API key.' },
  { mode: 'third-party', label: 'Third-Party Inference', detail: 'Use an independent gateway, cloud endpoint, or custom model connection.' },
  { mode: 'cursor', label: 'Cursor Subscription', detail: 'Use the signed-in Cursor CLI.' },
  { mode: 'cloud', label: 'OpenAI API Key', detail: 'Use a separately billed OpenAI API key.' },
] as const

let savedAccountCatalog: UnifiedAccountCatalog | null = null
let firstAccountLoad: Promise<UnifiedAccountCatalog> | null = null

async function loadAccountCatalog(refresh: boolean): Promise<UnifiedAccountCatalog> {
  let result = await desktop.getUnifiedAccounts(refresh ? { refresh: true } : undefined)
  // A provider may finish its first Keychain read after the status deadline.
  for (let attempt = 0; result.incomplete && attempt < 2; attempt += 1) {
    result = await desktop.getUnifiedAccounts({ refresh: true })
  }
  savedAccountCatalog = result
  return result
}

function loadAccountCatalogOnce(): Promise<UnifiedAccountCatalog> {
  if (savedAccountCatalog) return Promise.resolve(savedAccountCatalog)
  if (!firstAccountLoad) {
    firstAccountLoad = loadAccountCatalog(true).finally(() => { firstAccountLoad = null })
  }
  return firstAccountLoad
}

export function AISettings() {
  const chat = useChat()
  const aiMode = useAthena((state) => state.snapshot?.settings.aiMode) ?? 'cloud'
  const backgroundTasks = useAthena((state) => state.snapshot?.settings.backgroundTasks)
  const update = useAthena((state) => state.update)
  const accountEnabledPreferences = useAthena((state) => state.snapshot?.settings.unifiedAccountEnabled ?? {})
  const [selectedPanel, setSelectedPanel] = useState<AccountProvider>('cloud')
  const [showAdd, setShowAdd] = useState(false)
  const [catalog, setCatalog] = useState<UnifiedAccountCatalog>(() => savedAccountCatalog ?? { accounts: [], refreshedAt: 0 })
  const [catalogLoading, setCatalogLoading] = useState(() => !savedAccountCatalog)
  const [accountsRefreshing, setAccountsRefreshing] = useState(false)
  const accountRefreshCount = useRef(0)
  const catalogMounted = useRef(true)
  const [accountToggleBusy, setAccountToggleBusy] = useState<string | null>(null)
  const [accountToggleNotice, setAccountToggleNotice] = useState('')
  const refreshAccounts = async (refresh = false, firstVisit = false) => {
    accountRefreshCount.current += 1
    setAccountsRefreshing(true)
    try {
      const result = firstVisit ? await loadAccountCatalogOnce() : await loadAccountCatalog(refresh)
      if (catalogMounted.current) setCatalog(result)
    }
    catch { /* Existing account panels remain available. */ }
    finally {
      if (catalogMounted.current) setCatalogLoading(false)
      accountRefreshCount.current -= 1
      if (catalogMounted.current) setAccountsRefreshing(accountRefreshCount.current > 0)
    }
  }
  const toggleAccount = async (account: UnifiedAccountCatalog['accounts'][number], enabled: boolean) => {
    const key = accountPreferenceKey(account.route)
    setAccountToggleBusy(key); setAccountToggleNotice('')
    try {
      if (account.route.provider === 'third-party') {
        const result = await desktop.inferenceConnections({ action: 'set-enabled', id: account.route.accountId, enabled })
        if (!result.ok) throw new Error(result.message)
      }
      const currentPreferences = useAthena.getState().snapshot?.settings.unifiedAccountEnabled ?? accountEnabledPreferences
      await update({ unifiedAccountEnabled: { ...currentPreferences, [key]: enabled } })
      setCatalog(current => {
        const next = { ...current, accounts: current.accounts.map(item => accountPreferenceKey(item.route) === key ? { ...item, enabled } : item) }
        savedAccountCatalog = next
        return next
      })
      void refreshAccounts(true)
      setAccountToggleNotice(`${account.name} ${enabled ? 'enabled' : 'disabled'}.`)
    } catch (error) {
      setAccountToggleNotice(error instanceof Error ? error.message : `Could not ${enabled ? 'enable' : 'disable'} ${account.name}.`)
    } finally { setAccountToggleBusy(null) }
  }
  useEffect(() => {
    catalogMounted.current = true
    if (!savedAccountCatalog) void refreshAccounts(true, true)
    return () => { catalogMounted.current = false }
  }, [])
  const [status, setStatus] = useState(emptyAIStatus)
  // Draft secrets are component-local, never part of Zustand or persisted renderer state.
  const [key, setKey] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState<string | null>('Loading…')
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    const disconnectChat = connectChat()
    let active = true
    live.current = true
    void desktop.getOpenAIAccountStatus().then((result) => {
      if (!active) return
      setStatus(result.status); setNotice(result.message); setFailed(!result.ok); setBusy(null)
    }).catch(() => { if (active) { setNotice('Could not load AI configuration. Reopen Settings to try again.'); setFailed(true); setBusy(null) } })
    return () => { active = false; live.current = false; disconnectChat() }
  }, [])
  const run = async (label: string, operation: () => Promise<AIResult>, clearDraft = false) => {
    if (busy) return
    setBusy(label); setNotice(''); setConfirmRemove(false)
    try {
      const result = await operation()
      if (!live.current) return
      setStatus(result.status); setNotice(result.message); setFailed(!result.ok)
      if (result.ok) void refreshAccounts()
      if (result.ok && clearDraft) { setKey(''); setReplacing(false) }
    } catch {
      if (live.current) { setNotice('The request could not be completed. Please try again.'); setFailed(true) }
    } finally { if (live.current) setBusy(null) }
  }
  const editing = !status.hasKey || replacing
  const disabled = Boolean(busy) || !isDesktop
  return <div className="settings-page ai-settings">
    <div className="page-heading"><div><div className="eyebrow">YOUR WORKSPACE / ONLINE AI</div><h1>Connected AI accounts.</h1><p>Connect an account here, then choose any available model directly in the conversation composer. Floating Athena uses the model configured in My Athena.</p></div><span className="subtle-badge">ONLINE AI</span></div>
    <Section title="Connected Accounts" description="Models from connected accounts appear together in Chat Conversation. Subscription plan names appear only when an integration verifies them.">
      <div className="ai-actions"><button className="button primary" onClick={() => setShowAdd(value => !value)}>{showAdd ? 'Close account options' : 'Add Account'}</button><button className="button secondary" disabled={accountsRefreshing} onClick={() => void refreshAccounts(true)}><RefreshCw size={15}/> {accountsRefreshing ? 'Refreshing accounts…' : 'Refresh accounts and models'}</button></div>
      {catalog.accounts.length ? <div className="connected-account-list">{catalog.accounts.map(account => { const key = accountPreferenceKey(account.route); const openAIAPI = account.route.provider === 'cloud' && account.route.accountId === 'openai-api'; const availableModels = account.models.filter(model => model.available).length; const modelCount = openAIAPI ? `${availableModels} GPT model${availableModels === 1 ? '' : 's'} available` : `${availableModels} available models`; return <div key={key} className={`connected-account-card ${account.enabled ? '' : 'is-disabled'}`}><button type="button" className="connected-account-details" onClick={() => setSelectedPanel(account.route.provider)} aria-label={`Manage ${account.name}`}><span className="connected-account-icon">{account.route.provider === 'copilot' ? <Github size={19}/> : account.route.provider === 'cloud' || account.route.provider === 'third-party' ? <Cloud size={19}/> : <Bot size={19}/>}</span><span><strong>{account.name}{account.plan ? ` (${account.plan})` : ''}</strong><small>{[account.identity, modelCount, account.lastVerifiedAt ? `Verified ${new Date(account.lastVerifiedAt).toLocaleString()}` : ''].filter(Boolean).join(' · ')}</small></span></button><div className="connected-account-actions"><span className={`ai-status ${account.state === 'connected' ? 'ai-active' : ''}`}>{account.state}</span><div className="connected-account-toggle"><Toggle checked={account.enabled} label={`Enable ${account.name}`} disabled={accountToggleBusy === key || !isDesktop} onChange={enabled => void toggleAccount(account, enabled)}/><small>{account.enabled ? 'ON' : 'OFF'}</small></div></div></div> })}</div> : <p className="card-description">{catalogLoading ? 'Loading connected accounts…' : 'No connected AI accounts found. Add one below to make its models available in chat.'}</p>}
      {catalogLoading && catalog.accounts.length > 0 && <p className="connected-account-notice" role="status">Checking remaining accounts…</p>}
      {!catalogLoading && catalog.incomplete && <p className="connected-account-notice" role="status">Some account checks are still unavailable. Refresh accounts and models to try again.</p>}
      {!catalogLoading && !catalog.incomplete && !catalog.accounts.some(account => account.route.provider === 'subscription') && <p className="connected-account-notice" role="status">No ChatGPT Subscription account is saved in Athena. Choose Add Account → ChatGPT Subscription and finish sign-in; refreshing only reloads accounts already connected here.</p>}
      {accountToggleNotice && <p className="connected-account-notice" role="status">{accountToggleNotice}</p>}
      {showAdd && <div className="ai-provider-cards" role="group" aria-label="Add AI account">{providers.map(provider => <button key={provider.mode} type="button" className={`ai-provider-card ${selectedPanel === provider.mode ? 'is-selected' : ''}`} onClick={() => { setSelectedPanel(provider.mode); setShowAdd(false) }}><strong>{provider.label}</strong><span>{provider.detail}</span></button>)}<div className="ai-provider-card" role="note"><strong>Claude Subscription</strong><span>Subscription sign-in is unavailable because Athena does not have Anthropic approval for third-party Claude plan access. Claude API remains available separately.</span></div></div>}
      <p className="card-description">Manage the selected account below. Existing conversations retain their history if an account is disconnected.</p>
    </Section>
    {selectedPanel === 'third-party' && <ThirdPartyInferenceSettings active />}
    {selectedPanel === 'subscription' && <ChatGPTSettings onAccountsChanged={() => void refreshAccounts(true)} />}
    {selectedPanel === 'claude-api' && <><ClaudeAPISettings /><GenerationSettings model={chat.snapshot.config?.model ?? status.model} /></>}
    {selectedPanel === 'cursor' && <CursorSettings />}
    {selectedPanel === 'copilot' && <CopilotSettings />}
    {selectedPanel === 'antigravity' && <AntigravitySettings selectedModel={chat.snapshot.config?.model ?? null} />}
    {selectedPanel === 'cloud' && <><Section title="OpenAI connection" description="Your key stays in macOS Keychain. Athena never returns a saved key to this screen.">
      <SettingRow title="Status" description={status.lastVerifiedAt ? `Last verified ${new Date(status.lastVerifiedAt).toLocaleString()}. Activation is saved, not a live availability guarantee.` : 'AI stays disabled until a connection succeeds and the key is saved.'}>
        <span className={`ai-status ${status.active ? 'ai-active' : ''}`}><span aria-hidden="true">{status.active ? '●' : '○'}</span> {status.active ? 'Active' : 'Not configured'}</span>
      </SettingRow>
      <div className="ai-key-field">
        <label htmlFor="openai-key">API Key {replacing && <span>· replacement</span>}</label>
        {editing ? <input id="openai-key" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="Enter OpenAI API key" value={key} disabled={disabled} maxLength={512} onChange={(event) => { setKey(event.target.value); setNotice('') }} aria-describedby="ai-key-help" />
          : <div id="openai-key" className="ai-key-mask" aria-label="Saved API key, masked">sk-••••••••••••••</div>}
        <p id="ai-key-help" className="card-description">Testing sends this key only to api.openai.com to list available models. No conversation or desktop content is sent. A successful test does not verify billing or generation access.</p>
      </div>
      {status.hasKey && <p className="card-description">Choose the OpenAI conversation model in Chat Conversation.</p>}
      <div className="ai-actions">
        <button className="button secondary" disabled={disabled || (editing && !key.trim())} onClick={() => void run('Testing…', () => desktop.testAIConnection(editing ? { apiKey: key } : undefined))}>Test Connection</button>
        {editing && <button className="button primary" disabled={disabled || !key.trim()} onClick={() => void run('Testing & activating…', () => desktop.activateAI({ apiKey: key }), true)}>Save & Activate</button>}
        {!editing && <button className="button secondary" disabled={disabled} onClick={() => { setReplacing(true); setNotice(''); setConfirmRemove(false) }}>Replace API Key</button>}
        {replacing && <button className="button secondary" disabled={disabled} onClick={() => { setKey(''); setReplacing(false); setNotice('') }}>Cancel replacement</button>}
        {(status.hasKey || failed) && <button className="button secondary" disabled={disabled} onClick={() => setConfirmRemove(true)}>Remove API Key</button>}
      </div>
      {confirmRemove && <div className="ai-removal" role="group" aria-label="Confirm API key removal"><p>Remove the saved OpenAI key from macOS Keychain? AI will be disabled. This does not revoke the key on OpenAI.</p><button className="button secondary" onClick={() => setConfirmRemove(false)}>Cancel</button><button className="button primary" onClick={() => void run('Removing…', () => desktop.removeAIKey(), true)}>Confirm removal</button></div>}
      <div className="ai-feedback" role={failed && !busy ? 'alert' : 'status'} aria-live="polite">{busy || notice}</div>
    </Section>
    <ProviderUsageDashboard provider="openai-api" account={status.hasKey ? "Saved API key · account-scoped local receipts" : "Not configured"} connected={status.active} connectionVersion={status.lastVerifiedAt} />
    <GenerationSettings model={chat.snapshot.config?.model ?? status.model} /></>}
    <WebToolsSettings openAIConnectionVersion={status.lastVerifiedAt} />
    <AutomationPermissionsSettings />
    {backgroundTasks && <Section title="Background tasks" description="Keep independent conversations running when you switch chats or hide Athena. Local inference remains separately bounded.">
      <div className="ai-context-settings">
        <label><span>Allow concurrent conversations</span><input type="checkbox" checked={backgroundTasks.enabled} onChange={(event) => void update({ backgroundTasks: { ...backgroundTasks, enabled: event.target.checked } })} /></label>
        <label><span>Maximum concurrent conversation tasks</span><input aria-label="Maximum concurrent conversation tasks" type="number" min={1} max={6} value={backgroundTasks.maxConcurrent} onChange={(event) => { const count = Number(event.target.value); if (Number.isInteger(count) && count >= 1 && count <= 6) void update({ backgroundTasks: { ...backgroundTasks, maxConcurrent: count } }) }} /></label>
      </div>
    </Section>}
    <ContextSettings catalog={catalog} provider={chat.snapshot.config?.accountRoute?.provider ?? aiMode} disabled={chat.pending || chat.snapshot.phase !== 'idle'} subscriptionMode={(chat.snapshot.config?.accountRoute?.provider ?? aiMode) === 'subscription'} />
    <SubagentSettings catalog={catalog} />
    <div className="privacy-banner"><ShieldCheck size={26} /><div><h2>Secure by design.</h2><p>Cloud credentials stay in macOS Keychain. Coding tools retain your conversation permissions.</p></div></div>
  </div>
}
