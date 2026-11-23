// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createSearchRecovery } from '../electron/main/ai/searchRecovery'
import { SearchError, type SearchAttempt } from '../shared/searchOutcome'
import { SearxngRuntime, searxngEngines } from '../electron/main/ai/searxngRuntime'
import { WebSearchService } from '../electron/main/ai/webSearchService'
import { createRealtimeTools, requiresWebSearch } from '../electron/main/ai/realtimeTools'
import { webAccessDefaults } from '../shared/webAccess'
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/unused' } }))
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
afterEach(() => vi.restoreAllMocks())
const signal = () => new AbortController().signal
const settings = () => ({ webAccess: { ...webAccessDefaults, webSearchEnabled: true, searchProvider: 'searxng' as const }, strictOffline: false, aiMode: 'subscription' })

it('returns empty as valid, suppresses repeats across restoration, and bounds reformulations', async () => {
  let saved: SearchAttempt[] = []
  const search = vi.fn(async () => [])
  const recover = createSearchRecovery([], records => { saved = records })
  expect(await recover('searxng', 'some query', false, signal(), search)).toMatchObject({ ok: true, status: 'empty', results: [] })
  const restored = createSearchRecovery(JSON.parse(JSON.stringify(saved)))
  expect(await restored('searxng', ' SOME   QUERY ', false, signal(), search)).toMatchObject({ status: 'empty', repeated: true })
  await restored('searxng', 'reformulation one', false, signal(), search)
  await restored('searxng', 'reformulation two', false, signal(), search)
  expect(await restored('searxng', 'reformulation three', false, signal(), search)).toMatchObject({ status: 'retry-limit' })
  expect(search).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(saved)).not.toContain('some query')
})

it('coalesces duplicate requests and propagates cancellation without recording a failure', async () => {
  const record = vi.fn(), recover = createSearchRecovery([], record)
  const search = vi.fn(async () => [{ title: 'Docs', url: 'https://example.com', source: 'example.com', snippet: 'evidence', retrievedAt: new Date().toISOString() }])
  const [a, b] = await Promise.all([recover('searxng', 'docs', false, signal(), search), recover('searxng', 'docs', false, signal(), search)])
  expect(a).toEqual(b); expect(search).toHaveBeenCalledOnce()
  const abort = new AbortController()
  const cancelled = createSearchRecovery([], record)
  record.mockClear()
  await expect(cancelled('searxng', 'cancel', false, abort.signal, async () => { abort.abort(); throw new Error('aborted') })).rejects.toThrow()
  expect(record).not.toHaveBeenCalled()
})

it.each(['timeout', 'http-error', 'invalid-response', 'disconnected', 'json-disabled', 'engine-unavailable', 'upstream-failure'] as const)('returns %s as a recoverable structured tool outcome', async code => {
  const recover = createSearchRecovery()
  expect(await recover('searxng', 'docs', false, signal(), async () => { throw new SearchError(code, 'Safe failure') })).toMatchObject({ ok: false, status: code, results: [] })
})

it.each(['/platform-dev MBM-11825', 'Search src/api for the current version', 'Read docs/tickets/MBM-11825/workflow.yaml', 'Search events.yaml', 'Continue the current project workflow'])('routes local request %s without automatic web search', text => {
  expect(requiresWebSearch(text, true)).toBe(false)
})

it('sends encoded GET queries to the private runtime and distinguishes HTTP/JSON/connectivity failures', async () => {
  const runtime = new SearxngRuntime('/unused', '/unused')
  vi.spyOn(runtime, 'start').mockResolvedValue()
  Object.assign(runtime, { endpoint: 'http://127.0.0.1:8123' })
  const fetcher = vi.spyOn(globalThis, 'fetch')
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
  expect(await runtime.search('C++ & TypeScript?', false, 1000)).toEqual({ results: [] })
  const [input, init] = fetcher.mock.calls[0]
  const url = new URL(String(input))
  expect(url.pathname).toBe('/search'); expect(url.searchParams.get('q')).toBe('C++ & TypeScript?'); expect(url.searchParams.get('format')).toBe('json'); expect(init?.method).toBe('GET')
  fetcher.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
  await expect(runtime.search('q', false, 1000)).rejects.toMatchObject({ code: 'json-disabled', httpStatus: 403 })
  fetcher.mockResolvedValueOnce(new Response('bad', { status: 503 }))
  await expect(runtime.search('q', false, 1000)).rejects.toMatchObject({ code: 'http-error', httpStatus: 503 })
  fetcher.mockResolvedValueOnce(new Response('<html>no JSON</html>'))
  await expect(runtime.search('q', false, 1000)).rejects.toMatchObject({ code: 'invalid-response' })
  fetcher.mockRejectedValueOnce(new TypeError('connect failed'))
  await expect(runtime.search('q', false, 1000)).rejects.toMatchObject({ code: 'disconnected' })
})

it('enforces the runtime request timeout without converting it to empty results', async () => {
  const runtime = new SearxngRuntime('/unused', '/unused')
  vi.spyOn(runtime, 'start').mockResolvedValue()
  Object.assign(runtime, { endpoint: 'http://127.0.0.1:8123' })
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  await expect(runtime.search('q', false, 10)).rejects.toMatchObject({ code: 'timeout' })
})

it('distinguishes empty results, partial upstream failure, all upstream failure and malformed payloads', async () => {
  const runtime = { status: () => ({ state: 'running' }), search: vi.fn() }
  const service = new WebSearchService({ read: vi.fn(), write: vi.fn(), remove: vi.fn() })
  service.configure(settings, runtime as unknown as SearxngRuntime)
  runtime.search.mockResolvedValueOnce({ results: [], unresponsive_engines: [] })
  expect(await service.search('q', 5, 1000)).toEqual([])
  runtime.search.mockResolvedValueOnce({ results: [], unresponsive_engines: [['bing', 'timeout']] })
  await expect(service.search('q', 5, 1000)).rejects.toMatchObject({ code: 'engine-unavailable' })
  runtime.search.mockResolvedValueOnce({ results: [], unresponsive_engines: searxngEngines(false).map(name => [name, 'timeout']) })
  await expect(service.search('q', 5, 1000)).rejects.toMatchObject({ code: 'upstream-failure' })
  runtime.search.mockResolvedValueOnce({ unexpected: [] })
  await expect(service.search('q', 5, 1000)).rejects.toMatchObject({ code: 'invalid-response' })
})

it('returns a structured empty tool result, prevents duplicate network calls and keeps local routing', async () => {
  const search = { search: vi.fn(async () => []), rememberResults: vi.fn() }
  const tools = createRealtimeTools({ sessionId: 'test', model: 'any', settings, search: search as unknown as WebSearchService, active: () => true }).tools!
  expect(JSON.parse(await tools.execute('web_search', { query: 'public docs' }, signal()))).toMatchObject({ ok: true, status: 'empty' })
  expect(JSON.parse(await tools.execute('web_search', { query: 'public docs' }, signal()))).toMatchObject({ repeated: true })
  expect(JSON.parse(await tools.execute('web_search', { query: 'Search src for configuration' }, signal()))).toMatchObject({ status: 'local-intent' })
  expect(search.search).toHaveBeenCalledOnce()
})
