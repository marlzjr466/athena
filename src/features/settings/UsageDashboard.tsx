import { useRef, useState } from 'react'
import { Section } from '../../components/ui/Controls'
import type { UsageDashboardData } from '../../../shared/usage'

interface UsageDashboardProps {
  data: UsageDashboardData
  refreshing?: boolean
  onRefresh?: () => void | boolean | Promise<void | boolean>
  refreshLabel?: string
}

const availabilityLabel = (availability: UsageDashboardData['availability']) => ({
  available: 'Available', partial: 'Partially available', unavailable: 'Unavailable',
  'authentication-required': 'Sign-in required', 'permission-required': 'Permission required',
  'no-usage': 'No usage recorded', 'local-available': 'Local usage available',
  'not-exposed': 'View in official account settings',
}[availability])

function displayValue(value: number, unit: string): string {
  if (unit === 'currency') return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value)
  if (unit === 'duration') return `${(value / 1000).toFixed(2)} s`
  return `${value.toLocaleString()}${unit === 'tokens' ? ' tokens' : unit === 'requests' ? ' requests' : unit === 'credits' ? ' credits' : unit === 'count' ? '' : ` ${unit}`}`
}

export function UsageDashboard({ data, refreshing = false, onRefresh, refreshLabel = 'Refresh Usage' }: UsageDashboardProps) {
  const [localRefreshing, setLocalRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const refreshInFlight = useRef(false)
  const groups = data.quotaGroups?.filter(group => group.quotas.length) ?? []
  const metrics = data.metrics?.filter(metric => Number.isFinite(metric.value)) ?? []
  const hasValues = groups.length > 0 || metrics.length > 0
  const isRefreshing = refreshing || localRefreshing
  const refresh = async () => {
    if (!onRefresh || refreshInFlight.current || refreshing) return
    refreshInFlight.current = true
    setLocalRefreshing(true)
    setRefreshError('')
    try {
      if (await onRefresh() === false) setRefreshError('Usage refresh failed.')
    } catch { setRefreshError('Usage refresh failed.') }
    finally { refreshInFlight.current = false; setLocalRefreshing(false) }
  }
  return <Section title={data.title ?? `${data.provider} Usage`} description={`${data.usageType} · ${data.source}`}>
    <div className="usage-dashboard__toolbar">
      <div className="usage-dashboard__identity">
        <span className={`usage-dashboard__status is-${data.availability}`} role="status">{availabilityLabel(data.availability)}</span>
        <span>Account: {data.account}</span>
        {data.refreshedAt != null && <span>Last updated {new Date(data.refreshedAt).toLocaleString()}</span>}
        {data.stale && <span className="usage-dashboard__stale">Cached data · refresh to update</span>}
      </div>
      <div className="ai-actions usage-dashboard__actions">
        {data.officialUrl && <a className="button secondary" href={data.officialUrl} target="_blank" rel="noreferrer">{data.officialLabel ?? 'Open official usage'}</a>}
        {onRefresh && <button className="button secondary" type="button" disabled={isRefreshing} onClick={() => void refresh()}>{isRefreshing ? 'Refreshing…' : refreshLabel}</button>}
      </div>
    </div>
    {(data.error || refreshError) && <p className="usage-dashboard__error" role="alert">{[data.error, refreshError].filter(Boolean).join(' ')}{hasValues ? ' The last successful snapshot remains visible.' : ''}</p>}
    {data.explanation && <p className="antigravity-usage-note">{data.explanation}</p>}
    {data.notices?.map(notice => <p className="antigravity-usage-note" key={notice.id}><strong>{notice.label}:</strong> {notice.value}</p>)}
    {groups.map(group => <div className="usage-dashboard__group" key={group.id}>
      <div className="usage-dashboard__group-heading"><h3>{group.label}</h3>{group.description && <p>{group.description}</p>}</div>
      <div className="antigravity-usage-grid">{group.quotas.map(quota => {
        const remaining = quota.remainingPercentage
        const state = remaining === null ? '' : remaining <= 0 ? 'is-empty' : remaining <= 25 ? 'is-low' : 'is-healthy'
        return <article className="antigravity-usage-card" key={quota.id}>
          <h4>{quota.label}</h4>
          <div className={`antigravity-quota ${state}`}>
            <div className="antigravity-quota__heading"><strong>{quota.usedLabel ?? 'Quota details'}</strong><span>{remaining === null ? 'Remaining amount not reported' : `${Math.round(remaining)}% remaining`}</span></div>
            {remaining !== null && <div className="antigravity-quota__track" role="progressbar" aria-label={`${quota.label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}><span style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }} /></div>}
            {(quota.resetAt || quota.detail) && <div className="antigravity-quota__details">{quota.resetAt && <span>Resets {new Date(quota.resetAt).toLocaleString()}</span>}{quota.detail && <span>{quota.detail}</span>}</div>}
          </div>
        </article>
      })}</div>
    </div>)}
    {metrics.length > 0 && <div className="usage-dashboard__metrics">{metrics.map(metric => <article className="antigravity-usage-card usage-dashboard__metric" key={metric.id}>
      <span>{metric.label}</span><strong>{displayValue(metric.value, metric.unit)}</strong>
      {metric.period && <small>{metric.period}</small>}{metric.detail && <small>{metric.detail}</small>}
    </article>)}</div>}
    {!hasValues && !data.notices?.length && <p className="antigravity-usage-note">{data.availability === 'no-usage' ? 'No requests are recorded for this account and reporting period.' : 'No usage metrics are available from this source yet.'} Athena will not estimate quotas, balances, or costs.</p>}
    {data.stale && <p className="antigravity-usage-stale" role="status">The displayed snapshot is stale. Refresh before relying on it.</p>}
  </Section>
}
