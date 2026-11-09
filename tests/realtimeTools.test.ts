import { describe, expect, it, vi } from 'vitest'
import { webAccessDefaults } from '../shared/webAccess'
import { createRealtimeTools, requiresWebSearch } from '../electron/main/ai/realtimeTools'
import { extractPublicLinks, isPrivateWebAddress, WebSearchService } from '../electron/main/ai/webSearchService'

const signal = () => new AbortController().signal
function toolsFor(overrides: Partial<typeof webAccessDefaults> = {}, extra: { strictOffline?: boolean; aiMode?: string; model?: string; validated?: boolean; userText?: string } = {}) {
  const settings = { webAccess: { ...webAccessDefaults, ...overrides }, strictOffline: extra.strictOffline ?? false, aiMode: extra.aiMode ?? 'local' }
  const search = new WebSearchService({ read: async () => 'brave-test-key-1234567890', write: async () => {}, remove: async () => {} })
  return createRealtimeTools({ sessionId: 'session-1', model: extra.model ?? 'gpt-oss:20b', userText: extra.userText, openAISearch: extra.validated ? { apiKey: 'sk-test-openai-websearch-credential', model: 'gpt-5.5' } : undefined, settings: () => settings, search, active: () => true, uptime: () => 123456 })
}

describe('real-time system and web tools', () => {
  it('reads the actual local clock and ISO timestamp without network access', async () => {
    const runtime = toolsFor({ systemInformationEnabled: true, webSearchEnabled: false })
    const result = JSON.parse(await runtime.tools!.execute('get_current_datetime', {}, signal())) as { iso8601: string; date: string; time: string; timezone: string; utcOffset: string; weekday: string }
    expect(Number.isNaN(Date.parse(result.iso8601))).toBe(false)
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.time).toMatch(/\d{1,2}:\d{2}/)
    expect(result.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(result.utcOffset).toMatch(/^UTC/)
    expect(result.weekday).toBeTruthy()
  })

  it('converts the actual current instant into a requested IANA timezone', async () => {
    const runtime = toolsFor({ systemInformationEnabled: true })
    const result = JSON.parse(await runtime.tools!.execute('get_local_time', { timezone: 'Asia/Tokyo' }, signal())) as { timezone: string; utcOffset: string }
    expect(result.timezone).toBe('Asia/Tokyo')
    expect(result.utcOffset).toBe('UTC+09:00')
  })

  it('preserves local clock tools while Strict Offline removes every network tool', () => {
    const runtime = toolsFor({ systemInformationEnabled: true, webSearchEnabled: true }, { strictOffline: true })
    expect(runtime.tools?.definitions.map((tool) => tool.name)).toContain('get_current_datetime')
    expect(runtime.tools?.definitions.map((tool) => tool.name)).not.toContain('web_search')
    expect(runtime.tools?.definitions.map((tool) => tool.name)).not.toContain('extract_web_page_content')
    expect(runtime.notices.join(' ')).toContain('Strict Offline Mode')
  })

  it('does not show disabled web-search banners in ordinary local chat while keeping clock tools', () => {
    const runtime = createRealtimeTools({ sessionId: 'local-chat', model: 'qwen2.5:3b', quietUnavailable: true,
      settings: () => ({ webAccess: { ...webAccessDefaults, systemInformationEnabled: true, webSearchEnabled: false }, strictOffline: false, aiMode: 'local' }),
      search: new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }), active: () => true })
    expect(runtime.tools?.definitions.map(tool => tool.name)).toContain('get_current_datetime')
    expect(runtime.tools?.definitions.map(tool => tool.name)).not.toContain('web_search')
    expect(runtime.notices).toEqual([])
  })

  it('registers independent OpenAI Responses search with the shared agent for subscription conversations', () => {
    const untested = toolsFor({ webSearchEnabled: true, searchProvider: 'openai-built-in' }, { aiMode: 'cloud', model: 'gpt-5.5' })
    const subscription = createRealtimeTools({ sessionId: 'session-1', model: 'gpt-5.5', openAISearch: { apiKey: 'sk-test-openai-websearch-credential', model: 'gpt-5.5' }, openAISearchPerformed: true,
      settings: () => ({ webAccess: { ...webAccessDefaults, webSearchEnabled: true, searchProvider: 'openai-built-in' }, strictOffline: false, aiMode: 'subscription' }),
      search: new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }), active: () => true })
    expect(untested.notices.join(' ')).toContain('Settings → AI')
    expect(subscription.tools?.definitions.map((tool) => tool.name)).toContain('web_search')
    expect(subscription.instructions).toContain('A live OpenAI search was already completed')
    expect(subscription.notices.join(' ')).toContain('independently of the selected conversation provider')
  })

  it('never exposes OpenAI search to local inference and enforces the browser permission before page fetch', async () => {
    const search = new WebSearchService({ read: async () => 'brave-test-key-1234567890', write: async () => {}, remove: async () => {} })
    const openAISearch = vi.spyOn(search, 'searchOpenAI')
    const local = createRealtimeTools({ sessionId: 'local-chat', model: 'qwen2.5:3b', localOnly: true, allowBrowserAccess: true,
      openAISearch: { apiKey: 'sk-test-openai-websearch-credential', model: 'gpt-5.5' },
      settings: () => ({ webAccess: { ...webAccessDefaults, webSearchEnabled: true, searchProvider: 'openai-built-in' }, strictOffline: false, aiMode: 'local' }),
      search, active: () => true })
    expect(local.tools?.definitions.map(tool => tool.name)).not.toContain('web_search')
    expect(local.tools?.definitions.map(tool => tool.name)).toContain('open_web_page')
    expect(JSON.parse(await local.tools!.execute('web_search', { query: 'React hooks' }, signal()))).toMatchObject({ error: expect.any(String) })
    expect(openAISearch).not.toHaveBeenCalled()

    const denied = createRealtimeTools({ sessionId: 'local-chat', model: 'qwen2.5:3b', localOnly: true, allowBrowserAccess: false,
      settings: () => ({ webAccess: { ...webAccessDefaults, webSearchEnabled: true, searchProvider: 'brave' }, strictOffline: false, aiMode: 'local' }),
      search, active: () => true })
    expect(denied.tools?.definitions.map(tool => tool.name)).not.toContain('open_web_page')
    expect(JSON.parse(await denied.tools!.execute('open_web_page', { url: 'https://example.com' }, signal()))).toMatchObject({ error: expect.any(String) })
  })

  it('detects explicit search and current-information requests regardless of the chat provider', () => {
    expect(requiresWebSearch('Search the web for current React releases', true)).toBe(true)
    expect(requiresWebSearch('What is the latest React version?', true)).toBe(true)
    expect(requiresWebSearch('What is React?', false)).toBe(false)
    expect(requiresWebSearch('Search my project for the login component', true)).toBe(false)
    expect(requiresWebSearch('Search for React tutorials', false)).toBe(true)
    expect(requiresWebSearch('Look up this programming error', false)).toBe(true)
    expect(requiresWebSearch('What is the current time?', true)).toBe(false)
  })

  it('dispatches OpenAI search through the shared tool, returns grounded sources, and avoids duplicate calls', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ title: 'React Documentation', url: 'https://react.dev/learn' }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'React documentation is available on react.dev.', annotations: [{ type: 'url_citation', title: 'React Documentation', url: 'https://react.dev/learn' }] }] },
    ] }), { status: 200 }))
    const service = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }, fetcher)
    const searchOpenAI = vi.spyOn(service, 'searchOpenAI')
    const sources: Array<{ url: string }> = []
    const runtime = createRealtimeTools({ sessionId: 'subscription-chat', model: 'gpt-5.5', openAISearch: { apiKey: 'sk-test-openai-websearch-credential', model: 'gpt-5.5' },
      settings: () => ({ webAccess: { ...webAccessDefaults, webSearchEnabled: true, searchProvider: 'openai-built-in' }, strictOffline: false, aiMode: 'subscription' }),
      search: service, webSources: sources as never, active: () => true })
    const first = JSON.parse(await runtime.tools!.execute('web_search', { query: 'React documentation' }, signal()))
    const repeated = JSON.parse(await runtime.tools!.execute('web_search', { query: 'React documentation' }, signal()))
    expect(first).toMatchObject({ provider: 'OpenAI Responses web_search', answer: expect.stringContaining('React documentation'), results: [expect.objectContaining({ url: 'https://react.dev/learn' })] })
    expect(repeated.results).toEqual(first.results)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(searchOpenAI).toHaveBeenCalledWith('React documentation', 'sk-test-openai-websearch-credential', 'gpt-5.5', 45_000, expect.any(AbortSignal))
    expect(service.resultAt('subscription-chat', 1)?.url).toBe('https://react.dev/learn')
    expect(sources).toEqual([expect.objectContaining({ url: 'https://react.dev/learn' })])
  })

  it('rejects invalid timezones and leaves the system uptime tool independent of timezone preferences', async () => {
    const runtime = toolsFor({ systemInformationEnabled: true, timezone: 'Not/AZone' })
    const clock = JSON.parse(await runtime.tools!.execute('get_local_time', {}, signal())) as { error: string }
    const uptime = JSON.parse(await runtime.tools!.execute('get_system_uptime', {}, signal())) as { uptimeSeconds: number }
    expect(clock.error).toContain('IANA timezone')
    expect(uptime).toEqual({ uptimeSeconds: 123456, uptime: expect.any(String) })
  })
})

describe('web search and public-page safety', () => {
  it('extracts bounded public links for follow-up reading and drops unsafe link schemes and credentials', () => {
    const links = extractPublicLinks('<a href="/docs">Official <b>Docs</b></a><a href="javascript:alert(1)">unsafe</a><a href="https://user:pass@example.com/x">private</a><a href="https://react.dev/learn">React learn</a>', 'https://react.dev/blog')
    expect(links).toEqual([{ text: 'Official Docs', url: 'https://react.dev/docs' }, { text: 'React learn', url: 'https://react.dev/learn' }])
  })
  it('validates a real Responses API web_search call for an exact API key/model pair', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ title: 'React', url: 'https://react.dev' }] } },
      { type: 'message', status: 'completed' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const service = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }, fetcher)
    const apiKey = 'sk-test-openai-websearch-credential'
    const result = await service.testOpenAI(apiKey, 'gpt-5.5')
    expect(result).toMatchObject({ ok: true, model: 'gpt-5.5', resultCount: 1 })
    expect(fetcher).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({ method: 'POST', redirect: 'error' }))
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(request).toMatchObject({ model: 'gpt-5.5', tools: [{ type: 'web_search' }], tool_choice: 'required', store: false, stream: false })
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${apiKey}` })
    expect(service.isOpenAIValidated(apiKey, 'gpt-5.5')).toBe(true)
    expect(service.isOpenAIValidated(apiKey, 'gpt-5.4')).toBe(false)
    expect(result.message).not.toContain(apiKey)
  })

  it('does not mark a model available when a test response contains no completed search call', async () => {
    const apiKey = 'sk-test-openai-websearch-credential'
    const service = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', status: 'completed' }] }), { status: 200 })))
    const result = await service.testOpenAI(apiKey, 'gpt-5.5')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('real web search')
    expect(service.isOpenAIValidated(apiKey, 'gpt-5.5')).toBe(false)
  })

  it('performs a separate OpenAI Responses search and returns only real cited sources for another chat provider', async () => {
    const apiKey = 'sk-test-openai-websearch-credential'
    const source = 'https://react.dev/blog'
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: source }] } },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: source }] } },
        { type: 'message', content: [{ type: 'output_text', text: 'The React blog documents its recent releases.', annotations: [{ type: 'url_citation', url: source, title: 'React Blog' }] }] },
      ] }), { status: 200 }))
    const service = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }, fetcher)
    expect((await service.testOpenAI(apiKey, 'gpt-5.5')).ok).toBe(true)
    const result = await service.searchOpenAI('What is the latest React release?', apiKey, 'gpt-5.5', 5000)
    expect(result).toMatchObject({ model: 'gpt-5.5', answer: 'The React blog documents its recent releases.', sources: [expect.objectContaining({ title: 'React Blog', url: source, source: 'react.dev' })] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const request = JSON.parse(String(fetcher.mock.calls[1][1]?.body))
    expect(request).toMatchObject({ model: 'gpt-5.5', tools: [{ type: 'web_search' }], tool_choice: 'required', store: false, stream: false })
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: `Bearer ${apiKey}` })
  })

  it('lets the first real requested search verify capability after an app restart', async () => {
    const apiKey = 'sk-test-openai-websearch-credential'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ title: 'React Docs', url: 'https://react.dev' }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'React docs.' }] },
    ] }), { status: 200 }))
    const service = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }, fetcher)
    expect(service.isOpenAIValidated(apiKey, 'gpt-5.5')).toBe(false)
    const result = await service.searchOpenAI('latest React docs', apiKey, 'gpt-5.5', 5000)
    expect(result.answer).toBe('React docs.')
    expect(service.isOpenAIValidated(apiKey, 'gpt-5.5')).toBe(true)
  })

  it('distinguishes insufficient API credits from a compatible-model failure', async () => {
    const key = 'sk-test-openai-websearch-credential'
    const limited = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 })))
    expect((await limited.testOpenAI(key, 'gpt-5.5')).message).toContain('API billing')
    const unsupported = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'unsupported_model' } }), { status: 400 })))
    expect((await unsupported.testOpenAI(key, 'gpt-oss:20b')).message).toContain('could not run')
  })

  it('parses actual Brave result fields with source domains and retrieval timestamps', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ web: { results: [
      { title: 'React release notes', url: 'https://react.dev/blog', description: 'Official release notes', page_age: '2026-10-10' },
      { title: 'unsafe', url: 'javascript:alert(1)', description: 'Ignore safety' },
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const service = new WebSearchService({ read: async () => 'brave-test-key-1234567890', write: async () => {}, remove: async () => {} }, fetcher)
    const results = await service.search('latest React version', 5, 5000)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ title: 'React release notes', source: 'react.dev', publicationDate: '2026-10-10' })
    expect(Date.parse(results[0].retrievedAt)).not.toBeNaN()
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ 'X-Subscription-Token': 'brave-test-key-1234567890' })
  })

  it('returns clear no-key and usage-limit errors without provider fallback', async () => {
    const missing = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} })
    await expect(missing.search('weather now', 3, 5000)).rejects.toThrow('Add a Brave Search API key')
    const limited = new WebSearchService({ read: async () => 'brave-test-key-1234567890', write: async () => {}, remove: async () => {} }, vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })))
    await expect(limited.search('latest news', 3, 5000)).rejects.toThrow('Brave Search rate or plan limit')
  })

  it('blocks loopback, private, link-local, and documentation IP ranges', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.1.1', '192.168.1.1', '169.254.1.1', '100.64.1.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) expect(isPrivateWebAddress(address)).toBe(true)
    expect(isPrivateWebAddress('8.8.8.8')).toBe(false)
  })

  it('rejects loopback web pages before opening a network request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const service = new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }, fetcher)
    await expect(service.fetchPage('http://127.0.0.1/admin', 1000)).rejects.toThrow('private or local')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
