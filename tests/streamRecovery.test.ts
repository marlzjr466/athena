// @vitest-environment node
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { classifyStreamFailure, recoverableStreamFailure, StreamFault } from '../electron/main/ai/streamRecovery'
import { responseStreamError } from '../electron/main/ai/responseStreamError'

describe('ChatGPT response stream classification', () => {
  it('keeps a code-less terminal failure distinct from a completed response', () => {
    const error = responseStreamError({ type: 'response.failed', response: { error: null } } as never)
    expect(classifyStreamFailure(error)).toBe('provider_failed')
    expect(recoverableStreamFailure(error)).toBe(true)
  })
  it('separates transport resets, timeouts, parse errors and EOF', () => {
    const reset = new OpenAI.APIConnectionError({ cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) })
    expect(classifyStreamFailure(reset)).toBe('connection_reset')
    expect(classifyStreamFailure(new OpenAI.APIConnectionTimeoutError())).toBe('request_timeout')
    expect(classifyStreamFailure(new SyntaxError('secret input'))).toBe('malformed_stream')
    expect(classifyStreamFailure(new StreamFault('unexpected_eof', 'closed'))).toBe('unexpected_eof')
  })
  it('never retries authentication, account limit or context exhaustion as a transient stream failure', () => {
    for (const [status, code, kind] of [[401, 'token_expired', 'authentication_expired'], [429, 'subscription_sharing_usage_limit_exceeded', 'rate_limited'], [400, 'context_length_exceeded', 'context_exceeded']] as const) {
      const error = new OpenAI.APIError(status, { code }, undefined, new Headers())
      expect(classifyStreamFailure(error)).toBe(kind)
      expect(recoverableStreamFailure(error)).toBe(false)
    }
    const limit = responseStreamError({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } } as never)
    expect(classifyStreamFailure(limit)).toBe('rate_limited')
    expect(recoverableStreamFailure(limit)).toBe(false)
  })
  it('classifies user cancellation separately and never retries it', () => {
    const cancelled = new DOMException('cancelled', 'AbortError')
    expect(classifyStreamFailure(cancelled)).toBe('user_cancelled')
    expect(recoverableStreamFailure(cancelled)).toBe(false)
  })
})
