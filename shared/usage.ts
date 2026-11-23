export type UsageAvailability = 'available' | 'partial' | 'unavailable' | 'authentication-required' | 'permission-required' | 'no-usage' | 'local-available' | 'not-exposed'
export type UsageMetricKind = 'tokens' | 'requests' | 'credits' | 'currency' | 'duration' | 'count'

export interface UsageMetric {
  id: string
  label: string
  value: number
  unit: UsageMetricKind | string
  detail?: string
  period?: string
}

export interface UsageQuota {
  id: string
  label: string
  /** Remaining percentage only when the provider explicitly reports it or both values are authoritative. */
  remainingPercentage: number | null
  usedLabel?: string
  resetAt?: string | null
  detail?: string
}

export interface UsageQuotaGroup {
  id: string
  label: string
  description?: string
  quotas: UsageQuota[]
}

export interface UsageDashboardData {
  provider: string
  title?: string
  account: string
  usageType: string
  availability: UsageAvailability
  source: string
  refreshedAt?: number | null
  stale?: boolean
  error?: string | null
  explanation?: string
  metrics?: UsageMetric[]
  quotaGroups?: UsageQuotaGroup[]
  officialUrl?: string
  officialLabel?: string
  /** Informational availability rows, never quota cards or numeric estimates. */
  notices?: Array<{ id: string; label: string; value: string }>
}
