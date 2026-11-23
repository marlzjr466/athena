// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm, readFile, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SearxngRuntime } from '../electron/main/ai/searxngRuntime'
import { WebSearchService } from '../electron/main/ai/webSearchService'
import { webAccessDefaults } from '../shared/webAccess'
import { createRealtimeTools } from '../electron/main/ai/realtimeTools'
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/unused' } }))

describe('managed SearXNG', () => {
  it('fails clearly for a missing bundle without invoking host Python', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-search-test-'))
    const runtime = new SearxngRuntime(root, join(root, 'missing'))
    try { await expect(runtime.start()).rejects.toThrow('missing'); expect(runtime.status().state).toBe('error') }
    finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  })
  it('uses local search with citations and no credentials; blocks search and extraction offline', async () => {
    let config = { webAccess: { ...webAccessDefaults, webSearchEnabled: true }, strictOffline: false }
    const credentials = { read: vi.fn(async () => null), write: vi.fn(), remove: vi.fn() }
    const runtime = { search: vi.fn(async () => ({ results: [{ title: 'Source', url: 'https://example.com/a', content: 'Evidence' }, { title: 'Duplicate', url: 'https://example.com/a' }, { title: 'Private', url: 'http://127.0.0.1/a' }] })), status: () => ({ state: 'running' }), stop: vi.fn(), start: vi.fn() }
    const service = new WebSearchService(credentials)
    service.configure(() => config, runtime as unknown as SearxngRuntime)
    const found = await service.search('query', 5, 1000)
    expect(found).toHaveLength(1); expect(found[0]).toMatchObject({ title: 'Source', source: 'example.com', snippet: 'Evidence', retrievedAt: expect.any(String) })
    expect(credentials.read).not.toHaveBeenCalled()
    const tools = createRealtimeTools({ sessionId: 'local', model: 'any-model', settings: () => ({ ...config, aiMode: 'local' }), search: service, active: () => true, allowBrowserAccess: true, localOnly: true })
    expect(tools.tools?.definitions.some(tool => tool.name === 'web_search')).toBe(true)
    expect(tools.instructions).toContain('Local SearXNG')
    config = { ...config, strictOffline: true }
    await expect(service.search('query', 5, 1000)).rejects.toThrow('disabled')
    await expect(service.fetchPage('https://example.com', 1000)).rejects.toThrow('disabled')
    config = { ...config, strictOffline: false, webAccess: { ...config.webAccess, webSearchEnabled: false } }
    await expect(service.search('query', 5, 1000)).rejects.toThrow('disabled')
    expect(runtime.search).toHaveBeenCalledTimes(1)
  })
  it.runIf(process.env.ATHENA_SEARXNG_LIVE === '1')('provisions the real bundled runtime, searches, rejects external clients, recovers and stops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-search-live-'))
    const bundle = process.env.ATHENA_SEARCH_TEST_BUNDLE || resolve('build/search-runtime', `${process.platform}-${process.arch}`)
    const runtime = new SearxngRuntime(root, bundle)
    try {
      await runtime.initialize(); expect(runtime.status().state).toBe('stopped')
      await Promise.all([runtime.start(), runtime.start()])
      expect(runtime.status().state).toBe('running')
      const internals = runtime as unknown as { endpoint: string; token: string; child: import('node:child_process').ChildProcess }
      const endpoint = internals.endpoint, pid = internals.child.pid
      expect(await realpath(internals.child.spawnfile)).toContain(root)
      await runtime.start(); expect(internals.child.pid).toBe(pid)
      expect((await fetch(endpoint + '/healthz')).status).toBe(403)
      expect((await fetch(endpoint + '/healthz', { headers: { Authorization: `Bearer ${internals.token}`, Origin: 'https://evil.example' } })).status).toBe(403)
      expect((await fetch(endpoint + '/config', { headers: { Authorization: `Bearer ${internals.token}` } })).status).toBe(404)
      const result = await runtime.search('SearXNG documentation', false, 30000) as { results: unknown[] }
      expect(result.results.length).toBeGreaterThan(0)
      const service = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} })
      service.configure(() => ({ webAccess: { ...webAccessDefaults, webSearchEnabled: true }, strictOffline: false }), runtime)
      const page = await service.fetchPage('https://docs.searxng.org/dev/search_api.html', 15000, 4000)
      expect(page.title).toContain('Search API'); expect(page.text.length).toBeGreaterThan(100)
      expect(page.text.length).toBeLessThanOrEqual(4000)
      expect(await readFile(join(root, 'config/secret'), 'utf8')).toMatch(/^[a-f0-9]{64}$/)
      if (process.platform !== 'win32') expect((await stat(join(root, 'config/secret'))).mode & 0o777).toBe(0o600)
      internals.child.kill()
      await vi.waitFor(() => { expect(runtime.status().state).toBe('running'); expect(internals.child?.pid).not.toBe(pid); expect(internals.child?.pid).toBeDefined() }, { timeout: 30000, interval: 500 })
      await runtime.restart(); expect(internals.child.pid).not.toBe(pid)
      await runtime.stop(); expect(runtime.status().state).toBe('stopped')
      await runtime.start(); expect(runtime.status().state).toBe('running')
      await Promise.all([runtime.stop(), runtime.start()]); expect(runtime.status().state).toBe('running')
    } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 150000)
})
