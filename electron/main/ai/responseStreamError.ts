import OpenAI from 'openai'
import type { ResponseErrorEvent, ResponseFailedEvent } from 'openai/resources/responses/responses'
import { StreamFault } from './streamRecovery'
import { safeResponseMetadata, withChatGPTErrorContext } from './chatGPTErrors'

/** Preserve structured SSE failure details for the existing provider classifiers. */
export function responseStreamError(event: ResponseErrorEvent | ResponseFailedEvent) {
  const raw = event.type === 'response.failed' ? event.response?.error : (event as ResponseErrorEvent & { error?: unknown }).error ?? event
  const body = raw && typeof raw === 'object' ? raw : { message: typeof raw === 'string' ? raw : 'The provider ended the response without error details.' }
  const candidate = body as Record<string, unknown>
  const nested = candidate.error && typeof candidate.error === 'object' ? candidate.error as Record<string, unknown> : undefined
  const error = typeof candidate.code !== 'string' && typeof nested?.code !== 'string'
    ? new StreamFault('provider_failed', 'The provider ended this response without a machine-readable error. Athena preserved completed actions and can retry the unfinished model response from its last verified checkpoint.')
    : new OpenAI.APIError(undefined, body, undefined, new Headers())
  withChatGPTErrorContext(error, { failureEventType: event.type,
    ...(event.type === 'response.failed' ? safeResponseMetadata(event.response) : {}) })
  return error
}
