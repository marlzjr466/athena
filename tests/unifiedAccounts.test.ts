import { describe, expect, it, vi } from 'vitest'
import { UnifiedAccounts } from '../electron/main/ai/unifiedAccounts'
import { accountPreferenceKey } from '../shared/unifiedAccounts'

function fixture() {
  const chatGPT = { status: vi.fn(async () => ({ accounts: [{ id: 'chatgpt-1', active: true, connected: true, planEnabled: true, enabled: true, email: 'user@example.test', message: 'Connected', models: [{ slug: 'same-model', displayName: 'Shared' }] }] })) }
  const thirdParty = { list: vi.fn(async () => [
    { id: 'gateway-1', name: 'Gateway One', enabled: true, status: 'connected', statusMessage: 'Connected', lastSuccessfulTestAt: 1, protocol: 'openai-responses', models: [{ id: 'same-model', enabled: true }] },
    { id: 'gateway-2', name: 'Gateway Two', enabled: true, status: 'connected', statusMessage: 'Connected', lastSuccessfulTestAt: 1, protocol: 'openai-responses', models: [{ id: 'same-model', enabled: true }] },
  ]) }
  const services = { chatGPT, thirdParty, cursor: { status: async () => ({ authenticated: false, models: [] }) }, copilot: { aiStatus: async () => ({ status: { active: false, models: [] } }), command: async () => ({ accounts: [], activeId: null }) }, ai: { getStatus: async () => ({ status: { hasKey: false, models: [] } }) }, claude: { getStatus: async () => ({ status: { hasKey: false, models: [] } }) }, antigravity: { status: async () => ({ authState: 'unauthenticated' }) } }
  return { registry: new UnifiedAccounts(services as never), chatGPT, thirdParty, services }
}

describe('unified account catalog', () => {
  it('keeps same model identifiers in separate account groups and caches provider lookups', async () => {
    const { registry, chatGPT, thirdParty } = fixture()
    const first = await registry.list()
    expect(first.accounts.map(account => account.name)).toEqual(['ChatGPT', 'Gateway One', 'Gateway Two'])
    expect(first.accounts.flatMap(account => account.models.filter(model => model.id === 'same-model'))).toHaveLength(3)
    await registry.list()
    expect(chatGPT.status).toHaveBeenCalledTimes(1)
    expect(thirdParty.list).toHaveBeenCalledTimes(1)
  })
  it('preserves account-specific context evidence through refresh without inferring gateway capacities from names', async () => {
    const { registry, services, thirdParty } = fixture()
    services.ai.getStatus = async () => ({ status: { hasKey: true, active: true, models: ['gpt-6-sol'] } }) as never
    thirdParty.list.mockResolvedValueOnce([
      { id: 'gateway-1', name: 'Reported', enabled: true, status: 'connected', models: [{ id: 'gpt-6-sol', enabled: true, reportedCapabilities: { contextWindow: 128000, maxOutputTokens: 8192 } }] },
      { id: 'gateway-2', name: 'Unknown', enabled: true, status: 'connected', models: [{ id: 'gpt-6-sol', enabled: true }] },
    ] as never)
    const catalog = await registry.list()
    expect(catalog.accounts.find(a => a.route.provider === 'cloud')!.models[0].contextLimits).toMatchObject({ contextWindow: 1050000, source: 'documented' })
    expect(catalog.accounts.find(a => a.name === 'Reported')!.models[0].contextLimits).toMatchObject({ contextWindow: 128000, source: 'reported' })
    expect(catalog.accounts.find(a => a.name === 'Unknown')!.models[0].contextLimits).toMatchObject({ contextWindow: undefined, source: 'fallback' })
    thirdParty.list.mockRejectedValueOnce(new Error('Offline'))
    const refreshed = await registry.list(true)
    expect(refreshed.accounts.find(a => a.name === 'Reported')!.models[0]).toMatchObject({ available: false, contextLimits: { contextWindow: 128000 } })
  })
  it('filters only the OpenAI API account and leaves other providers unchanged', async () => {
    const { registry, services } = fixture()
    services.ai.getStatus = async () => ({ status: { hasKey: true, active: true, lastVerifiedAt: 7, models: ['gpt-4.1', 'gpt-5.6-codex', 'gpt-6.1-pro', 'gpt-6-image'] } }) as never
    const catalog = await registry.list()
    expect(catalog.accounts.find(account => account.route.provider === 'cloud')?.models.map(model => model.id)).toEqual(['gpt-6.1-pro', 'gpt-5.6-codex'])
    expect(catalog.accounts.find(account => account.route.provider === 'subscription')?.models.map(model => model.id)).toEqual(['same-model'])
    expect(catalog.accounts.find(account => account.route.provider === 'third-party')?.models.map(model => model.id)).toEqual(['same-model'])
  })
  it('keeps documented OpenAI reasoning capabilities with their account after filtering', async () => {
    const { registry, services } = fixture()
    services.ai.getStatus = async () => ({ status: { hasKey: true, active: true, models: ['gpt-4.1', 'gpt-6.2-astra', 'gpt-5.6-sol', 'gpt-6.2-custom'] } }) as never
    const account = (await registry.list()).accounts.find(item => item.route.provider === 'cloud')!
    expect(account.models.find(model => model.id === 'gpt-6.2-astra')?.efforts).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(account.models.find(model => model.id === 'gpt-5.6-sol')?.efforts).toContain('none')
    expect(account.models.find(model => model.id === 'gpt-6.2-custom')?.efforts).toBeUndefined()
  })
  it('advertises configured reasoning levels for non-Responses inference routes', async () => {
    const { registry, thirdParty } = fixture()
    thirdParty.list.mockResolvedValueOnce([
      { id:'gateway-1', name:'Chat gateway', enabled:true, status:'connected', statusMessage:'Connected', lastSuccessfulTestAt:1, protocol:'openai-chat-completions', models:[{id:'reasoning-model',enabled:true,configuredCapabilities:{reasoning:true,reasoningEfforts:['minimal','high']}}] },
      { id:'gateway-2', name:'Anthropic gateway', enabled:true, status:'connected', statusMessage:'Connected', lastSuccessfulTestAt:1, protocol:'anthropic-messages', models:[{id:'claude-model',enabled:true,configuredCapabilities:{reasoning:true,reasoningEfforts:['low','high']}}] },
    ] as never)
    const catalog=await registry.list()
    expect(catalog.accounts.find(account=>account.name==='Chat gateway')?.models[0].efforts).toEqual(['auto','minimal','high'])
    expect(catalog.accounts.find(account=>account.name==='Anthropic gateway')?.models[0].efforts).toEqual(['auto','low','high'])
  })
  it('retains the last known model catalog when a provider refresh fails', async () => {
    const { registry, chatGPT } = fixture()
    await registry.list()
    chatGPT.status.mockRejectedValueOnce(new Error('Network unavailable'))
    const refreshed = await registry.list(true)
    expect(refreshed.accounts.find(account => account.name === 'ChatGPT')).toMatchObject({ state: 'unavailable', models: [{ id: 'same-model', available: false }] })
  })
  it('keeps discovered gateway models selectable after a model-specific HTTP 402 without claiming verification', async () => {
    const { registry, thirdParty } = fixture()
    thirdParty.list.mockResolvedValueOnce([
      { id: 'gateway-1', name: 'Gateway One', enabled: true, status: 'provider-error', statusMessage: 'Basic inference test failed: Provider declined the request (HTTP 402).', lastSuccessfulTestAt: 0, protocol: 'openai-responses', models: [{ id: 'paid-model', enabled: true }] },
    ])
    const account = (await registry.list()).accounts.find(item => item.name === 'Gateway One')
    expect(account).toMatchObject({ state: 'limited', models: [{ id: 'paid-model', available: true }] })
  })
  it('defaults legacy accounts on and applies saved preferences without changing model availability', async () => {
    const { services } = fixture(), preferences: Record<string, boolean> = {}
    const registry = new UnifiedAccounts(services as never, () => preferences)
    const before = await registry.list()
    expect(before.accounts.every(account => account.enabled)).toBe(true)
    const route = { provider: 'subscription' as const, accountId: 'chatgpt-1' }
    preferences[accountPreferenceKey(route)] = false
    registry.invalidate()
    const after = await registry.list()
    expect(after.accounts.find(account => account.route.provider === 'subscription')).toMatchObject({ enabled: false, state: 'connected', models: [{ available: true }] })
    expect(after.accounts.find(account => account.name === 'Gateway One')?.enabled).toBe(true)
  })
  it('returns responsive accounts when a single provider status check hangs', async () => {
    const { services } = fixture()
    services.cursor.status = () => new Promise(() => {})
    const registry = new UnifiedAccounts(services as never, undefined, 5)
    const catalog = await registry.list(true)
    expect(catalog.incomplete).toBe(true)
    expect(catalog.accounts.map(account => account.name)).toContain('Gateway One')
    expect(catalog.accounts.find(account => account.name === 'Gateway One')?.enabled).toBe(true)
  })
  it('waits for a slow first account read before caching the initial catalog', async () => {
    vi.useFakeTimers()
    try {
      const { services } = fixture()
      const originalStatus = services.chatGPT.status
      const slowStatus = new Promise<void>(resolve => setTimeout(resolve, 9))
      services.chatGPT.status = vi.fn(async () => {
        await slowStatus
        return originalStatus()
      })
      const registry = new UnifiedAccounts(services as never, undefined, 5)
      const pending = registry.list(true)
      await vi.advanceTimersByTimeAsync(5)
      await vi.advanceTimersByTimeAsync(4)
      const catalog = await pending
      expect(catalog.incomplete).toBe(false)
      expect(catalog.accounts.find(account => account.name === 'ChatGPT')?.state).toBe('connected')
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps profile connection status and discovered models separate from its account toggle', async () => {
    const { registry, thirdParty } = fixture()
    thirdParty.list.mockResolvedValueOnce([
      { id: 'gateway-1', name: 'Gateway One', enabled: false, status: 'connected', statusMessage: 'Connected', lastSuccessfulTestAt: 1, protocol: 'openai-responses', models: [{ id: 'model-one', enabled: true }] },
      { id: 'gateway-2', name: 'Gateway Two', enabled: true, status: 'connected', statusMessage: 'Connected', lastSuccessfulTestAt: 1, protocol: 'openai-responses', models: [{ id: 'model-two', enabled: true }] },
    ])
    const catalog = await registry.list()
    expect(catalog.accounts.find(account => account.name === 'Gateway One')).toMatchObject({ enabled: false, state: 'connected', models: [{ id: 'model-one', available: true }] })
    expect(catalog.accounts.find(account => account.name === 'Gateway Two')?.enabled).toBe(true)
  })
  it('lists Cursor account models once per ACP configuration instead of every CLI variant', async () => {
    const { services } = fixture()
    const registry = new UnifiedAccounts({ ...services, cursor: { status: async () => ({ authenticated: true, identity: 'cursor-user', modelCatalogAvailable: true,
      models: [{ id: 'cursor-grok-4.6-low', label: 'Grok Low' }, { id: 'cursor-grok-4.6-high', label: 'Grok High' }],
      modelConfigurations: [{ id: 'grok-4.6', name: 'Grok 4.6', options: [{ id: 'effort', name: 'Effort', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] }],
    }) } } as never)
    const catalog = await registry.list()
    expect(catalog.accounts.find(account => account.name === 'Cursor')?.models).toMatchObject([{ id: 'grok-4.6[effort=high]', label: 'Grok 4.6', available: true, efforts: ['low', 'high'] }])
  })
})
