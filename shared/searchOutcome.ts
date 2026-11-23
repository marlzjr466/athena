import { z } from 'zod'

export const searchStatusSchema = z.enum(['success', 'empty', 'engine-unavailable', 'upstream-failure', 'http-error', 'timeout', 'invalid-response', 'disconnected', 'json-disabled', 'unavailable', 'retry-limit', 'local-intent'])
export type SearchStatus = z.infer<typeof searchStatusSchema>
export const searchAttemptSchema = z.object({ queryId: z.string().length(64), provider: z.string().max(50), category: z.enum(['general', 'news']), status: searchStatusSchema, at: z.number() })
export type SearchAttempt = z.infer<typeof searchAttemptSchema>

export class SearchError extends Error {
  constructor(readonly code: SearchStatus, message: string, readonly httpStatus?: number) { super(message) }
}
