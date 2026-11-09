import OpenAI from 'openai'
import { ChatError } from './AIProvider'
import { log } from '../logger'

export interface ChatGPTErrorDetails {
  status?: number
  code?: string
  param?: string
  requestId?: string
  providerMessage?: string
  responseId?: string
  responseModel?: string
  responseStatus?: string
  failureEventType?: 'response.failed' | 'error' | 'sdk_stream_error'
}

export const safeIdentifier = (value: unknown, max = 120): string | undefined => {
  if (typeof value !== 'string' || /^(?:sk-|sess-|oai-|eyJ)/i.test(value) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value)) return undefined
  return value.slice(0, max)
}

const redactedMessage = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(?:sk|sess|oai)-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

// Out-of-band, allowlisted context survives SDK error wrapping without retaining
// response bodies, headers, identity claims, or conversation contents.
const contexts = new WeakMap<object, Partial<ChatGPTErrorDetails>>()
export function withChatGPTErrorContext(error: unknown, context: Partial<ChatGPTErrorDetails>): unknown {
  if (error && typeof error === 'object') contexts.set(error, { ...contexts.get(error), ...context })
  return error
}
export function safeResponseMetadata(value: unknown): Pick<ChatGPTErrorDetails, 'responseId' | 'responseModel' | 'responseStatus'> {
  const response = objectValue(value)
  return { responseId: safeIdentifier(response?.id), responseModel: safeIdentifier(response?.model, 100),
    responseStatus: ['queued', 'in_progress', 'completed', 'failed', 'incomplete', 'cancelled'].includes(String(response?.status)) ? String(response?.status) : undefined }
}

export function chatGPTErrorDetails(error: unknown): ChatGPTErrorDetails {
  const candidate = objectValue(error)
  const body = objectValue(candidate?.error)
  // Some SSE failures arrive wrapped twice. The SDK preserves the outer
  // envelope in APIError.error, so inspect it without exposing provider text.
  const nested = objectValue(body?.error)
  const response = objectValue(candidate?.response ?? body?.response)
  const responseError = objectValue(response?.error)
  const headers = candidate?.headers instanceof Headers ? candidate.headers : undefined
  const status = typeof candidate?.status === 'number' ? candidate.status : undefined
  const code = safeIdentifier(candidate?.code ?? body?.code ?? nested?.code ?? responseError?.code)
  const param = safeIdentifier(candidate?.param ?? body?.param ?? nested?.param ?? responseError?.param)
  const requestId = safeIdentifier(candidate?.requestID ?? candidate?.request_id ?? body?.request_id ?? nested?.request_id ?? headers?.get('x-request-id'))
  const providerMessage = redactedMessage(nested?.message ?? body?.message ?? candidate?.message)
  const context = candidate ? contexts.get(candidate) : undefined
  const metadata = safeResponseMetadata(response)
  return { ...context, status: status ?? context?.status, code, param, requestId: requestId ?? context?.requestId, providerMessage,
    responseId: metadata.responseId ?? safeIdentifier(candidate?.response_id ?? body?.response_id ?? nested?.response_id) ?? context?.responseId,
    responseModel: metadata.responseModel ?? context?.responseModel, responseStatus: metadata.responseStatus ?? context?.responseStatus }
}

const reference = (details: ChatGPTErrorDetails): string => details.requestId ? ` Reference: ${details.requestId}.` : ''
const statusLabel = (details: ChatGPTErrorDetails): string => details.status ? `HTTP ${details.status}` : 'stream response'
const codeLabel = (details: ChatGPTErrorDetails): string => details.code ? ` (${details.code})` : ''

export function logChatGPTError(details: ChatGPTErrorDetails, operation = 'inference'): void {
  log('chatgpt.subscription_error', {
    operation,
    status: details.status ?? 0,
    code: details.code ?? 'unspecified',
    param: details.param ?? 'none',
    requestId: details.requestId ?? 'none',
    // Keep a presence bit only. Provider text can contain user or credential-shaped data.
    providerMessage: details.providerMessage ? 'present' : 'none',
  })
}

export function chatGPTErrorMessage(details: ChatGPTErrorDetails): string {
  const code = details.code
  if (['invalid_grant', 'invalid_refresh_token', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'token_expired'].includes(code ?? '')) return `ChatGPT authorization expired (${statusLabel(details)}${codeLabel(details)}). Reconnect the same account in Settings → AI; completed work is preserved.${reference(details)}`
  if (code === 'subscription_sharing_usage_limit_exceeded') {
    return `ChatGPT plan usage limit reached${codeLabel(details)}. The exact quota is unknown: this code alone does not identify a shared five-hour, weekly, or app-specific limit, remaining usage, or reset time. Open ChatGPT Settings → Usage for the same account and workspace used by this request, and review this app's limit. The connection is preserved; Athena did not retry or switch to API billing.${reference(details)}`
  }
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || details.status === 503) {
    return `ChatGPT plan usage is temporarily unavailable (${statusLabel(details)}${codeLabel(details)}). This is not confirmation that your plan is exhausted. Retry later; Athena did not switch to API billing.${reference(details)}`
  }
  if (code === 'subscription_sharing_user_not_eligible') {
    return `This ChatGPT account is not eligible for plan usage${codeLabel(details)}. Sign in with an eligible account or choose Local AI/API in Settings → AI.${reference(details)}`
  }
  if (code === 'subscription_sharing_unsupported_capability') {
    return `ChatGPT rejected a capability in this request${details.param ? ` (parameter: ${details.param})` : ''}${codeLabel(details)}. Refresh the account models or choose another supported model; Athena did not retry the same request.${reference(details)}`
  }
  if (code === 'subscription_sharing_route_not_supported') {
    return `ChatGPT rejected this subscription route${codeLabel(details)}. Athena is using the documented Responses endpoint; refresh the connection or choose another provider.${reference(details)}`
  }
  if (code === 'invalid_function_parameters') return `ChatGPT rejected an Athena tool schema${codeLabel(details)}. No desktop or project action ran; update Athena or report this diagnostic instead of changing accounts or API billing.${reference(details)}`
  if (code === 'subscription_sharing_invalid_user' || code === 'chatpass_v2_invalid_authorization_context' || code === 'chatpass_v2_scope_not_authorized') {
    return `ChatGPT authorization was not accepted${codeLabel(details)}. Reconnect the account in Settings → AI and confirm ChatGPT plan usage permission.${reference(details)}`
  }
  if (code === 'model_not_found' || code === 'model_not_available') return `This model is unavailable to your connected ChatGPT account${codeLabel(details)}. Refresh models in Settings → AI and choose one from the account catalog.${reference(details)}`
  if (code === 'rate_limit_exceeded' || code === 'slow_down') return `ChatGPT temporarily rate-limited this request (${statusLabel(details)}${codeLabel(details)}). Wait briefly and retry; this is not confirmation of plan exhaustion.${reference(details)}`
  if (code === 'server_is_overloaded') return `ChatGPT is temporarily overloaded (${statusLabel(details)}${codeLabel(details)}). Retry later; this is not confirmation of plan exhaustion.${reference(details)}`
  if (code === 'unsupported_parameter' || code === 'invalid_parameter' || code === 'invalid_value') return `ChatGPT rejected a generation setting${details.param ? ` (parameter: ${details.param})` : ''}${codeLabel(details)}. Choose a supported model or setting and retry.${reference(details)}`
  if (details.status === 401) return `ChatGPT authorization expired or was rejected (${statusLabel(details)}${codeLabel(details)}). Reconnect in Settings → AI.${reference(details)}`
  if (details.status === 403) return `ChatGPT plan usage was denied (${statusLabel(details)}${codeLabel(details)}). Verify the selected account, plan permission, workspace policy, and serving region in Settings → AI.${reference(details)}`
  if (details.status === 429) return `ChatGPT temporarily rate-limited this request (${statusLabel(details)}${codeLabel(details)}). Wait briefly and retry; this is not confirmation of plan exhaustion.${reference(details)}`
  if (details.status === 400 || details.status === 404) return `ChatGPT rejected the request (${statusLabel(details)}${codeLabel(details)}${details.param ? `; parameter: ${details.param}` : ''}). Refresh models or choose a supported model and retry.${reference(details)}`
  if (details.status && details.status >= 500) return `ChatGPT is temporarily unavailable (${statusLabel(details)}${codeLabel(details)}). Retry later.${reference(details)}`
  return `${details.code ? `ChatGPT reported provider failure ${details.code}.` : 'ChatGPT returned a provider error with no status or code.'} This does not establish that your login or model is invalid. Completed operations and file changes are preserved; review the sanitized connection diagnostics in Activity before continuing.${reference(details)}`
}

export function chatGPTProviderError(error: unknown, operation = 'inference'): ChatError {
  if (error instanceof ChatError) return error
  const details = chatGPTErrorDetails(error)
  logChatGPTError(details, operation)
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new ChatError('ChatGPT did not respond before the request timeout. Completed actions are preserved; retry the unfinished task from Activity.')
  if (error instanceof OpenAI.APIConnectionError) return new ChatError('The connection to ChatGPT was interrupted. Completed actions are preserved; retry the unfinished task from Activity.')
  if (error instanceof SyntaxError) return new ChatError('ChatGPT returned a malformed response stream. Completed actions are preserved; retry the unfinished task from Activity.')
  return new ChatError(chatGPTErrorMessage(details), details.status === 401 || details.code === 'token_expired' || details.code === 'subscription_sharing_invalid_user' ? 'auth-reconnect' : undefined)
}

export async function chatGPTResponseError(response: Response, operation: string): Promise<ChatError> {
  let body: unknown
  try { body = await response.clone().json() } catch { /* Some admission failures return plain text or no body. */ }
  const bodyObject = objectValue(body)
  const nested = objectValue(bodyObject?.error)
  const details: ChatGPTErrorDetails = {
    status: response.status,
    code: safeIdentifier(nested?.code ?? bodyObject?.code),
    param: safeIdentifier(nested?.param ?? bodyObject?.param),
    requestId: safeIdentifier(response.headers.get('x-request-id')),
    providerMessage: redactedMessage(nested?.message ?? bodyObject?.detail ?? bodyObject?.message ?? body),
  }
  logChatGPTError(details, operation)
  const reconnect = operation === 'oauth_refresh' && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(details.code ?? '')
  return new ChatError(chatGPTErrorMessage(details), reconnect ? 'auth-reconnect' : undefined)
}
