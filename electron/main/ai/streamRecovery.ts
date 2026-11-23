import OpenAI from 'openai'
import { ChatError } from './AIProvider'
import { chatGPTErrorDetails } from './chatGPTErrors'
import type { StreamFailureKind } from '../../../shared/streamDiagnostics'
import type { StreamDiagnostic } from '../../../shared/streamDiagnostics'
import type { StreamOptions } from './AIProvider'
import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { contextDefaults } from '../../../shared/context'

export class StreamFault extends ChatError {
  constructor(readonly kind: StreamFailureKind, message: string, readonly timing?: { configuredTimeoutMs?: number; timeToFirstEventMs?: number; sinceLastEventMs?: number }) { super(message) }
}

function causes(error: unknown): object[] {
  const found: object[] = [], pending = [error], seen = new Set<unknown>()
  while (pending.length && found.length < 12) {
    const value = pending.shift()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value); found.push(value)
    const item = value as { cause?: unknown; errors?: unknown[] }
    pending.push(item.cause, ...(Array.isArray(item.errors) ? item.errors.slice(0, 8) : []))
  }
  return found
}
export function causeCode(error: unknown): string {
  for (const value of causes(error).reverse()) {
    const code = (value as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code)) return code
  }
  return ''
}
export function streamFaultTiming(error: unknown) {
  const fault = causes(error).find(value => value instanceof StreamFault)
  return fault instanceof StreamFault ? fault.timing ?? {} : {}
}

export function transportFailureMessage(error: unknown): string | undefined {
  const stage = {
    connection_timeout: 'The network connection could not be established before the socket deadline.',
    request_initialization_timeout: 'The provider did not return response headers before the request initialization deadline.',
    first_event_timeout: 'The provider connected but did not send its first response activity before the deadline.',
    stream_inactivity: 'The provider stopped sending response activity and the stream inactivity deadline was reached.',
  }[classifyStreamFailure(error) as string]
  return stage ? `${stage} Completed operations are preserved; resume the unfinished task from its checkpoint.` : undefined
}

export function safeExceptionMetadata(error: unknown): { exceptionName?: string; causeCode?: string } {
  const names = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'AbortError', 'TimeoutError', 'APIError', 'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError'])
  return { exceptionName: error instanceof Error ? names.has(error.name) ? error.name : 'Error' : undefined, causeCode: causeCode(error) || undefined }
}

export function reportTransportFailure(options: StreamOptions, error: unknown, started: number, stage: 'request' | 'response_stream', attempt: number, willRetry: boolean, httpStatus?: number) {
  const identity = options.reliabilityIdentity
  const kind = classifyStreamFailure(error)
  const policy = { ...contextDefaults(), ...options.contextSettings }
  const diagnostic: StreamDiagnostic = {
    provider: identity && /^[a-z0-9-]{1,80}$/.test(identity.provider) ? identity.provider : 'api',
    model: identity?.model.slice(0, 100) ?? 'configured-model', executionId: options.executionId,
    correlationId: randomUUID(), round: options.continuation?.state.toolRounds ?? 0,
    stage, kind: options.signal?.aborted ? classifyStreamFailure(options.signal.reason) : kind,
    conversationId: options.conversationId, reasoningEffort: options.effort, agentMode: options.permissionMode,
    configuredTimeoutMs: kind === 'connection_timeout' ? policy.socketConnectionSeconds * 1000 : undefined,
    ...safeExceptionMetadata(error), ...streamFaultTiming(error), durationMs: Math.max(0, Date.now() - started),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    abortReason: options.signal?.aborted ? options.signal.reason instanceof StreamFault && options.signal.reason.kind === 'task_deadline' ? 'task_deadline' : 'user' : 'none',
    ...(options.diagnosticCounts?.() ?? { completedTools: 0, fileChanges: 0 }),
    recoveryAttempt: attempt, willRetry,
  }
  options.onStreamDiagnostic?.(diagnostic)
  log('ai.transport_failure', { ...diagnostic, executionId: diagnostic.executionId ?? 'isolated' })
}

export function classifyStreamFailure(error: unknown): StreamFailureKind {
  const fault = causes(error).find(value => value instanceof StreamFault)
  if (fault instanceof StreamFault) return fault.kind
  const code = causeCode(error)
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'connection_timeout'
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return 'request_initialization_timeout'
  if (code === 'UND_ERR_BODY_TIMEOUT') return 'stream_inactivity'
  if (error instanceof OpenAI.APIUserAbortError || error instanceof Error && error.name === 'AbortError') return 'user_cancelled'
  if (error instanceof Error && error.name === 'TimeoutError') return 'request_timeout'
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'request_timeout'
  if (error instanceof OpenAI.APIConnectionError) return /(?:ECONNRESET|UND_ERR_SOCKET|EPIPE)/i.test(causeCode(error)) ? 'connection_reset' : 'connection_interrupted'
  // fetch response-body failures are raw TypeErrors, not SDK connection
  // errors. Classify by the OS/Undici cause, never by arbitrary message text.
  if (/^(?:ECONNRESET|UND_ERR_SOCKET|EPIPE)$/.test(causeCode(error))) return 'connection_reset'
  if (code === 'ETIMEDOUT') return 'request_timeout'
  if (/^(?:ECONNREFUSED|EAI_AGAIN|ENOTFOUND)$/.test(code)) return 'connection_interrupted'
  if (error instanceof SyntaxError) return 'malformed_stream'
  if (error instanceof OpenAI.APIError) {
    const { code, status } = chatGPTErrorDetails(error)
    if (['token_expired', 'invalid_grant', 'invalid_refresh_token'].includes(code ?? '') || status === 401) return 'authentication_expired'
    if (['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded'].includes(code ?? '')) return 'context_exceeded'
    if (['subscription_sharing_usage_limit_exceeded', 'insufficient_quota', 'billing_hard_limit_reached'].includes(code ?? '')) return 'quota_exhausted'
    if (code === 'rate_limit_exceeded' || code === 'slow_down' || status === 429) return 'rate_limited'
    if (status === 503 || status !== undefined && status >= 500 || code === 'server_is_overloaded' || code === 'subscription_sharing_usage_unavailable') return 'provider_unavailable'
    return 'provider_failed'
  }
  return 'unknown'
}

export function recoverableStreamFailure(error: unknown): boolean {
  if ((error as { headers?: Headers })?.headers?.has?.('retry-after')) return false
  return ['connection_timeout', 'request_initialization_timeout', 'first_event_timeout', 'connection_interrupted', 'connection_reset', 'unexpected_eof', 'request_timeout', 'stream_inactivity', 'provider_unavailable'].includes(classifyStreamFailure(error))
}

/** Backoff is cancellable and bounded; it never replays a tool call. */
export async function streamRecoveryPause(attempt: number, signal: AbortSignal): Promise<void> {
  const delay = Math.min(4000, 300 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 150)
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, delay)
    const cancel = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
  })
}
