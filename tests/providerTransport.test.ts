// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Agent } from 'undici'
import OpenAI from 'openai'
import { contextDefaults } from '../shared/context'
import { providerAgentOptions, providerFetch, withRequestPolicy } from '../electron/main/ai/providerTransport'
import { classifyStreamFailure, safeExceptionMetadata, streamFaultTiming } from '../electron/main/ai/streamRecovery'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const policy = (patch = {}) => ({ contextSettings: { ...contextDefaults(), ...patch } })

it('retains the nested socket cause through the SDK without exposing host names or secrets', () => {
  const root = Object.assign(new Error('secret host and credential'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
  const error = Object.assign(new OpenAI.APIConnectionTimeoutError(), { cause: new TypeError('fetch failed', { cause: root }) })
  expect(classifyStreamFailure(error)).toBe('connection_timeout')
  expect(safeExceptionMetadata(error)).toEqual({ exceptionName: 'Error', causeCode: 'UND_ERR_CONNECT_TIMEOUT' })
  expect(JSON.stringify(safeExceptionMetadata(error))).not.toMatch(/secret|credential|host/)
})

it('isolates concurrent policies without changing the global fetch dispatcher', async () => {
  const resolve = async (seconds: number) => withRequestPolicy(policy({ socketConnectionSeconds: seconds }), async () => {
    await Promise.resolve()
    return providerAgentOptions().connect
  })
  expect(await Promise.all([resolve(17), resolve(43)])).toEqual([{ timeout: 17000 }, { timeout: 43000 }])
  expect(providerAgentOptions().connect).toEqual({ timeout: 30000 })
})

it('separates response-header, first-activity and inactivity deadlines', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))))
  const pending = withRequestPolicy(policy({ responseConnectionSeconds: 15 }), () => providerFetch('https://fixture.invalid'))
  const failure = expect(pending).rejects.toMatchObject({ kind: 'request_initialization_timeout' })
  await vi.advanceTimersByTimeAsync(15000); await failure

  let output!: ReadableStreamDefaultController<Uint8Array>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { output = c } }))))
  const response = await withRequestPolicy(policy({ responseFirstEventSeconds: 35, streamInactivitySeconds: 30 }), () => providerFetch('https://fixture.invalid'))
  const reader = response.body!.getReader(), first = reader.read()
  await vi.advanceTimersByTimeAsync(34000)
  output.enqueue(new TextEncoder().encode(': real heartbeat\n\n'))
  expect((await first).done).toBe(false)
  for (let i = 0; i < 5; i++) {
    const next = reader.read()
    await vi.advanceTimersByTimeAsync(29000)
    output.enqueue(new Uint8Array([1])); await next
  }
  const stalled = reader.read(), rejected = expect(stalled).rejects.toMatchObject({ kind: 'stream_inactivity' })
  await vi.advanceTimersByTimeAsync(30000); await rejected
})

it('reports a missing first event and clears timers on cancellation and body completion', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream())))
  const r = await withRequestPolicy(policy({ responseFirstEventSeconds: 31 }), () => providerFetch('https://fixture.invalid'))
  const pending = r.text().catch(error => error)
  await vi.advanceTimersByTimeAsync(31000)
  const error = await pending
  expect(classifyStreamFailure(error)).toBe('first_event_timeout')
  expect(streamFaultTiming(error).configuredTimeoutMs).toBe(31000)
  expect(vi.getTimerCount()).toBe(0)

  vi.stubGlobal('fetch', vi.fn(async () => new Response('complete')))
  expect(await (await providerFetch('https://fixture.invalid')).text()).toBe('complete')
  expect(vi.getTimerCount()).toBe(0)
  const abort = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream())))
  const response = await providerFetch('https://fixture.invalid', { signal: abort.signal })
  const cancelled = response.text(), rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  abort.abort(); await rejection
  expect(vi.getTimerCount()).toBe(0)
})

// Real socket/HTTP integration, no Internet, keys or project writes. Reproduces
// Undici's hidden ten-second connection deadline while DNS is still resolving.
it('connects after ten seconds with the explicit socket policy while the old Agent times out', async () => {
  const server = createServer((_req, res) => res.end('verified local fixture'))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  const lookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    setTimeout(() => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4), 11000)
  }) as never
  const old = new Agent({ connect: { lookup } })
  const configured = providerAgentOptions()
  const updated = new Agent({ ...configured, connect: { ...configured.connect, lookup } })
  const url = `http://delayed.test:${port}`
  try {
    const failed = fetch(url, { dispatcher: old } as RequestInit).catch(error => error)
    const succeeded = providerFetch(url, { dispatcher: updated } as RequestInit)
    expect(classifyStreamFailure(await failed)).toBe('connection_timeout')
    expect(await (await succeeded).text()).toBe('verified local fixture')
  } finally {
    await old.destroy(); await updated.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 20000)
