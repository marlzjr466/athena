import { z } from 'zod'
import type { UsageMetric } from './usage'
import type { OpenAIBillingSnapshot } from './openAIBilling'

export const usageProviderSchema = z.enum(['chatgpt-subscription', 'openai-api'])
export type UsageProvider = z.infer<typeof usageProviderSchema>
export const usagePeriodSchema = z.enum(['day', 'week', 'month', 'all'])
export type UsagePeriod = z.infer<typeof usagePeriodSchema>
const token = z.number().finite().nonnegative().nullable()
export const usageRecordSchema = z.object({
  id: z.string(), provider: usageProviderSchema, accountId: z.string(), model: z.string(),
  conversationId: z.string(), executionId: z.string(), responseId: z.string().nullable(),
  timestamp: z.number(), updatedAt: z.number(),
  status: z.enum(['pending', 'completed', 'failed', 'incomplete', 'cancelled', 'interrupted', 'unknown']),
  source: z.enum(['openai-response', 'legacy-conversation']), requestCount: z.number().int().nonnegative(),
  inputTokens: token, cachedInputTokens: token, outputTokens: token, reasoningTokens: token, totalTokens: token,
})
export type UsageRecord = z.infer<typeof usageRecordSchema>
export type RequestUsage = Omit<UsageRecord, 'provider' | 'accountId'>
export type UsageSink = (record: RequestUsage) => void
export function periodStart(period: UsagePeriod, now: number): number {
  const date = new Date(now)
  date.setUTCHours(0, 0, 0, 0)
  if (period === 'all') return 0
  if (period === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  if (period === 'month') date.setUTCDate(1)
  return date.getTime()
}
export const usageQuerySchema = z.object({ provider: usageProviderSchema, accountId: z.string().max(200).optional(), period: usagePeriodSchema.default('month'), conversationId: z.string().max(100).optional(), refresh: z.boolean().default(false) })
export type UsageQuery = z.infer<typeof usageQuerySchema>
export const usageCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot'), query: usageQuerySchema }),
  z.object({ action: z.literal('configure-admin'), key: z.string().trim().min(20).max(500), projectId: z.string().trim().regex(/^(proj_[a-zA-Z0-9_-]+)?$/).default('') }),
  z.object({ action: z.literal('remove-admin') }),
])
export type UsageCommand = z.input<typeof usageCommandSchema>
export interface OrganizationUsageSnapshot { metrics: UsageMetric[]; start: number; end: number; refreshedAt: number; scope: string; error?: string; stale?: boolean; billing?: OpenAIBillingSnapshot }
export interface ProviderUsageResult { local: LocalUsageSnapshot; adminConfigured: boolean; organization?: OrganizationUsageSnapshot; organizationError?: string }
export interface UsageTotals {
  requests: number; completed: number; failed: number; interrupted: number; pending: number; unknownStatus: number; unknownUsage: number
  receipts: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number
}
const emptyTotals = (): UsageTotals => ({ requests: 0, completed: 0, failed: 0, interrupted: 0, pending: 0, unknownStatus: 0, unknownUsage: 0, receipts: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 })
function add(sum: UsageTotals, record: UsageRecord) {
  sum.requests += record.requestCount
  const key = record.status === 'completed' ? 'completed' : record.status === 'failed' ? 'failed' : record.status === 'pending' ? 'pending' : record.status === 'unknown' ? 'unknownStatus' : 'interrupted'
  sum[key] += record.requestCount
  if (record.inputTokens === null || record.outputTokens === null) sum.unknownUsage += record.requestCount
  else sum.receipts += record.requestCount
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const) sum[field] += record[field] ?? 0
}
export interface LocalUsageSnapshot {
  provider: UsageProvider; accountId: string; period: UsagePeriod; start: number; end: number; refreshedAt: number; lastReceiptAt: number | null
  totals: UsageTotals; models: Array<{ model: string; totals: UsageTotals }>
  days: Array<{ day: string; totals: UsageTotals }>; conversations: Array<{ conversationId: string; totals: UsageTotals }>
  accounts: string[]; error?: string
}
export function aggregateUsage(records: UsageRecord[], query: Omit<UsageQuery, 'refresh'> & { accountId: string }, now = Date.now()): LocalUsageSnapshot {
  const start = periodStart(query.period, now)
  const selected = records.filter(r => r.provider === query.provider && r.accountId === query.accountId && r.timestamp >= start && r.timestamp <= now && (!query.conversationId || r.conversationId === query.conversationId))
  const totals = emptyTotals(), models = new Map<string, UsageTotals>(), days = new Map<string, UsageTotals>(), conversations = new Map<string, UsageTotals>()
  for (const r of selected) {
    add(totals, r)
    for (const [map, key] of [[models, r.model], [days, new Date(r.timestamp).toISOString().slice(0, 10)], [conversations, r.conversationId]] as const) {
      const subtotal = map.get(key) ?? emptyTotals(); add(subtotal, r); map.set(key, subtotal)
    }
  }
  return { provider: query.provider, accountId: query.accountId, period: query.period, start, end: now, refreshedAt: now,
    lastReceiptAt: selected.reduce<number | null>((max, r) => r.inputTokens === null ? max : Math.max(max ?? 0, r.updatedAt), null), totals,
    accounts: [...new Set(records.filter(r => r.provider === query.provider).map(r => r.accountId))],
    models: [...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, totals]) => ({ model, totals })),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, totals]) => ({ day, totals })),
    conversations: [...conversations].map(([conversationId, totals]) => ({ conversationId, totals })),
  }
}
export function usageMetrics(snapshot: LocalUsageSnapshot): UsageMetric[] {
  const t = snapshot.totals
  const period = snapshot.start ? `${new Date(snapshot.start).toISOString().slice(0, 10)} – ${new Date(snapshot.end).toISOString().slice(0, 10)} (UTC)` : 'All recorded history'
  const metric = (id: string, label: string, value: number, unit = 'requests', detail?: string): UsageMetric => ({ id, label, value, unit, period, detail })
  if (!t.requests) return []
  return [metric('requests', 'Model requests', t.requests), metric('completed', 'Successful requests', t.completed),
    ...(t.failed ? [metric('failed', 'Failed requests', t.failed)] : []), ...(t.interrupted ? [metric('interrupted', 'Interrupted / incomplete requests', t.interrupted)] : []),
    ...(t.pending ? [metric('pending', 'In-flight requests', t.pending)] : []), ...(t.unknownStatus ? [metric('legacy', 'Historical receipts · status not recorded', t.unknownStatus)] : []),
    ...(t.unknownUsage ? [metric('unknown', 'Requests with unknown consumption', t.unknownUsage, 'requests', 'No authoritative final usage receipt; these requests are not counted as zero-token requests.')] : []),
    ...(t.receipts ? [metric('input', 'Input tokens', t.inputTokens, 'tokens'), metric('output', 'Output tokens', t.outputTokens, 'tokens'), metric('total', 'Total tokens', t.totalTokens, 'tokens')] : []),
    ...(t.cachedInputTokens ? [metric('cached', 'Cached input tokens', t.cachedInputTokens, 'tokens', 'Included in input tokens')] : []),
    ...(t.reasoningTokens ? [metric('reasoning', 'Reasoning tokens', t.reasoningTokens, 'tokens', 'Included in output tokens')] : []),
    ...snapshot.models.map(({ model, totals }) => totals.receipts
      ? metric(`model:${model}`, model, totals.totalTokens, 'tokens', `${totals.requests} requests · ${totals.inputTokens} known input · ${totals.outputTokens} known output${totals.unknownUsage ? ` · ${totals.unknownUsage} with unknown consumption` : ''}`)
      : metric(`model:${model}`, model, totals.requests, 'requests', 'Token consumption unknown; no authoritative receipt was returned.')),
  ]
}
