import { useEffect, useRef, useState } from 'react'
import { Section, SettingRow } from '../../components/ui/Controls'
import { desktop, isDesktop } from '../../services/desktop'
import type { AntigravityStatus } from '../../../shared/antigravity'
import { UsageDashboard } from './UsageDashboard'
import type { UsageDashboardData } from '../../../shared/usage'

const initial: AntigravityStatus = { installed: false, version: null, authState: 'unknown', identity: null, models: [], modelEfforts: {}, modelEffortDefaults: {}, modelCatalogAvailable: false, usage: null, usageError: null, message: 'Checking for the official Antigravity CLI…' }
let cachedStatus: AntigravityStatus | null = null

export function AntigravitySettings({ selectedModel }: { selectedModel: string | null }) {
  const [status, setStatus] = useState(() => cachedStatus ?? initial)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [usageBusy, setUsageBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  const activeActions = useRef(new Set<string>())
  const updateStatus = (next: AntigravityStatus) => { cachedStatus = next; if (mounted.current) setStatus(next) }
  const refresh = async (action: 'status' | 'refresh' | 'usage' | 'login' | 'logout') => {
    if (activeActions.current.has(action)) return
    if (action !== 'usage' && connectionBusy || action === 'usage' && usageBusy) return
    activeActions.current.add(action)
    if (action === 'usage') setUsageBusy(true); else if (action !== 'status') setConnectionBusy(true)
    if (action !== 'status') setNotice('')
    try {
      const result = await desktop.antigravity({ action })
      if (!result || !Array.isArray(result.models)) throw new Error('Antigravity returned an invalid status response.')
      updateStatus(result)
      if (mounted.current) setNotice(action === 'usage' ? result.usageError ?? '' : action === 'status' ? '' : result.message)
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : ''
      if (mounted.current) setNotice(message || (action === 'usage' ? 'Antigravity usage could not be refreshed.' : 'Antigravity ACP could not complete the request.'))
    } finally {
      activeActions.current.delete(action)
      if (mounted.current) { if (action === 'usage') setUsageBusy(false); else if (action !== 'status') setConnectionBusy(false) }
    }
  }
  useEffect(() => {
    mounted.current = true
    // The main process returns its cached status and only discovers the CLI on first launch.
    void refresh('status')
    return () => { mounted.current = false }
  }, [])
  const modelIds = new Set(status.models.flatMap(model => [model.id.toLowerCase(), model.name.toLowerCase()]))
  const isModelGroup = (id: string, name: string) => modelIds.has(id.toLowerCase()) || modelIds.has(name.toLowerCase())
  const sharedGroups = (status.usage?.groups ?? []).flatMap(group => {
    const individualGroup = isModelGroup(group.id, group.name)
    const sharedBuckets = individualGroup ? [] : group.buckets.filter(bucket => !isModelGroup(bucket.id, bucket.name))
    return sharedBuckets.length ? [{ ...group, buckets: sharedBuckets }] : []
  })
  const individualQuotas = (status.usage?.groups ?? []).flatMap(group => {
    if (isModelGroup(group.id, group.name)) return [{ name: group.name, buckets: group.buckets }]
    const buckets = group.buckets.filter(bucket => isModelGroup(bucket.id, bucket.name))
    return buckets.length ? [{ name: buckets[0].name, buckets }] : []
  })
  const usageGroups = status.usage ? [
    { id: 'shared', label: 'Shared Quota Groups', groups: sharedGroups },
    { id: 'models', label: 'Individual Model Quotas', groups: individualQuotas },
  ].map(group => ({ id: group.id, label: group.label, quotas: group.groups.flatMap(entry => entry.buckets.map(bucket => ({
    id: `${entry.name}-${bucket.id}-${bucket.window}`, label: entry.name,
    remainingPercentage: bucket.remainingFraction === null ? null : Math.round(bucket.remainingFraction * 100),
    usedLabel: `${bucket.name} · ${bucket.window}${bucket.remainingFraction === null ? '' : ` · ${Math.round((1 - bucket.remainingFraction) * 100)}% used`}`,
    resetAt: bucket.resetAt, detail: bucket.description,
  }))) })).filter(group => group.quotas.length) : []
  const usageData: UsageDashboardData = {
    provider: 'Google Antigravity Subscription', account: status.authState === 'authenticated' ? 'Managed by Antigravity' : 'Not authenticated',
    usageType: 'Subscription quota', source: "Google's documented Antigravity CLI structured usage commands",
    availability: status.authState !== 'authenticated' ? 'authentication-required' : status.usage ? status.usageError ? 'partial' : 'available' : 'unavailable',
    refreshedAt: status.usage?.fetchedAt ?? null, error: status.usageError,
    explanation: `Quota pools and reset times are shown only when Google's authenticated CLI returns them.${status.usage?.useG1Credits === null || status.usage?.useG1Credits === undefined ? '' : ` Overages: ${status.usage.useG1Credits ? 'Always' : 'Never'}.`}`,
    quotaGroups: usageGroups,
    metrics: status.usage?.creditsRemaining === null || status.usage?.creditsRemaining === undefined ? [] : [{ id: 'credits-remaining', label: 'AI credit balance', value: status.usage.creditsRemaining, unit: 'credits', detail: 'Reported by Antigravity CLI' }],
    officialUrl: 'https://antigravity.google/docs/cli/commands/usage', officialLabel: 'Antigravity usage documentation',
  }

  return <>
    <Section title="Google Antigravity Subscription · Official ACP" description="Athena launches Google’s unmodified agy ACP agent. The agent keeps its own native Google sign-in and subscription controls; Athena never reads or stores Antigravity credentials.">
    <SettingRow title="Antigravity CLI" description={`${status.message}${status.version ? ` · ${status.version}` : ''}`}>
      <span className={`ai-status ${status.authState === 'authenticated' ? 'ai-active' : ''}`}>{connectionBusy ? '○ Connecting…' : status.authState === 'authenticated' ? '● Connected' : status.installed ? '○ Sign-in required or unverified' : '○ CLI not installed'}</span>
    </SettingRow>
    {status.lastCheckedAt && <p className="card-description">Last connection check {new Date(status.lastCheckedAt).toLocaleString()} · cached status is revalidated when you verify or send a request.</p>}
    <SettingRow title="Google account" description="The documented ACP interface does not expose the personal account name. Antigravity owns account identity and authentication.">
      <span>{status.authState === 'authenticated' ? 'Managed by Antigravity' : 'Not verified'}</span>
    </SettingRow>
    <SettingRow title="Current conversation model" description="Model choice is saved per conversation and can be changed in the Chat Conversation composer.">
      <span>{selectedModel && !/^gemini(?:-|$)/i.test(selectedModel) ? 'No Gemini model selected' : selectedModel ? status.models.find(model => model.id === selectedModel)?.name ?? `${selectedModel} · unavailable` : 'No model selected'}</span>
    </SettingRow>
    <div className="ai-actions">
      <button className="button primary" disabled={connectionBusy || !status.installed || !isDesktop} onClick={() => void refresh('login')}>Sign in with Google</button>
      <button className="button secondary" disabled={connectionBusy || !status.installed || !isDesktop} onClick={() => void refresh('refresh')}>Verify sign-in & refresh models</button>
      <button className="button secondary" disabled={connectionBusy || !status.installed || status.authState !== 'authenticated' || !isDesktop} onClick={() => void refresh('logout')}>Sign out in Antigravity CLI</button>
    </div>
    {!status.installed && <div className="ai-provider-note" role="status"><strong>Sign-in is unavailable until the official `agy` CLI is installed.</strong><p className="card-description">Google’s installer places it in <code>~/.local/bin/agy</code>. Athena checks that location and will enable native sign-in after you install it.</p><a className="button secondary" href="https://antigravity.google/docs/getting-started" target="_blank" rel="noreferrer">Open Google’s CLI install instructions</a></div>}
    <p className="card-description">Sign in opens the ACP agent’s native <code>oauth-personal</code> flow. Sign out opens the official CLI in Terminal; enter <code>/logout</code> there, then refresh. Google account names and tokens stay in Antigravity’s own credential store.</p>
    <p className="card-description">Athena starts ACP with Google’s documented <code>--sandbox</code> flag and does not pass <code>--dangerously-skip-permissions</code>. ACP permission requests use Athena’s approval prompt. Antigravity permission rules that already auto-allow an action remain controlled by Google’s runtime; review those rules before attaching a project.</p>
    <p className="card-description">Google AI Free, Pro, and Ultra personal plans may use eligible models advertised by the authenticated Antigravity runtime. Model access and quota remain controlled by Antigravity and may include Gemini or partner models depending on account eligibility and runtime version. Athena does not rotate accounts, use Gemini API keys, or switch to another provider.</p>
    {notice && <p className="ai-provider-note" role="status">{notice}</p>}
    </Section>
    <UsageDashboard data={{ ...usageData, stale: status.usage ? Date.now() - status.usage.fetchedAt > 15 * 60_000 : false }} refreshing={usageBusy} onRefresh={status.installed && status.authState === 'authenticated' && isDesktop ? () => refresh('usage') : undefined} />
  </>
}
