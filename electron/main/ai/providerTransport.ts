import { AsyncLocalStorage } from 'node:async_hooks'
import { Agent } from 'undici'
import { contextDefaults, type ContextSettings } from '../../../shared/context'
import type { StreamOptions } from './AIProvider'
import { ResponseWatchdog } from './responseWatchdog'
import { reportTransportFailure } from './streamRecovery'

// Request-local policy: concurrent conversations never change a global dispatcher
// or borrow one another's deadlines. Native CLI/ACP processes do not use this.
const policies = new AsyncLocalStorage<{ settings: ContextSettings; options: StreamOptions; activity?: () => void }>()
export const requestPolicy = () => policies.getStore()?.settings ?? contextDefaults()
export function withRequestPolicy<T>(options: StreamOptions, request: () => T, activity?: () => void): T {
  return policies.run({ settings: { ...contextDefaults(), ...options.contextSettings }, options, activity }, request)
}

export function providerAgentOptions(): Agent.Options {
  const policy = requestPolicy()
  return {
    connect: { timeout: policy.socketConnectionSeconds * 1000 },
    headersTimeout: policy.responseConnectionSeconds * 1000,
    bodyTimeout: Math.max(policy.responseFirstEventSeconds, policy.streamInactivitySeconds) * 1000,
  }
}

/** A fresh bounded transport per request also isolates retries from a failed
 * pooled connection. The caller can supply a DNS-pinned Agent for custom gateways.
 * No credentials, URL, request body or response content are logged here. */
export const providerFetch: typeof fetch = async (input, init = {}) => {
  const dispatcher = (init as RequestInit & { dispatcher?: Agent }).dispatcher ?? new Agent(providerAgentOptions())
  const controller = new AbortController()
  const sourceSignal = init.signal ?? (input instanceof Request ? input.signal : undefined)
  const signal = sourceSignal ? AbortSignal.any([sourceSignal, controller.signal]) : controller.signal
  const watchdog = new ResponseWatchdog(controller, requestPolicy())
  const activity = policies.getStore()?.activity
  const options = policies.getStore()?.options
  const started = Date.now()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let closed = false
  const finish = (error?: unknown) => {
    if (closed) return
    closed = true
    watchdog.dispose()
    signal.removeEventListener('abort', aborted)
    // Do not wait for a broken socket to drain before exposing its failure.
    void (error ? dispatcher.destroy() : dispatcher.close()).catch(() => {})
  }
  const aborted = () => { void reader?.cancel(signal.reason).catch(() => {}); finish(signal.reason) }
  signal.addEventListener('abort', aborted, { once: true })
  try {
    signal.throwIfAborted()
    watchdog.connecting()
    const response = await fetch(input, { ...init, signal, dispatcher } as RequestInit)
    watchdog.connected()
    reader = response.body?.getReader()
    if (!reader) { finish(); return response }
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          signal.throwIfAborted()
          const chunk = await reader!.read()
          signal.throwIfAborted()
          if (chunk.done) { finish(); output.close() }
          else { if (chunk.value.byteLength) { watchdog.event(); activity?.() } output.enqueue(chunk.value) }
        } catch (error) {
          const failure = signal.aborted ? signal.reason : error
          finish(failure)
          // OpenAI's event adapter records richer response diagnostics itself.
          if (options && !activity) reportTransportFailure(options, failure, started, 'response_stream', 0, false, response.status)
          output.error(failure)
        }
      },
      async cancel(reason) { try { await reader!.cancel(reason) } finally { finish(reason) } },
    }, { highWaterMark: 0 })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
    finish(error)
    throw signal.aborted ? signal.reason : error
  }
}
