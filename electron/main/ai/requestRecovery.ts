import type { StreamOptions } from './AIProvider'
import { continuationFor } from './continuationController'
import { recoverableStreamFailure, reportTransportFailure, StreamFault, streamRecoveryPause } from './streamRecovery'
import { withRequestPolicy } from './providerTransport'
import { log } from '../logger'

/** Retry only transport setup, before an adapter has consumed any text or tool
 * call. Partial streams and native agent sessions require explicit safe resume.
 * Authentication, quota/rate limits, invalid parameters and permissions are
 * never retried by this helper. A possible billed request remains recorded. */
export async function recoverProviderRequest<T>(options: StreamOptions, signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  const control = continuationFor(options)
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const started = Date.now()
    try {
      const response = await withRequestPolicy(options, request)
      if (!(response instanceof Response) || response.status < 500 || response.status > 599) return response
      // Do not override a provider-requested delay with a shorter retry.
      const retry = control.settings.safeTaskRecovery && attempt < control.settings.maxStreamRecoveries && !response.headers.has('retry-after') && control.recoverTransport()
      reportTransportFailure(options, new StreamFault('provider_unavailable', 'Provider unavailable.'), started, 'request', attempt + (retry ? 1 : 0), retry, response.status)
      if (!retry) return response
      await response.body?.cancel()
    } catch (error) {
      const value = error as { status?: number; code?: number; name?: string; headers?: Headers; cause?: { code?: string }; $metadata?: { httpStatusCode?: number } }
      const status = value?.status ?? value?.$metadata?.httpStatusCode ?? (typeof value?.code === 'number' ? value.code : undefined)
      const retryable = status !== undefined ? status >= 500 && status <= 599 : recoverableStreamFailure(error)
      const retry = !signal.aborted && retryable && control.settings.safeTaskRecovery && attempt < control.settings.maxStreamRecoveries && !value.headers?.has?.('retry-after') && control.recoverTransport()
      reportTransportFailure(options, error, started, 'request', attempt + (retry ? 1 : 0), retry, status)
      if (!retry) throw error
    }
    options.onModelRequestUnresolved?.()
    options.onStreamPhase?.('recovering')
    log('ai.request_recovery', { taskId: options.executionId ?? 'isolated', conversationId: options.conversationId ?? 'isolated', attempt: attempt + 1, stage: 'before-response', toolCallsReplayed: 0 })
    await streamRecoveryPause(attempt + 1, signal)
  }
}
