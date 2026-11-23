import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { apiUsageAccount, type UsageLedger } from './usageLedger'
import { credentialEntry } from './secureCredentialEntry'
import { credentialServiceName } from './credentialStore'
import { periodStart, type UsageQuery, type OrganizationUsageSnapshot, type ProviderUsageResult } from '../../../shared/providerUsage'
import type { UsageMetric } from '../../../shared/usage'
import type { BillingScope, OpenAIBillingSnapshot } from '../../../shared/openAIBilling'

const adminSchema = z.object({ key: z.string().min(20).max(500), projectId: z.string().regex(/^(proj_[a-zA-Z0-9_-]+)?$/).default('') })
type SecretEntry = { getPassword(): Promise<string | null>; setPassword(value: string): Promise<void>; deleteCredential(): Promise<void> }
const limitSchema = z.object({ object: z.enum(['organization.spend_limit', 'project.spend_limit']), threshold_amount: z.number().int().nonnegative(), currency: z.literal('USD'), interval: z.literal('month'), enforcement: z.object({ status: z.string() }) })
const alertSchema = z.object({ id: z.string(), threshold_amount: z.number().int().nonnegative(), currency: z.literal('USD'), interval: z.literal('month') })
const alertPageSchema = z.object({ data: z.array(alertSchema), has_more: z.boolean(), last_id: z.string().nullable() })
const count = z.number().finite().nonnegative()
const resultSchema = z.object({ input_tokens: count.optional(), input_cached_tokens: count.optional(), output_tokens: count.optional(), num_model_requests: count.optional(), model: z.string().nullable().optional(), project_id: z.string().nullable().optional(), amount: z.object({ value: count, currency: z.string().max(12) }).optional() })
const pageSchema = z.object({ data: z.array(z.object({ start_time: count, end_time: count, results: z.array(resultSchema) })), has_more: z.boolean(), next_page: z.string().nullable().optional() })

export class ProviderUsageService {
  private pending = new Map<string, Promise<OrganizationUsageSnapshot>>()
  private cached: Record<string, OrganizationUsageSnapshot> = {}
  private file: string
  constructor(private ledger: UsageLedger, private directory: string, private request: typeof fetch = fetch, private vault: () => SecretEntry = () => credentialEntry(`${credentialServiceName()}.usage-admin`, 'organization-analytics')) {
    this.file = join(directory, 'organization-usage-cache.json')
    if (existsSync(this.file)) { try { this.cached = JSON.parse(readFileSync(this.file, 'utf8')) } catch { /* Refetch only on explicit refresh. */ } }
  }
  async configure(key: string, projectId: string) {
    await this.vault().setPassword(JSON.stringify(adminSchema.parse({ key, projectId })))
  }
  async remove() { await this.vault().deleteCredential() }
  async snapshot(query: UsageQuery & { accountId: string }): Promise<ProviderUsageResult> {
    const local = this.ledger.snapshot(query)
    if (query.provider !== 'openai-api') return { local, adminConfigured: false }
    let admin: z.infer<typeof adminSchema> | undefined
    try { const raw = await this.vault().getPassword(); if (raw) admin = adminSchema.parse(JSON.parse(raw)) }
    catch { return { local, adminConfigured: false, organizationError: 'Organization credential unavailable. Local usage remains available.' } }
    if (!admin) return { local, adminConfigured: false }
    // All-history local totals cannot imply an unlimited organization report.
    const start = query.period === 'all' ? Date.now() - 30 * 86400_000 : periodStart(query.period, Date.now())
    const cacheKey = `${apiUsageAccount(admin.key)}:${admin.projectId}:${query.period}:${new Date(start).toISOString().slice(0, 10)}:billing-${periodStart('month', Date.now())}`
    let organization = this.cached[cacheKey]
    if (query.refresh) {
      let pending = this.pending.get(cacheKey)
      if (!pending) {
        pending = this.retrieve(admin, start, organization).then(snapshot => {
          this.cached[cacheKey] = snapshot
          mkdirSync(this.directory, { recursive: true, mode: 0o700 })
          writeFileSync(`${this.file}.tmp`, JSON.stringify(this.cached), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file)
          return snapshot
        }).finally(() => this.pending.delete(cacheKey))
        this.pending.set(cacheKey, pending)
      }
      try { organization = await pending }
      catch (error) { return { local, adminConfigured: true, organization: organization ? { ...organization, stale: true } : undefined, organizationError: error instanceof Error ? error.message : 'Organization usage refresh failed.' } }
    }
    return { local, adminConfigured: true, organization, organizationError: organization?.error }
  }
  private async json(admin: z.infer<typeof adminSchema>, url: URL, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(url, { headers: { Authorization: `Bearer ${admin.key}` }, signal, redirect: 'error' })
    if (!response.ok) throw new Error(response.status === 401 ? 'Admin credential rejected. Replace it to refresh official data.' : response.status === 403 ? 'Permission required for this organization billing endpoint.' : response.status === 404 ? 'Requested billing information is unavailable or not configured (HTTP 404).' : `Official usage refresh failed (HTTP ${response.status}).`)
    const text = await response.text()
    if (text.length > 8_000_000) throw new Error('Official usage response exceeded the supported size.')
    try { return JSON.parse(text) } catch { throw new Error('Official usage returned invalid JSON.') }
  }
  private async retrieve(admin: z.infer<typeof adminSchema>, start: number, previous?: OrganizationUsageSnapshot): Promise<OrganizationUsageSnapshot> {
    const end = Date.now(), signal = AbortSignal.timeout(30_000), sampleId = randomUUID()
    type Buckets = z.infer<typeof pageSchema>['data']
    const reports = new Map<string, Promise<Buckets>>()
    const read = (path: string, group: string[], from = start, projectId = admin.projectId): Promise<Buckets> => {
      const key = JSON.stringify([path, group, from, projectId])
      const existing = reports.get(key)
      if (existing) return existing
      const promise = (async () => {
        const all: Buckets = [], pages = new Set<string>()
        let cursor: string | undefined
        for (let index = 0; index < 50; index++) {
          const url = new URL(`https://api.openai.com/v1/organization/${path}`)
          url.searchParams.set('start_time', String(Math.floor(from / 1000))); url.searchParams.set('end_time', String(Math.floor(end / 1000)))
          url.searchParams.set('bucket_width', '1d'); url.searchParams.set('limit', '31')
          for (const value of group) url.searchParams.append('group_by[]', value)
          if (projectId) url.searchParams.append('project_ids[]', projectId)
          if (cursor) url.searchParams.set('page', cursor)
          const parsed = pageSchema.safeParse(await this.json(admin, url, signal))
          if (!parsed.success) throw new Error('Official usage returned an invalid response.')
          all.push(...parsed.data.data)
          if (!parsed.data.has_more) return all
          cursor = parsed.data.next_page ?? undefined
          if (!cursor || pages.has(cursor)) throw new Error('Official usage pagination did not advance.')
          pages.add(cursor)
        }
        throw new Error('Organization report is too large. Configure a project filter or a shorter period.')
      })()
      reports.set(key, promise)
      return promise
    }
    const monthlyStart = periodStart('month', end)
    const monthlyScope = async (projectId: string): Promise<BillingScope> => {
      const id = projectId || 'organization', label = projectId ? `Project ${projectId}` : 'Organization'
      const old = previous?.billing?.start === monthlyStart ? previous.billing.scopes.find(s => s.id === id) : undefined
      const scope: BillingScope = { ...old, id, label, errors: {} }
      const path = projectId ? `projects/${encodeURIComponent(projectId)}/` : ''
      const [cost, limit, alerts] = await Promise.allSettled([
        (async () => {
          const buckets = await read('costs', ['project_id'], monthlyStart, projectId)
          let usd = 0
          for (const bucket of buckets) for (const row of bucket.results) {
            if (!row.amount || row.amount.currency.toUpperCase() !== 'USD') throw new Error('Monthly cost currency or amount was not reported; allowance cannot be calculated.')
            if (projectId && row.project_id && row.project_id !== projectId) throw new Error('Monthly cost scope did not match the requested project.')
            usd += row.amount.value
          }
          return { usd, start: monthlyStart, end, refreshedAt: end, sampleId }
        })(),
        (async () => {
          const parsed = limitSchema.safeParse(await this.json(admin, new URL(`https://api.openai.com/v1/organization/${path}spend_limit`), signal))
          if (!parsed.success || parsed.data.object !== (projectId ? 'project.spend_limit' : 'organization.spend_limit')) throw new Error('Spend limit response was not supported; no remaining allowance is inferred.')
          const value = parsed.data
          return { thresholdAmount: value.threshold_amount, currency: value.currency, interval: value.interval, enforcement: value.enforcement.status, refreshedAt: end, sampleId }
        })(),
        (async () => {
          const values: NonNullable<BillingScope['alerts']>['values'] = [], cursors = new Set<string>()
          let after: string | undefined
          for (let page = 0; page < 50; page++) {
            const url = new URL(`https://api.openai.com/v1/organization/${path}spend_alerts`)
            url.searchParams.set('limit', '100'); url.searchParams.set('order', 'asc')
            if (after) url.searchParams.set('after', after)
            const parsed = alertPageSchema.safeParse(await this.json(admin, url, signal))
            if (!parsed.success) throw new Error('Spend alerts returned an invalid response.')
            for (const alert of parsed.data.data) values.push({ id: alert.id, thresholdAmount: alert.threshold_amount, currency: alert.currency, interval: alert.interval })
            if (!parsed.data.has_more) return { values, refreshedAt: end }
            after = parsed.data.last_id ?? undefined
            if (!after || cursors.has(after)) throw new Error('Spend alert pagination did not advance.')
            cursors.add(after)
          }
          throw new Error('Spend alert report exceeded the supported page limit.')
        })(),
      ])
      if (cost.status === 'fulfilled') scope.cost = cost.value; else scope.errors.cost = this.safeError(cost.reason)
      if (limit.status === 'fulfilled') scope.limit = limit.value; else scope.errors.limit = this.safeError(limit.reason)
      if (alerts.status === 'fulfilled') scope.alerts = alerts.value; else scope.errors.alerts = this.safeError(alerts.reason)
      return scope
    }
    const [usageReport, scopes] = await Promise.allSettled([
      Promise.all([read('usage/completions', ['model', 'project_id']), read('costs', ['project_id'])]).then(([usage, costs]) => this.usageReport(usage, costs, start, end, admin.projectId)),
      Promise.all([monthlyScope(''), ...(admin.projectId ? [monthlyScope(admin.projectId)] : [])]),
    ])
    // Billing endpoint failures are isolated inside each scope. Preserve the last valid period report independently.
    const billing: OpenAIBillingSnapshot | undefined = scopes.status === 'fulfilled' ? { start: monthlyStart, end, scopes: scopes.value } : previous?.billing
    if (usageReport.status === 'rejected') return { ...(previous ?? { metrics: [], start, end, refreshedAt: 0, scope: admin.projectId || 'Authorized organization' }), billing, stale: true, error: this.safeError(usageReport.reason) }
    return { ...usageReport.value, billing }
  }
  private safeError(error: unknown): string {
    if (error instanceof Error && error.name === 'TimeoutError') return 'Official billing request timed out. Cached data is retained.'
    // Only our static validation errors are exposed; network errors can include URLs or request details.
    return error instanceof Error && /^(Admin credential|Permission required|Requested billing|Official usage|Organization report|Monthly cost|Spend limit|Spend alert)/.test(error.message) ? error.message : 'Official billing refresh failed. Cached data is retained.'
  }
  private usageReport(usage: z.infer<typeof pageSchema>['data'], costs: z.infer<typeof pageSchema>['data'], start: number, end: number, projectId: string): OrganizationUsageSnapshot {
    const totals = new Map<string, UsageMetric>()
    const scopeLabel = projectId ? 'Project' : 'Organization'
    const period = `${new Date(start).toISOString().slice(0,10)} – ${new Date(end).toISOString().slice(0,10)} (UTC)`
    const add = (id: string, label: string, value: number | undefined, unit: string) => {
      if (value === undefined) return
      const metric = totals.get(id) ?? { id, label, value: 0, unit, period }
      metric.value += value; totals.set(id, metric)
    }
    for (const bucket of usage) for (const row of bucket.results) {
      add('org-input', `${scopeLabel} input tokens`, row.input_tokens, 'tokens'); add('org-output', `${scopeLabel} output tokens`, row.output_tokens, 'tokens')
      add('org-cache', `${scopeLabel} cached input tokens`, row.input_cached_tokens, 'tokens'); add('org-requests', `${scopeLabel} model requests`, row.num_model_requests, 'requests')
      if (row.model) add(`org-model:${row.model}`, `${scopeLabel} · ${row.model}`, (row.input_tokens ?? 0) + (row.output_tokens ?? 0), 'tokens')
      if (row.project_id) add(`org-project:${row.project_id}`, `Project · ${row.project_id}`, (row.input_tokens ?? 0) + (row.output_tokens ?? 0), 'tokens')
    }
    for (const bucket of costs) for (const row of bucket.results) if (row.amount) add(`org-cost:${row.amount.currency}`, `Reported ${scopeLabel.toLowerCase()} cost`, row.amount.value, row.amount.currency.toUpperCase())
    return { metrics: [...totals.values()], start, end, refreshedAt: Date.now(), scope: projectId || 'Authorized organization' }
  }
}
