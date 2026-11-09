import { useEffect, useState } from 'react'
import { Section, SettingRow } from '../../components/ui/Controls'
import { desktop } from '../../services/desktop'
import { emptyAIStatus, type AIResult, type AIStatus } from '../../../shared/ai'

export function ClaudeAPISettings() {
  const [status, setStatus] = useState<AIStatus>({ ...emptyAIStatus(), provider: 'Claude API' })
  const [key, setKey] = useState('')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState('Loading…')
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => { let live = true; void desktop.getClaudeStatus().then((result) => { if (live) { setStatus(result.status); setNotice(result.message); setBusy(''); setFailed(!result.ok) } }).catch(() => { if (live) { setBusy(''); setNotice('Could not read the Claude API configuration from Keychain.'); setFailed(true) } }); return () => { live = false } }, [])
  const run = async (label: string, operation: () => Promise<AIResult>, clear = false) => {
    if (busy) return
    setBusy(label); setNotice('')
    try { const result = await operation(); setStatus(result.status); setNotice(result.message); setFailed(!result.ok); if (clear && result.ok) { setKey(''); setReplace(false) } }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Claude API operation failed.'); setFailed(true) }
    finally { setBusy('') }
  }
  const editing = !status.hasKey || replace
  const disabled = Boolean(busy)
  return <Section title="Claude API" description="This provider uses an Anthropic API key and separate API billing. It does not use your Claude Pro or Max subscription allowance.">
    <p className="card-description claude-subscription-policy" role="note">Anthropic’s current Claude Agent SDK policy allows third-party apps to offer claude.ai login or subscription rate limits only with prior Anthropic approval. Athena has no approved subscription integration, so Claude subscription sign-in is unavailable here. Use the Anthropic API key below for separately billed API access.</p>
    <SettingRow title="Connection status" description={status.lastVerifiedAt ? `Last verified ${new Date(status.lastVerifiedAt).toLocaleString()}. API usage limits and billing are controlled by Anthropic.` : 'No API key is active. Athena will not fall back to another provider.'}>
      <span className={`ai-status ${status.active ? 'ai-active' : ''}`}>{status.active ? '● Active' : '○ Not configured'}</span>
    </SettingRow>
    <div className="ai-key-field"><label htmlFor="claude-api-key">Anthropic API key {replace && <span>· replacement</span>}</label>{editing ? <input id="claude-api-key" type="password" value={key} autoComplete="off" spellCheck={false} maxLength={512} disabled={disabled} placeholder="Enter Anthropic API key" onChange={(event) => { setKey(event.target.value); setNotice('') }} /> : <div className="ai-key-mask" aria-label="Saved Anthropic API key, masked">sk-ant-••••••••••••</div>}<p className="card-description">The key is stored in macOS Keychain. Testing calls Anthropic’s official model-list endpoint only.</p></div>
    {status.hasKey && <p className="card-description">Choose the Claude conversation model in Chat Conversation.</p>}
    <div className="ai-actions"><button className="button secondary" disabled={disabled || (editing && !key.trim())} onClick={() => void run('Testing…', () => desktop.testClaudeConnection(editing ? { apiKey: key } : undefined))}>Test Connection</button>{editing ? <button className="button primary" disabled={disabled || !key.trim()} onClick={() => void run('Verifying & activating…', () => desktop.activateClaudeAPI({ apiKey: key }), true)}>Save & Activate</button> : <button className="button secondary" disabled={disabled} onClick={() => { setReplace(true); setNotice('') }}>Replace API Key</button>}{replace && <button className="button secondary" disabled={disabled} onClick={() => { setReplace(false); setKey('') }}>Cancel replacement</button>}{status.hasKey && <button className="button secondary" disabled={disabled} onClick={() => void run('Removing…', () => desktop.removeClaudeAPIKey(), true)}>Remove API Key</button>}</div>
    <p className="ai-feedback" role={failed ? 'alert' : 'status'} aria-live="polite">{busy || notice}</p>
  </Section>
}
