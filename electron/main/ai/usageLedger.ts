import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { aggregateUsage, usageRecordSchema, type UsageQuery, type UsageRecord, type UsageProvider, type UsageSink, type RequestUsage } from '../../../shared/providerUsage'
import type { StreamOptions } from './AIProvider'
import { log } from '../logger'

export const apiUsageAccount = (key: string) => `key:${createHash('sha256').update(`athena-usage:${key}`).digest('hex').slice(0, 24)}`
export class UsageLedger {
  private records = new Map<string, UsageRecord>()
  private file: string
  private error?: string
  private damaged = false
  constructor(private directory: string) {
    this.file = join(directory, 'provider-usage.json')
    if (existsSync(this.file)) {
      // Never overwrite an unreadable ledger with empty totals.
      try {
        const data = z.object({ version: z.literal(1), records: z.array(usageRecordSchema) }).parse(JSON.parse(readFileSync(this.file, 'utf8')))
        for (const r of data.records) this.records.set(r.id, r.status === 'pending' ? { ...r, status: 'interrupted' } : r)
      } catch { this.damaged = true; this.error = 'Saved usage history could not be read. The original file is preserved; displayed receipts may be incomplete.' }
    }
  }
  private save() {
    if (this.damaged) return
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, records: [...this.records.values()] }), { mode: 0o600 })
      renameSync(`${this.file}.tmp`, this.file); this.error = undefined
    } catch { this.error = 'Usage could not be saved to disk. Current in-memory receipts are retained; check application storage access.'; log('usage.storage_failed') }
  }
  forAccount(provider: UsageProvider, accountId: string): UsageSink { return record => this.record({ ...record, provider, accountId }) }
  record(record: UsageRecord) {
    const r = usageRecordSchema.parse(record)
    const existing = r.responseId ? [...this.records.values()].find(old => old.provider === r.provider && old.accountId === r.accountId && old.responseId === r.responseId) : undefined
    // A terminal receipt wins over a duplicate event or stale pending update.
    if (existing && existing.id !== r.id) { this.records.delete(r.id); this.save(); return }
    const previous = this.records.get(r.id)
    if (previous && previous.status !== 'pending' && r.status === 'pending') return
    this.records.set(r.id, r); this.save()
  }
  snapshot(query: Omit<UsageQuery, 'refresh'> & { accountId: string }) { return { ...aggregateUsage([...this.records.values()], query), ...(this.error ? { error: this.error } : {}) } }
  importHistory(directory: string) {
    const archives = join(directory, 'conversation-archive')
    const files = [join(directory, 'conversations.json'), ...(existsSync(archives) ? readdirSync(archives).filter(f => f.endsWith('.json')).map(f => join(archives, f)) : [])]
    for (const file of files) {
      if (!existsSync(file)) continue
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        for (const session of data.sessions ?? [data]) for (const message of session.messages ?? []) {
          const e = message.execution, u = e?.providerUsage, provider = e?.providerId
          if (!u || !['chatgpt-subscription', 'openai-api'].includes(provider)) continue
          const executionId = e.taskCheckpoint?.executionId ?? message.id
          if ([...this.records.values()].some(r => r.conversationId === session.id && r.executionId === executionId && r.source === 'openai-response')) continue
          const accountId = provider === 'chatgpt-subscription' ? String(e.accountId ?? 'historical-unassigned').replace(/^subscription:/, '') : 'historical-unassigned'
          const id = `legacy:${session.id}:${message.id}`
          if (this.records.has(id)) continue
          const known = !u.estimated && Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens)
          this.records.set(id, usageRecordSchema.parse({ id, provider, accountId, model: e.modelId ?? 'Not recorded', conversationId: session.id, executionId,
            responseId: null, timestamp: message.createdAt, updatedAt: u.updatedAt, source: 'legacy-conversation', status: 'unknown',
            requestCount: u.requestCount + (u.incompleteRequests ?? 0), inputTokens: known ? u.inputTokens : null, outputTokens: known ? u.outputTokens : null,
            cachedInputTokens: known ? u.cachedInputTokens ?? null : null, reasoningTokens: known ? u.reasoningTokens ?? null : null, totalTokens: known ? u.inputTokens + u.outputTokens : null }))
        }
      } catch { log('usage.history_import_failed') }
    }
    this.save()
  }
}

/** Request lifecycle shared by normal generation, tool rounds and compaction. */
export class UsageRecorder {
  private active?: RequestUsage
  private seen = new Set<string>()
  constructor(private model: string, private options: StreamOptions, private sink?: UsageSink) {}
  private publish() { if (this.active && this.sink) { try { this.sink({ ...this.active }) } catch { log('usage.receipt_failed') } } }
  begin() {
    this.fail()
    this.active = { id: randomUUID(), model: this.model, executionId: this.options.executionId ?? randomUUID(), conversationId: this.options.conversationId ?? 'unassigned', responseId: null,
      timestamp: Date.now(), updatedAt: Date.now(), status: 'pending', source: 'openai-response', requestCount: 1,
      inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null }
    this.publish()
  }
  metadata(response: { id?: string; model?: string }) {
    if (!this.active) return
    if (response.id) this.active.responseId = response.id
    if (response.model) this.active.model = response.model
  }
  finish(usage: unknown, response: { id?: string; model?: string; status?: string } = {}): boolean {
    if (response.id && this.seen.has(response.id)) return false
    if (response.id) this.seen.add(response.id)
    if (!this.active) return true // Context/budget-only callers retain their existing behavior.
    this.metadata(response)
    const u = usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | undefined
    const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
    if (u && finite(u.input_tokens) && finite(u.output_tokens)) {
      this.active.inputTokens = u.input_tokens; this.active.outputTokens = u.output_tokens
      this.active.totalTokens = finite(u.total_tokens) ? u.total_tokens : u.input_tokens + u.output_tokens
      this.active.cachedInputTokens = finite(u.input_tokens_details?.cached_tokens) ? Math.min(u.input_tokens, u.input_tokens_details.cached_tokens) : null
      this.active.reasoningTokens = finite(u.output_tokens_details?.reasoning_tokens) ? Math.min(u.output_tokens, u.output_tokens_details.reasoning_tokens) : null
    }
    this.active.status = response.status === 'failed' ? 'failed' : response.status === 'incomplete' ? 'incomplete' : 'completed'
    this.active.updatedAt = Date.now(); this.publish(); this.active = undefined
    return true
  }
  fail() {
    if (!this.active) return
    this.active.status = this.options.signal?.aborted ? 'cancelled' : 'failed'
    this.active.updatedAt = Date.now(); this.publish(); this.active = undefined
  }
}
