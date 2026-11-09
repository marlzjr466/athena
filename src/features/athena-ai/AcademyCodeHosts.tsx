import { useEffect, useState } from 'react'
import { Section, SettingRow } from '../../components/ui/Controls'
import { desktop } from '../../services/desktop'
import type { AcademyCodeHost, AcademyIntegrationStatus, AcademyReviewEvidence } from '../../../shared/academyIntegrations'

const labels = { github: 'GitHub', gitlab: 'GitLab' } as const

/** Explicit, read-only code-host access. Secrets are sent once to main and never persisted in renderer storage. */
export function AcademyCodeHosts() {
  const [statuses, setStatuses] = useState<AcademyIntegrationStatus[]>([])
  const [tokens, setTokens] = useState<Record<AcademyCodeHost, string>>({ github: '', gitlab: '' })
  const [repository, setRepository] = useState<Record<AcademyCodeHost, string>>({ github: '', gitlab: '' })
  const [numbers, setNumbers] = useState<Record<AcademyCodeHost, string>>({ github: '', gitlab: '' })
  const [reviews, setReviews] = useState<Partial<Record<AcademyCodeHost, AcademyReviewEvidence>>>({})
  const [busy, setBusy] = useState<AcademyCodeHost | null>(null)
  const [notice, setNotice] = useState('')
  const available = typeof desktop.getAcademyIntegrations === 'function' && typeof desktop.academyIntegrationCommand === 'function'
  useEffect(() => {
    if (!available) { setNotice('Code-host connections will be available after the next authorized Athena app restart.'); return }
    let mounted = true
    void desktop.getAcademyIntegrations().then(value => { if (mounted) setStatuses(value) }).catch(() => { if (mounted) setNotice('Code-host status is unavailable.') })
    return () => { mounted = false }
  }, [available])
  const run = async (provider: AcademyCodeHost, action: 'connect' | 'disconnect' | 'inspect-review') => {
    if (!available) { setNotice('Restart Athena to load the new code-host connection service.'); return }
    setBusy(provider); setNotice('')
    try {
      const input = action === 'connect' ? { action, provider, token: tokens[provider] }
        : action === 'inspect-review' ? { action, provider, repository: repository[provider].trim(), number: Number(numbers[provider]) }
          : { action, provider }
      const result = await desktop.academyIntegrationCommand(input)
      setStatuses(result.statuses)
      if (action === 'disconnect') setReviews(current => ({ ...current, [provider]: undefined }))
      if (result.review) setReviews(current => ({ ...current, [provider]: result.review }))
      setNotice(result.message ?? (result.ok ? `${labels[provider]} ${action === 'connect' ? 'connected' : action === 'disconnect' ? 'disconnected' : 'review loaded'}.` : 'Request did not complete.'))
    } catch { setNotice(`${labels[provider]} request failed. Check the connection and try again.`) }
    finally { if (action === 'connect') setTokens(current => ({ ...current, [provider]: '' })); setBusy(null) }
  }
  return <Section title="Code-host integrations" description="Optional read-only GitHub and GitLab review inspection. Credentials stay in macOS Keychain and are not given to the local model. No repository or ticket is modified.">
    {(['github', 'gitlab'] as const).map(provider => {
      const status = statuses.find(item => item.provider === provider)
      const review = reviews[provider]
      return <div className="academy-code-host" key={provider}>
        <SettingRow title={labels[provider]} description={status?.connected ? status.error ? `Saved credential cannot be verified: ${status.error}` : `Connected${status.account ? ` as ${status.account}` : ''}. Read-only review lookup.` : 'Not connected. Use a token limited to read access for repositories you choose.'}>
          {status?.connected ? <button type="button" className="button secondary" aria-label={`Disconnect ${labels[provider]}`} disabled={busy !== null || !available} onClick={() => void run(provider, 'disconnect')}>Disconnect</button> : <div className="academy-integration-controls"><input aria-label={`${labels[provider]} access token`} type="password" autoComplete="off" spellCheck={false} value={tokens[provider]} onChange={event => setTokens(current => ({ ...current, [provider]: event.target.value }))} placeholder="Read-only access token" disabled={!available} /><button type="button" className="button secondary" aria-label={`Connect ${labels[provider]}`} disabled={!available || busy !== null || tokens[provider].trim().length < 8} onClick={() => void run(provider, 'connect')}>Connect</button></div>}
        </SettingRow>
        {status?.connected && <div className="academy-integration-controls"><input aria-label={`${labels[provider]} repository`} value={repository[provider]} onChange={event => setRepository(current => ({ ...current, [provider]: event.target.value }))} placeholder={provider === 'github' ? 'owner/repository' : 'group/project'} /><input aria-label={`${labels[provider]} review number`} type="number" min="1" value={numbers[provider]} onChange={event => setNumbers(current => ({ ...current, [provider]: event.target.value }))} placeholder={provider === 'github' ? 'PR number' : 'MR number'} /><button type="button" className="button secondary" disabled={busy !== null || !repository[provider].trim() || !Number.isSafeInteger(Number(numbers[provider])) || Number(numbers[provider]) < 1} onClick={() => void run(provider, 'inspect-review')}>Inspect {provider === 'github' ? 'PR' : 'MR'}</button></div>}
        {review && <div className="academy-review-evidence"><strong>{review.title}</strong><span>{review.repository} · #{review.number} · {review.state}{review.pipelineStatus ? ` · pipeline ${review.pipelineStatus}` : ''} · {review.author}</span><p>{review.description || 'No description supplied.'}</p><button type="button" className="button secondary" onClick={() => void desktop.openExternalLink({ url: review.url })}>Open on {labels[provider]}</button></div>}
      </div>
    })}
    <p className="chat-message-note">Jira Cloud account access needs a registered OAuth integration; Athena does not collect Atlassian API tokens. Jira guidance can still analyze ticket text you explicitly provide or approve as local knowledge.</p>
    {notice && <p className="chat-message-note" role="status">{notice}</p>}
  </Section>
}
