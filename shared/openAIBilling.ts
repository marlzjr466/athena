import type { UsageDashboardData, UsageMetric, UsageQuotaGroup } from './usage'

// Verified 2026-11-23 against the official Sign in with ChatGPT accounts/sessions
// guide and /organization/{projects/{project_id}/}spend_limit reference.
// Sign in with ChatGPT documents the Settings link, not a quota-reading endpoint.
// Spend-limit thresholds are integer cents; Costs API amounts are currency units.

export interface MonthlyCost { usd: number; start: number; end: number; refreshedAt: number; sampleId: string }
export interface SpendLimit { thresholdAmount: number; currency: string; interval: string; enforcement: string; refreshedAt: number; sampleId: string }
export interface SpendAlerts { values: Array<{ id: string; thresholdAmount: number; currency: string; interval: string }>; refreshedAt: number }
export interface BillingScope {
  id: string; label: string; cost?: MonthlyCost; limit?: SpendLimit; alerts?: SpendAlerts
  errors: Partial<Record<'cost' | 'limit' | 'alerts', string>>
}
export interface OpenAIBillingSnapshot { start: number; end: number; scopes: BillingScope[] }

export const openAIBillingUrl = 'https://platform.openai.com/settings/organization/billing/overview'
export const chatGPTUsageUrl = 'https://chatgpt.com/settings/usage'
export const subscriptionQuotaNotices = [
  { id: 'five-hour', label: 'Five-hour limit remaining', value: 'Unavailable through the documented Sign in with ChatGPT interface; applicability depends on your plan.' },
  { id: 'weekly', label: 'Weekly and app-specific limits', value: 'Unavailable through the documented interface. View remaining allowance and app limits in ChatGPT Settings → Usage.' },
  { id: 'reset', label: 'Reset timestamps and remaining credits', value: 'Unavailable through the documented interface. View in ChatGPT Settings → Usage.' },
]
export const apiBalanceNotices = [
  { id: 'prepaid', label: 'Prepaid credit balance', value: 'View in OpenAI Billing.' },
  { id: 'promotional', label: 'Promotional credit grants', value: 'Not exposed through the documented APIs; view in OpenAI Billing.' },
  { id: 'approved', label: 'OpenAI-approved usage limits and rate limits', value: 'Separate from your configured spend limits. View in OpenAI organization limits.' },
]

/** Only compare matching official monthly samples. Never mix an old limit with freshly reported cost. */
export function remainingAllowance(scope: BillingScope, start: number) {
  const { cost, limit } = scope
  if (!cost || !limit || cost.start !== start || !cost.sampleId || cost.sampleId !== limit.sampleId || limit.enforcement !== 'enforcing' || limit.currency !== 'USD' || limit.interval !== 'month') return null
  const total = limit.thresholdAmount / 100
  if (!Number.isFinite(total) || total < 0 || !Number.isFinite(cost.usd) || cost.usd < 0) return null
  const remaining = Math.max(0, total - cost.usd)
  return { total, remaining, percentage: total > 0 ? Math.max(0, Math.min(100, remaining / total * 100)) : null }
}

export function billingPresentation(snapshot: OpenAIBillingSnapshot): Pick<UsageDashboardData, 'metrics' | 'quotaGroups' | 'notices' | 'refreshedAt' | 'stale' | 'error'> {
  const metrics: UsageMetric[] = [], quotaGroups: UsageQuotaGroup[] = [], notices: NonNullable<UsageDashboardData['notices']> = []
  const period = `${new Date(snapshot.start).toISOString().slice(0, 10)} – ${new Date(snapshot.end).toISOString().slice(0, 10)} (UTC)`
  const errors: string[] = [], stamps: number[] = []
  const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(n)
  for (const scope of snapshot.scopes) {
    const { cost, limit, alerts } = scope
    errors.push(...Object.values(scope.errors).map(e => `${scope.label}: ${e}`))
    for (const sample of [cost, limit, alerts]) if (sample) stamps.push(sample.refreshedAt)
    if (cost) metrics.push({ id: `${scope.id}:cost`, label: `${scope.label} · Reported monthly spending`, value: cost.usd, unit: 'currency', period, detail: `Costs API · may be delayed · updated ${new Date(cost.refreshedAt).toISOString()}` })
    else notices.push({ id: `${scope.id}:cost`, label: `${scope.label} monthly spending`, value: 'Not retrieved. Refresh with an authorized Admin credential.' })
    if (limit) {
      metrics.push({ id: `${scope.id}:limit`, label: `${scope.label} · Configured ${limit.interval} spend limit`, value: limit.thresholdAmount / 100, unit: limit.currency === 'USD' ? 'currency' : limit.currency, detail: `Enforcement: ${limit.enforcement}. This is not a prepaid balance.` })
      if (limit.enforcement !== 'enforcing') notices.push({ id: `${scope.id}:inactive`, label: `${scope.label} enforcement`, value: 'The returned limit is not enforcing. No remaining hard-limit allowance is inferred.' })
    } else notices.push({ id: `${scope.id}:limit`, label: `${scope.label} hard spend limit`, value: 'Unavailable or not configured. This does not imply unlimited spending.' })
    const allowance = remainingAllowance(scope, snapshot.start)
    if (allowance) quotaGroups.push({ id: scope.id, label: scope.label, description: 'Configured hard limit less matching reported costs. Reporting and enforcement can lag; this is not credit balance or guaranteed spend capacity.', quotas: [{ id: `${scope.id}:remaining`, label: 'Remaining monthly spending allowance', usedLabel: `${money(allowance.remaining)} of ${money(allowance.total)}`, remainingPercentage: allowance.percentage, detail: `${period} · ${money(cost!.usd)} reported spending${Object.keys(scope.errors).length ? ' · cached snapshot' : ''}` }] })
    else if (limit?.enforcement === 'enforcing') notices.push({ id: `${scope.id}:remaining`, label: `${scope.label} remaining monthly spending allowance`, value: 'Unavailable until matching monthly cost and limit data are retrieved together.' })
    if (alerts) {
      if (!alerts.values.length) notices.push({ id: `${scope.id}:alerts`, label: `${scope.label} spending alerts`, value: 'No alerts returned. Alerts send notifications and do not enforce a cap.' })
      for (const alert of alerts.values) metrics.push({ id: `${scope.id}:alert:${alert.id}`, label: `${scope.label} · Spend alert`, value: alert.thresholdAmount / 100, unit: alert.currency === 'USD' ? 'currency' : alert.currency, detail: `${alert.interval} · Notification only; not a hard limit or remaining allowance.` })
    }
  }
  return { metrics, quotaGroups, notices, refreshedAt: stamps.length ? Math.min(...stamps) : undefined, stale: errors.length > 0 || stamps.some(t => Date.now() - t > 15 * 60_000), error: errors.join(' ') || undefined }
}
