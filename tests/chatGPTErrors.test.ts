// @vitest-environment node
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { chatGPTErrorDetails, chatGPTErrorMessage, chatGPTProviderError, chatGPTResponseError } from '../electron/main/ai/chatGPTErrors'

describe('ChatGPT subscription error classification', () => {
  it.each(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])('recognizes standard OAuth %s responses', async code => {
    const body = { error: code, error_description: 'private subject Bearer secret-refresh-value' }
    const error = await chatGPTResponseError(new Response(JSON.stringify(body), { status: 400, headers: { 'x-request-id': 'req_oauth' } }), 'oauth_refresh')
    expect(error.code).toBe('auth-reconnect')
    expect(error.userMessage).toContain(code)
    expect(error.userMessage).toContain('Reference: req_oauth')
    expect(error.userMessage).not.toMatch(/private subject|secret-refresh|Refresh models/)
    expect(chatGPTErrorDetails({ status: 400, error: body }).code).toBe(code)
  })
  it('distinguishes unknown token-endpoint errors and invalid client configuration from models', async () => {
    const unknown = await chatGPTResponseError(new Response('unavailable', { status: 400 }), 'oauth_refresh')
    expect(unknown.userMessage).toContain('token renewal failed')
    expect(unknown.code).toBeUndefined()
    const client = await chatGPTResponseError(new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 }), 'oauth_refresh')
    expect(client.userMessage).toContain('OAuth client registration')
    expect(client.code).toBeUndefined()
  })
  it('distinguishes a confirmed shared/app usage limit from an ordinary 429', () => {
    expect(chatGPTErrorMessage({ status: 429, requestId: 'req_usage' })).toContain('temporarily rate-limited')
    expect(chatGPTErrorMessage({ status: 429, code: 'subscription_sharing_usage_limit_exceeded', requestId: 'req_usage' })).toContain('plan usage limit reached')
    expect(chatGPTErrorMessage({ status: 429, code: 'subscription_sharing_usage_limit_exceeded', requestId: 'req_usage' })).toContain('Reference: req_usage')
    expect(chatGPTErrorMessage({ code: 'subscription_sharing_usage_limit_exceeded' })).toContain('exact quota is unknown')
    expect(chatGPTErrorMessage({ code: 'subscription_sharing_usage_limit_exceeded' })).not.toContain('HTTP 429')
  })

  it('classifies temporary availability and unsupported-capability failures', () => {
    expect(chatGPTErrorMessage({ status: 503, code: 'subscription_sharing_usage_unavailable' })).toContain('temporarily unavailable')
    expect(chatGPTErrorMessage({ status: 400, code: 'subscription_sharing_unsupported_capability', param: 'temperature' })).toContain('parameter: temperature')
    expect(chatGPTErrorMessage({ status: 400, code: 'invalid_function_parameters' })).toContain('tool schema')
  })

  it('preserves status, code and request ID without exposing provider text', async () => {
    const error = await chatGPTResponseError(new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private-key' } }), { status: 429, headers: { 'x-request-id': 'req_safe' } }), 'test')
    expect(error.userMessage).toContain('subscription_sharing_usage_limit_exceeded')
    expect(error.userMessage).toContain('Reference: req_safe')
    expect(error.userMessage).not.toContain('private-key')
  })
  it('classifies terminal refresh failures as reconnectable without exposing the token response', async () => {
    const error = await chatGPTResponseError(new Response(JSON.stringify({ error: { code: 'invalid_grant', message: 'private-refresh-token' } }), { status: 400 }), 'oauth_refresh')
    expect(error.code).toBe('auth-reconnect')
    expect(error.userMessage).toContain('Reconnect')
    expect(error.userMessage).not.toContain('private-refresh-token')
  })

  it('uses the SDK request ID for streamed API errors', () => {
    const error = new OpenAI.APIError(403, { code: 'subscription_sharing_user_not_eligible' }, undefined, new Headers({ 'x-request-id': 'req_denied' }))
    expect(chatGPTProviderError(error).userMessage).toContain('Reference: req_denied')
    expect(chatGPTProviderError(error).userMessage).toContain('not eligible')
  })
  it('unwraps nested SSE errors and does not advise reconnection for an unidentified stream failure', () => {
    const nested = new OpenAI.APIError(undefined, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private-key' } }, undefined, new Headers())
    expect(chatGPTProviderError(nested).userMessage).toContain('plan usage limit reached')
    expect(chatGPTProviderError(nested).userMessage).not.toContain('private-key')
    const unidentified = new OpenAI.APIError(undefined, { message: 'private-key' }, undefined, new Headers())
    expect(chatGPTProviderError(unidentified).userMessage).toContain('provider error with no status or code')
    expect(chatGPTProviderError(unidentified).userMessage).not.toContain('Reconnect or choose')
    expect(chatGPTProviderError(unidentified).userMessage).not.toContain('private-key')
  })
})
