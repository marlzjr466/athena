import { createHash } from 'node:crypto'
import { SearchError, type SearchAttempt, type SearchStatus } from '../../../shared/searchOutcome'
import type { SearchResult } from './webSearchService'
import { ChatError } from './AIProvider'
import { log } from '../logger'

export interface SearchOutcome { ok: boolean; status: SearchStatus; results: SearchResult[]; queryId: string; message?: string; repeated?: boolean }
export const searchRecoveryGuidance = 'Empty or failed web search does not stop unrelated work. Use project tools for repository files and workflows. If external evidence is essential, reformulate the query; do not repeat an unsuccessful query. At most three unsuccessful queries are allowed per user request, including resume. Report unavailable evidence honestly; never invent sources or switch search providers.'

/** Shared by context preparation and agent tools. Only hashes/outcomes persist. */
export function createSearchRecovery(attempts: SearchAttempt[] = [], record: (attempts: SearchAttempt[]) => void = () => {}) {
  const history = [...attempts].slice(-24)
  const pending = new Map<string, Promise<SearchOutcome>>()
  return async (provider: string, query: string, news: boolean, signal: AbortSignal, execute: () => Promise<SearchResult[]>): Promise<SearchOutcome> => {
    signal.throwIfAborted()
    const category = news ? 'news' : 'general'
    const queryId = createHash('sha256').update(JSON.stringify([provider, category, query.trim().toLowerCase().replace(/\s+/g, ' ')])).digest('hex')
    const previous = history.find(attempt => attempt.queryId === queryId && attempt.status !== 'success')
    if (previous) {
      log('web.search_skipped', { provider, queryId, category, status: previous.status, reason: 'previous-unsuccessful-query', continuation: 'return-to-agent' })
      return { ok: previous.status === 'empty', status: previous.status, results: [], queryId, repeated: true, message: `This query already returned ${previous.status}; no network request was repeated. ${searchRecoveryGuidance}` }
    }
    const existing = pending.get(queryId)
    if (existing) return existing
    if (history.filter(attempt => attempt.provider === provider && attempt.status !== 'success').length >= 3) {
      log('web.search_skipped', { provider, queryId, category, status: 'retry-limit', reason: 'unsuccessful-query-allowance', continuation: 'return-to-agent' })
      return { ok: false, status: 'retry-limit', results: [], queryId, message: searchRecoveryGuidance }
    }
    const request = (async (): Promise<SearchOutcome> => {
      const started = Date.now()
      let outcome: SearchOutcome
      try {
        const results = await execute()
        signal.throwIfAborted()
        outcome = { ok: true, status: results.length ? 'success' : 'empty', results, queryId, ...(!results.length ? { message: searchRecoveryGuidance } : {}) }
      } catch (error) {
        signal.throwIfAborted()
        outcome = { ok: false, status: error instanceof SearchError ? error.code : 'unavailable', results: [], queryId, message: error instanceof SearchError ? error.message : error instanceof ChatError ? error.userMessage : 'The selected search service is unavailable. Continue local work; report missing external evidence.' }
      }
      history.push({ queryId, provider, category, status: outcome.status, at: Date.now() })
      record(history.slice(-24))
      log('web.search_outcome', { provider, queryId, category, intent: 'public-web', resultCount: outcome.results.length, durationMs: Date.now() - started, retryCount: history.filter(attempt => attempt.status !== 'success').length, continuation: 'return-to-agent', status: outcome.status })
      return outcome
    })()
    pending.set(queryId, request)
    // Cancellation must propagate; never cache a rejected promise for a future attempt.
    void request.catch(() => { pending.delete(queryId) })
    return request
  }
}
export type SearchRecovery = ReturnType<typeof createSearchRecovery>
