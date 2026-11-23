import { z } from 'zod'

export const streamFailureKindSchema = z.enum([
  'connection_interrupted', 'connection_reset', 'unexpected_eof', 'malformed_stream',
  'connection_timeout', 'request_initialization_timeout', 'first_event_timeout', 'request_timeout', 'stream_inactivity', 'task_deadline', 'authentication_expired', 'quota_exhausted',
  'provider_unavailable', 'rate_limited', 'context_exceeded', 'user_cancelled',
  'tool_failed', 'provider_failed', 'unknown',
])
export type StreamFailureKind = z.infer<typeof streamFailureKindSchema>

export const streamPhaseSchema = z.enum(['preparing', 'connecting', 'waiting-model', 'streaming', 'running-tools', 'waiting-approval', 'waiting-subagents', 'recovering', 'cancelling', 'disconnected', 'paused'])
export type StreamPhase = z.infer<typeof streamPhaseSchema>

/** Safe to display or export: identifiers and counters only, never request or response bodies. */
export const streamDiagnosticSchema = z.object({
  provider: z.string().regex(/^[a-z0-9-]{1,80}$/), model: z.string().max(100), executionId: z.string().max(100).optional(),
  correlationId: z.string().uuid(), requestId: z.string().max(120).optional(), round: z.number().int().nonnegative(),
  stage: z.enum(['request', 'response_stream', 'tool_execution', 'context_compaction']),
  kind: streamFailureKindSchema, durationMs: z.number().nonnegative(),
  timeToFirstEventMs: z.number().nonnegative().optional(), sinceLastEventMs: z.number().nonnegative().optional(),
  configuredTimeoutMs: z.number().nonnegative().optional(),
  conversationId: z.string().max(100).optional(), reasoningEffort: z.string().max(32).optional(), agentMode: z.string().max(40).optional(),
  exceptionName: z.string().max(60).optional(), causeCode: z.string().max(80).optional(),
  lastEventType: z.string().max(80).optional(), lastEventAt: z.number().optional(),
  httpStatus: z.number().int().optional(), providerCode: z.string().max(80).optional(),
  providerParam: z.string().max(120).optional(), responseId: z.string().max(120).optional(),
  responseModel: z.string().max(100).optional(), responseStatus: z.string().max(40).optional(),
  failureEventType: z.enum(['response.failed', 'error', 'sdk_stream_error']).optional(),
  accountId: z.string().uuid().optional(), registrationRef: z.string().regex(/^[a-f0-9]{12}$/).optional(),
  modelSource: z.enum(['conversation', 'account-default']).optional(),
  workspace: z.literal('registration-bound-not-disclosed').optional(),
  quota: z.literal('unknown').optional(),
  abortReason: z.enum(['none', 'user', 'task_deadline', 'stream_inactivity', 'connection_timeout', 'request_initialization_timeout', 'first_event_timeout']).default('none'),
  contextTokens: z.number().nonnegative().optional(), contextWindow: z.number().positive().optional(),
  completedTools: z.number().int().nonnegative(), fileChanges: z.number().int().nonnegative(),
  recoveryAttempt: z.number().int().nonnegative(), willRetry: z.boolean(),
})
export type StreamDiagnostic = z.infer<typeof streamDiagnosticSchema>
