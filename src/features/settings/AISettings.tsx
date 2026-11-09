import { CopilotSettings } from './CopilotSettings'
import { useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Section, SettingRow } from '../../components/ui/Controls'
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

const providers = [
  { mode: 'copilot', label: 'GitHub Copilot Subscription', detail: 'Use your eligible GitHub Copilot subscription.' },
  { mode: 'subscription', label: 'ChatGPT Subscription', detail: 'Use a connected ChatGPT account.' },
  { mode: 'claude-api', label: 'Claude API', detail: 'Use a separately billed Anthropic API key.' },
  { mode: 'cursor', label: 'Cursor Subscription', detail: 'Use the signed-in Cursor CLI.' },
  { mode: 'cloud', label: 'OpenAI API Key', detail: 'Use a separately billed OpenAI API key.' },
] as const

export function AISettings() {
  const chat = useChat()
  const aiMode = useAthena((state) => state.snapshot?.settings.aiMode) ?? 'cloud'
  const backgroundTasks = useAthena((state) => state.snapshot?.settings.backgroundTasks)
  const update = useAthena((state) => state.update)
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
    void desktop.getAIStatus().then((result) => {
      if (!active) return
      setStatus(result.status); setNotice(result.message); setFailed(!result.ok); setBusy(null)
    }).catch(() => { if (active) { setNotice('Could not load AI configuration. Reopen Settings to try again.'); setFailed(true); setBusy(null) } })
    return () => { active = false; live.current = false; disconnectChat() }
  }, [aiMode])
  const run = async (label: string, operation: () => Promise<AIResult>, clearDraft = false) => {
    if (busy) return
    setBusy(label); setNotice(''); setConfirmRemove(false)
    try {
      const result = await operation()
      if (!live.current) return
      setStatus(result.status); setNotice(result.message); setFailed(!result.ok)
      if (result.ok && clearDraft) { setKey(''); setReplacing(false) }
    } catch {
      if (live.current) { setNotice('The request could not be completed. Please try again.'); setFailed(true) }
    } finally { if (live.current) setBusy(null) }
  }
  const editing = !status.hasKey || replacing
  const disabled = Boolean(busy) || !isDesktop
  return <div className="settings-page ai-settings">
    <div className="page-heading"><div><div className="eyebrow">YOUR WORKSPACE / ONLINE AI</div><h1>A connection, on your terms.</h1><p>Choose an online account or API provider for Conversation and coding agents. Floating Athena uses the model configured in My Athena.</p></div><span className="subtle-badge">ONLINE AI</span></div>
    <Section title="Online provider" description="Applies to online conversations and coding agents only.">
      <div className="ai-provider-cards" role="group" aria-label="AI execution mode">{providers.map((provider) => <button key={provider.mode} type="button" className={`ai-provider-card ${aiMode === provider.mode ? 'is-selected' : ''}`} aria-pressed={aiMode === provider.mode} onClick={() => void update({ aiMode: provider.mode })}><strong>{provider.label}</strong><span>{provider.detail}</span></button>)}</div>
      {(aiMode === 'unconfigured' || aiMode === 'local') && <p className="ai-provider-note" role="status">Your local configuration is preserved in My Athena. Choose an online provider explicitly to enable online chat.</p>}
    </Section>
    {aiMode === 'subscription' && <ChatGPTSettings />}
    {aiMode === 'claude-api' && <><ClaudeAPISettings /><GenerationSettings model={chat.snapshot.config?.model ?? status.model} /></>}
    {aiMode === 'cursor' && <CursorSettings />}
    {aiMode === 'copilot' && <CopilotSettings />}
    {aiMode === 'cloud' && <><Section title="OpenAI connection" description="Your key stays in macOS Keychain. Athena never returns a saved key to this screen.">
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
    <GenerationSettings model={chat.snapshot.config?.model ?? status.model} /></>}
    <WebToolsSettings openAIConnectionVersion={aiMode === 'cloud' ? status.lastVerifiedAt : null} />
    <AutomationPermissionsSettings />
    {backgroundTasks && <Section title="Background tasks" description="Keep independent conversations running when you switch chats or hide Athena. Local inference remains separately bounded.">
      <div className="ai-context-settings">
        <label><span>Allow concurrent conversations</span><input type="checkbox" checked={backgroundTasks.enabled} onChange={(event) => void update({ backgroundTasks: { ...backgroundTasks, enabled: event.target.checked } })} /></label>
        <label><span>Maximum concurrent conversation tasks</span><input aria-label="Maximum concurrent conversation tasks" type="number" min={1} max={6} value={backgroundTasks.maxConcurrent} onChange={(event) => { const count = Number(event.target.value); if (Number.isInteger(count) && count >= 1 && count <= 6) void update({ backgroundTasks: { ...backgroundTasks, maxConcurrent: count } }) }} /></label>
      </div>
    </Section>}
    {aiMode !== 'cursor' && <ContextSettings disabled={chat.pending || chat.snapshot.phase !== 'idle'} subscriptionMode={aiMode === 'subscription'} />}
    <SubagentSettings />
    <div className="privacy-banner"><ShieldCheck size={26} /><div><h2>Secure by design.</h2><p>Cloud credentials stay in macOS Keychain. Coding tools retain your conversation permissions.</p></div></div>
  </div>
}
