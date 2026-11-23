import { useEffect, useRef, useState } from 'react'
import { desktop } from '../../services/desktop'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { UsageDashboard } from './UsageDashboard'
import { usageMetrics, type ProviderUsageResult, type UsagePeriod, type UsageProvider } from '../../../shared/providerUsage'
import { apiBalanceNotices, billingPresentation, chatGPTUsageUrl, openAIBillingUrl, subscriptionQuotaNotices } from '../../../shared/openAIBilling'

const cache = new Map<string, ProviderUsageResult>()
export function ProviderUsageDashboard({ provider, account, accountId, connected, connectionVersion }: {
  provider: UsageProvider; account: string; accountId?: string; connected: boolean; connectionVersion?: number | null
}) {
  const [period, setPeriod] = useState<UsagePeriod>('month')
  const [scope, setScope] = useState<string | undefined>()
  const identity = `${provider}:${accountId ?? 'current'}:${connectionVersion ?? ''}`
  const queryAccount = scope ?? accountId
  const key = `${identity}:${queryAccount ?? 'current'}:${period}`
  const [value, setValue] = useState<{ key: string; data: ProviderUsageResult }>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [adminKey, setAdminKey] = useState(''), [projectId, setProjectId] = useState(''), [savingAdmin, setSavingAdmin] = useState(false)
  const currentKey = useRef(key); currentKey.current = key
  const generation = useRef(0)
  const data = value?.key === key ? value.data : cache.get(key)
  useEffect(() => { setScope(undefined) }, [identity])
  const load = async (refresh: boolean) => {
    const request = ++generation.current
    setLoading(true); setError('')
    try {
      const result = await desktop.getProviderUsage({ provider, accountId: queryAccount, period, refresh })
      if (currentKey.current === key && request === generation.current) { cache.set(key, result); setValue({ key, data: result }) }
    } catch {
      if (currentKey.current === key && request === generation.current) setError('Usage refresh failed. Previously recorded totals are retained.')
    } finally { if (currentKey.current === key && request === generation.current) setLoading(false) }
  }
  useEffect(() => {
    // Read local/cached data only; opening Settings never calls provider analytics.
    void load(false)
    return () => { generation.current++ }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const saveAdmin = async (remove = false) => {
    if (savingAdmin) return
    setSavingAdmin(true); setError('')
    try {
      const result = remove ? await desktop.removeOpenAIUsage() : await desktop.configureOpenAIUsage({ key: adminKey, projectId })
      if (!result.ok) throw new Error('Credential storage unavailable')
      setAdminKey(''); await load(false)
    } catch { setError('Could not update the separate organization credential. Local usage and inference credentials are unchanged.') }
    finally { setSavingAdmin(false) }
  }
  const local = data?.local, subscription = provider === 'chatgpt-subscription'
  const providerName = subscription ? 'ChatGPT Subscription' : 'OpenAI API'
  const periodLabel = period === 'all' ? 'All recorded history' : `This ${period} (UTC)`
  const availability = local?.error ? 'partial' : local?.totals.requests ? local.totals.unknownUsage ? 'partial' : 'local-available' : connected || scope ? 'no-usage' : 'authentication-required'
  const billing = data?.organization?.billing ? billingPresentation(data.organization.billing) : undefined
  return <>
    {subscription ? <UsageDashboard data={{ provider: providerName, title: 'ChatGPT Subscription · Plan allowance', account,
      usageType: 'Official subscription usage', source: 'ChatGPT Settings → Usage', availability: connected ? 'not-exposed' : 'authentication-required',
      notices: subscriptionQuotaNotices, officialUrl: chatGPTUsageUrl, officialLabel: 'Open ChatGPT Usage',
      explanation: 'Official subscription quota unavailable through the documented Sign in with ChatGPT interface. Remaining allowance is visible in ChatGPT Settings. Refresh updates local records only; Athena does not infer plan limits, credits or reset times from tokens or error messages.',
    }} refreshing={loading} onRefresh={() => load(true)} /> : <UsageDashboard data={{ provider: 'OpenAI API', title: 'OpenAI API · Billing & spending allowance', account: data?.adminConfigured ? `Separately authorized Admin credential · ${data.organization?.scope ?? 'organization'}` : account,
      usageType: 'Official API billing', source: 'OpenAI organization Costs, Spend Limits and Spend Alerts APIs',
      availability: !data?.adminConfigured ? 'permission-required' : billing?.refreshedAt ? billing.error || data.organizationError ? 'partial' : 'available' : 'partial',
      ...billing, notices: [...apiBalanceNotices, ...(billing?.notices ?? [])], error: [billing?.error, data?.organizationError].filter(Boolean).join(' ') || undefined,
      officialUrl: openAIBillingUrl, officialLabel: 'Open OpenAI Billing',
      explanation: data?.adminConfigured ? 'Organization and project limits can both apply. These reports cover the UTC calendar month and may be delayed. Prepaid balances, promotional credits, approved usage limits and rate limits are separate. Athena only reads billing settings.' : 'Monthly spending, hard limits and alerts require a separately authorized Admin API credential. Configure it below, then click Refresh Usage. Your inference key is unchanged.',
    }} refreshing={loading} onRefresh={() => load(true)} />}
    {!subscription && <details className="antigravity-usage-note">
      <summary>Optional organization usage and billing</summary>
      <p>Supply an authorized OpenAI Admin API credential to read organization Usage, Costs, hard Spend Limits and Spend Alerts, plus project limits when a project filter is provided. Saving authorizes these read-only requests on Refresh Usage. Credentials are stored separately in secure storage and never used for inference. No keys are created, permissions expanded, credits purchased or billing settings changed. Organization data may be delayed; it is not added to local totals. “All recorded history” requests the last 30 days for usage reports; spending allowances always use the current UTC calendar month.</p>
      <label>Admin API credential<input aria-label="OpenAI usage Admin API credential" type="password" autoComplete="off" value={adminKey} onChange={e=>setAdminKey(e.target.value)} /></label>
      <label>Project filter (optional)<input aria-label="OpenAI organization usage project" value={projectId} placeholder="proj_…" onChange={e=>setProjectId(e.target.value)} /></label>
      <div className="ai-actions"><button className="button secondary" disabled={savingAdmin || adminKey.trim().length < 20} onClick={()=>void saveAdmin()}>Save Admin credential</button>
        {data?.adminConfigured && <button className="button secondary" disabled={savingAdmin} onClick={()=>void saveAdmin(true)}>Remove Admin credential</button>}</div>
    </details>}
    <div className="ai-actions" aria-label={`${providerName} usage filters`}>
      <CustomSelect ariaLabel={`${providerName} usage period`} value={period} options={[{value:'day',label:'Today (UTC)'},{value:'week',label:'This week (UTC)'},{value:'month',label:'This month (UTC)'},{value:'all',label:'All recorded history'}]} onChange={v=>setPeriod(v as UsagePeriod)} />
      {Boolean(local?.accounts.some(id => id !== (accountId ?? local.accountId))) && <CustomSelect ariaLabel={`${providerName} usage account`} value={scope ?? 'current'} options={[{value:'current',label:'Current account'}, ...(local?.accounts.filter(id => id !== accountId) ?? []).map(id=>({value:id,label:id === 'historical-unassigned' ? 'Historical usage · account not recorded' : `Account reference ${id.slice(-8)}`}))]} onChange={v=>setScope(v === 'current' ? undefined : v)} />}
    </div>
    <UsageDashboard data={{ provider: providerName, title: `${providerName} · Locally observed usage`, account: scope === 'historical-unassigned' ? 'Historical account · identity was not recorded' : scope ? `Saved account reference ${scope.slice(-8)}` : account,
      usageType: `Locally observed response usage · ${periodLabel}`, availability,
      source: 'Persistent response receipts across conversations, agent tasks and sub-agents', refreshedAt: local?.refreshedAt,
      metrics: local ? usageMetrics(local) : [], error: error || local?.error,
      officialUrl: subscription ? undefined : 'https://platform.openai.com/usage', officialLabel: 'Open OpenAI Usage Dashboard',
      explanation: `${subscription ? 'These local tokens are not remaining ChatGPT plan allowance.' : 'These local tokens are not API credits or organization spending.'} Refresh Local Usage reloads saved receipts across conversations without a billing request. Requests without a final receipt have unknown consumption. Older estimated totals are not presented as measured tokens. Historical request outcomes may be unavailable.`,
    }} refreshing={loading} refreshLabel="Refresh Local Usage" onRefresh={() => load(false)} />
    {!subscription && data?.adminConfigured && <UsageDashboard data={{ provider: 'OpenAI organization', title: 'OpenAI API · Official usage by model and project', account: data.organization?.scope ?? 'Separately authorized Admin credential', usageType: 'Provider-reported organization usage and costs', source: 'Official Usage and Costs APIs · may be delayed', availability: data.organization ? data.organization.error ? 'partial' : 'available' : 'partial',
      metrics: data.organization?.metrics, refreshedAt: data.organization?.refreshedAt || undefined, stale: data.organization?.stale,
      explanation: 'Organization totals are independent of Athena’s local usage and can include other clients. Click Refresh Usage above to retrieve this report.' }} />}
  </>
}
