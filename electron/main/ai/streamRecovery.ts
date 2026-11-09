import OpenAI from 'openai'
import { ChatError } from './AIProvider'
import { chatGPTErrorDetails } from './chatGPTErrors'
import type { StreamFailureKind } from '../../../shared/streamDiagnostics'

export class StreamFault extends ChatError {
  constructor(readonly kind: StreamFailureKind, message: string) { super(message) }
}

function causeCode(error: unknown): string {
  const candidate = error as { cause?: { code?: unknown } }
  return typeof candidate?.cause?.code === 'string' ? candidate.cause.code : ''
}

export function classifyStreamFailure(error: unknown): StreamFailureKind {
  if (error instanceof StreamFault) return error.kind
  if (error instanceof OpenAI.APIUserAbortError || error instanceof Error && error.name === 'AbortError') return 'user_cancelled'
  if (error instanceof Error && error.name === 'TimeoutError') return 'task_deadline'
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'request_timeout'
  if (error instanceof OpenAI.APIConnectionError) return /(?:ECONNRESET|UND_ERR_SOCKET|EPIPE)/i.test(causeCode(error)) ? 'connection_reset' : 'connection_interrupted'
  if (error instanceof SyntaxError) return 'malformed_stream'
  if (error instanceof OpenAI.APIError) {
    const { code, status } = chatGPTErrorDetails(error)
    if (['token_expired', 'invalid_grant', 'invalid_refresh_token'].includes(code ?? '') || status === 401) return 'authentication_expired'
    if (['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded'].includes(code ?? '')) return 'context_exceeded'
    if (code === 'subscription_sharing_usage_limit_exceeded' || code === 'rate_limit_exceeded' || code === 'slow_down' || status === 429) return 'rate_limited'
    if (status === 503 || status !== undefined && status >= 500 || code === 'server_is_overloaded' || code === 'subscription_sharing_usage_unavailable') return 'provider_unavailable'
    return 'provider_failed'
  }
  return 'unknown'
}

export function recoverableStreamFailure(error: unknown): boolean {
  return ['connection_interrupted', 'connection_reset', 'unexpected_eof', 'request_timeout', 'stream_inactivity', 'provider_unavailable'].includes(classifyStreamFailure(error))
    || error instanceof StreamFault && error.kind === 'provider_failed'
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
