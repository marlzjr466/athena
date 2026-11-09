// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository, newConversation } from '../electron/main/ai/conversationRepository'
import { LocalActivityBridge } from '../electron/main/ai/localActivityBridge'
import { localCompanionProvider, localCompanionSettings } from '../electron/main/ai/localCompanion'
import { routeCompanionRequest } from '../electron/main/ai/companionRouting'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { WebSearchService } from '../electron/main/ai/webSearchService'
import { defaultSettings } from '../shared/settings'
import { defaultConversationConfig } from '../shared/conversations'
import { emptyChatSnapshot, type AIChunk } from '../shared/chat'
import type { AIOwnership } from '../shared/aiOwnership'
import { IPC } from '../shared/ipcChannels'
import { requireOnlineProvider, requireOnlineHistory, onlineContextSettings } from '../electron/main/ai/onlineIsolation'
import { LocalVoiceOwnership } from '../electron/main/voice/localVoiceOwnership'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const target = () => ({ setConversationState: vi.fn(), setTaskActivity: vi.fn(), setTaskOutcome: vi.fn() })
const identity = (origin: AIOwnership['origin'], sessionId = randomUUID()): AIOwnership => ({ origin, sessionId, correlationId: randomUUID() })

describe('local companion isolation', () => {
  it('keeps ambiguous legacy local history from being sent online after explicit provider selection', () => {
    const settings = { ...defaultSettings, reviewLegacyLocalHistory: true }
    const message = { id: randomUUID(), role: 'assistant' as const, status: 'complete' as const, createdAt: 0, content: 'Private legacy context' }
    expect(() => requireOnlineHistory(settings, [message])).toThrow('Start a new online conversation')
    expect(() => requireOnlineHistory(settings, [{ ...message, ownership: identity('athena-local') }])).toThrow()
    expect(() => requireOnlineHistory(settings, [{ ...message, ownership: identity('online-chat') }])).not.toThrow()
    expect(() => requireOnlineHistory(settings, [])).not.toThrow()
    expect(message.content).toBe('Private legacy context')
  })
  it.each(['local', 'unconfigured'] as const)('blocks %s online routing before any cloud or local factory can run', async aiMode => {
    const cloud = vi.fn(), ollama = vi.fn()
    const chat = new ChatController({ origin: 'online-chat', phase: vi.fn(), changed: vi.fn(), provider: async () => {
      requireOnlineProvider({ ...defaultSettings, aiMode })
      cloud(); ollama()
      throw new Error('Unreachable')
    } })
    try {
      chat.send({ text: 'Private local legacy conversation' })
      await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
      expect(chat.current().messages.at(-1)?.error).toContain('Choose an online provider')
      expect(cloud).not.toHaveBeenCalled(); expect(ollama).not.toHaveBeenCalled()
    } finally { chat.dispose() }
  })
  it('keeps local offline preferences out of online context without mutating saved settings', () => {
    const settings = { ...structuredClone(defaultSettings), strictOffline: true }
    expect(onlineContextSettings(settings).strictOffline).toBe(false)
    expect(settings.strictOffline).toBe(true)
    expect(localCompanionSettings(settings).strictOffline).toBe(true)
  })
  it('binds voice ownership to the local session and configuration and rejects expired or forged events', () => {
    let session: string | undefined = randomUUID(), config = 'qwen:3b'
    const lease = new LocalVoiceOwnership(() => session, () => config)
    expect(lease.accepts(undefined)).toBe(false)
    const first = lease.acquire()!
    expect(lease.accepts(first)).toBe(true)
    expect(lease.accepts({ ...first, origin: 'online-chat' })).toBe(false)
    expect(lease.accepts({ ...first, correlationId: randomUUID() })).toBe(false)
    const next = lease.acquire()!
    expect(lease.accepts(first)).toBe(false)
    expect(lease.accepts(next)).toBe(true)
    expect(lease.release(first)).toBe(false)
    expect(lease.accepts(next)).toBe(true)
    config = 'other'; expect(lease.accepts(next)).toBe(false)
    const third = lease.acquire()!
    session = randomUUID(); expect(lease.accepts(third)).toBe(false)
    expect(lease.release(third)).toBe(true)
    const fourth = lease.acquire()!
    lease.clear(); expect(lease.accepts(fourth)).toBe(false)
    session = undefined; expect(lease.acquire()).toBeUndefined()
  })
  it.each(['gpt-5', 'claude-sonnet', 'cursor-managed'])('keeps %s stream, tools and completion out of an active local avatar task', async modelId => {
    const avatar = target(), localGate = gate(), onlineGate = gate()
    let local!: ChatController, online!: ChatController
    const bridge = new LocalActivityBridge(() => avatar, () => local.current().id)
    const hooks = { phase: (phase: 'idle' | 'thinking' | 'speaking', owner?: AIOwnership) => bridge.phase(phase, owner), changed: (snapshot: ReturnType<ChatController['snapshot']>) => bridge.activity(snapshot), taskEnded: (_id: string, message: ReturnType<ChatController['current']>['messages'][number]) => bridge.ended(message) }
    local = new ChatController({ ...hooks, origin: 'athena-local', provider: async () => ({ testConnection: async () => true, async *streamMessage(): AsyncGenerator<AIChunk> {
      const op = local.activity('read_file', 'Read local file')
      await localGate.promise
      local.finishActivity(op, { status: 'complete' })
      yield { type: 'text', text: 'Local answer.' }; yield { type: 'done' }
    } }) })
    online = new ChatController({ ...hooks, origin: 'online-chat', provider: async () => ({ modelId, testConnection: async () => true, async *streamMessage(): AsyncGenerator<AIChunk> {
      const op = online.activity('execute_command', 'Online command')
      await onlineGate.promise
      online.finishActivity(op, { status: 'complete' })
      yield { type: 'text', text: 'Private online answer.' }; yield { type: 'done' }
    } }) })
    try {
      local.send({ text: 'Local question' })
      await vi.waitFor(() => expect(local.activeExecution()?.execution?.activities).toHaveLength(1))
      for (const spy of Object.values(avatar)) spy.mockClear()
      online.send({ text: 'Private online question' })
      onlineGate.release()
      await vi.waitFor(() => expect(online.snapshot().phase).toBe('idle'))
      for (const spy of Object.values(avatar)) expect(spy).not.toHaveBeenCalled()
      expect(local.snapshot().phase).toBe('thinking')
      expect(JSON.stringify(local.snapshot())).not.toContain('Private online')
      localGate.release()
      await vi.waitFor(() => expect(local.snapshot().phase).toBe('idle'))
      expect(avatar.setTaskOutcome).toHaveBeenCalledWith('complete')
      expect(online.current().messages.at(-1)?.ownership?.origin).toBe('online-chat')
      expect(local.current().messages.at(-1)?.ownership?.origin).toBe('athena-local')
    } finally { onlineGate.release(); localGate.release(); online.dispose(); local.dispose() }
  })

  it('rejects unowned, other-session and retired events without resetting a newer local task', () => {
    const avatar = target(), session = randomUUID(), owner = identity('athena-local', session)
    const bridge = new LocalActivityBridge(() => avatar, () => session)
    for (const denied of [undefined, identity('online-chat', session), identity('athena-training', session), identity('athena-avatar', session), identity('athena-local')]) bridge.phase('thinking', denied)
    expect(avatar.setConversationState).not.toHaveBeenCalled()
    bridge.phase('thinking', owner); bridge.phase('idle', owner)
    const next = identity('athena-local', session)
    bridge.phase('thinking', next)
    avatar.setConversationState.mockClear()
    bridge.phase('thinking', owner); bridge.phase('idle', owner)
    bridge.activity({ ...emptyChatSnapshot(), phase: 'thinking', ownership: owner })
    expect(avatar.setConversationState).not.toHaveBeenCalled()
    expect(avatar.setTaskActivity).not.toHaveBeenCalled()
  })

  it('retires a superseded execution even if its idle event arrives late', () => {
    const avatar = target(), session = randomUUID()
    const previous = identity('athena-local', session), current = identity('athena-local', session)
    const bridge = new LocalActivityBridge(() => avatar, () => session)
    bridge.phase('thinking', previous)
    bridge.phase('thinking', current)
    for (const spy of Object.values(avatar)) spy.mockClear()
    bridge.phase('speaking', previous)
    bridge.phase('idle', previous)
    bridge.ended({ id: previous.correlationId, role: 'assistant', content: '', createdAt: 0, status: 'complete', ownership: previous })
    for (const spy of Object.values(avatar)) expect(spy).not.toHaveBeenCalled()
    bridge.phase('speaking', current)
    expect(avatar.setConversationState).toHaveBeenCalledWith('speaking')
  })

  it.each(['cloud', 'subscription', 'claude-api', 'cursor'] as const)('uses only Ollama for companion requests while %s is selected online', async aiMode => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const request = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(options?.body)) })
      return String(url).endsWith('/api/show')
        ? new Response(JSON.stringify({ capabilities: ['completion'], model_info: { 'qwen2.context_length': 32768 } }))
        : new Response(JSON.stringify({ message: { content: 'Local reply.' }, done: true }) + '\n')
    })
    const service = new OllamaService(() => 'http://127.0.0.1:11434', request)
    const settings = { ...structuredClone(defaultSettings), aiMode, localAI: { ...defaultSettings.localAI, model: 'qwen2.5:3b' } }
    const provider = await localCompanionProvider(service, settings, { ...defaultConversationConfig(), model: 'qwen2.5:3b' })
    const chunks = []
    for await (const chunk of provider.streamMessage([{ id: randomUUID(), role: 'user', status: 'complete', content: 'Hello', createdAt: 0 }])) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text', text: 'Local reply.' })
    expect(requests).toHaveLength(2)
    expect(requests.every(entry => entry.url.startsWith('http://127.0.0.1:11434/') && entry.body.model === 'qwen2.5:3b')).toBe(true)
  })

  it('reports missing models and local transport errors with no alternative provider request', async () => {
    const request = vi.fn(async () => { throw new Error('offline') })
    const service = new OllamaService(() => 'http://127.0.0.1:11434', request)
    await expect(localCompanionProvider(service, defaultSettings, defaultConversationConfig())).rejects.toThrow('local model')
    expect(request).not.toHaveBeenCalled()
    const settings = { ...defaultSettings, localAI: { ...defaultSettings.localAI, model: 'qwen2.5:3b' } }
    await expect(localCompanionProvider(service, settings, defaultConversationConfig())).rejects.toThrow('Cannot reach Ollama')
    expect(request).toHaveBeenCalledTimes(1)
    await expect(localCompanionProvider(service, settings, { ...defaultConversationConfig(), model: 'other' })).rejects.toThrow('different local model')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never enables OpenAI search inference in local context or rewrites shared settings', () => {
    const settings = { ...structuredClone(defaultSettings), automationPermissions: { ...defaultSettings.automationPermissions, browserAccess: true }, webAccess: { ...defaultSettings.webAccess, searchProvider: 'openai-built-in' as const, webSearchEnabled: true, automaticSearch: true } }
    expect(localCompanionSettings(settings)).toMatchObject({ aiMode: 'local', webAccess: { webSearchEnabled: true, automaticSearch: false } })
    expect(settings.webAccess.webSearchEnabled).toBe(true)
  })

  it('does not initialize OpenAI search while preparing a local request even when that provider is selected in shared settings', async () => {
    const settings = { ...structuredClone(defaultSettings), aiMode: 'local' as const,
      webAccess: { ...defaultSettings.webAccess, searchProvider: 'openai-built-in' as const, webSearchEnabled: true },
      automationPermissions: { ...defaultSettings.automationPermissions, browserAccess: true } }
    const session = newConversation({ ...defaultConversationConfig(), model: 'qwen2.5:3b' })
    const chat = { current: () => session, getSession: (id: string) => id === session.id ? session : undefined, activeExecution: () => undefined, beforeAction: vi.fn() } as unknown as ChatController
    const workspaces = { authorized: () => false, filesystemMode: () => 'project-only' }
    const search = new WebSearchService({ read: async () => 'brave-test-key-1234567890', write: async () => {}, remove: async () => {} })
    const resolveOpenAIWebSearch = vi.fn(async () => ({ apiKey: 'sk-test', model: 'gpt-5.5', validated: true }))
    const context = new ChatContextService(chat, {} as never, workspaces as never, { files: async () => [], folder: async () => undefined }, () => true,
      undefined, undefined, undefined, undefined, () => ({ active: true, vision: false, tools: true, contextCharacters: 16_000 }), search, () => settings, resolveOpenAIWebSearch)
    const request = { id: randomUUID(), role: 'user' as const, status: 'complete' as const, createdAt: Date.now(), content: 'Search the web for React updates' }
    const prepared = await context.prepare(session, [request], new AbortController().signal)
    expect(resolveOpenAIWebSearch).not.toHaveBeenCalled()
    expect(prepared.projectTools?.definitions.map(tool => tool.name)).not.toContain('web_search')
    expect(prepared.projectTools?.definitions.map(tool => tool.name)).toContain('open_web_page')
  })

  it('persists companion ownership separately and rejects online session IDs through the local route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-isolation-'))
    const storage = new ConversationRepository(join(directory, 'companion'))
    const onlineStorage = new ConversationRepository(join(directory, 'online'))
    const hooks = { provider: async () => ({ testConnection: async () => true, async *streamMessage(): AsyncGenerator<AIChunk> { yield { type: 'text', text: 'Local only' }; yield { type: 'done' } } }), phase: vi.fn(), changed: vi.fn() }
    const local = new ChatController({ ...hooks, origin: 'athena-local' }, storage)
    const online = new ChatController({ ...hooks, origin: 'online-chat' }, onlineStorage)
    const runtime = { chat: local, context: { run: vi.fn() } as unknown as ChatContextService }
    try {
      expect(routeCompanionRequest(IPC.chatGet, undefined, runtime)).toMatchObject({ sessionId: local.current().id, messages: [] })
      expect(() => routeCompanionRequest(IPC.chatSession, { action: 'switch', id: online.current().id }, runtime)).toThrow('does not belong')
      expect(routeCompanionRequest(IPC.chatSend, { text: 'Wrong session', sessionId: online.current().id }, runtime)).toMatchObject({ ok: false })
      expect(routeCompanionRequest(IPC.chatSession, { action: 'configure-model', id: local.current().id, model: 'gpt-5' }, runtime)).toMatchObject({ ok: false })
      routeCompanionRequest(IPC.chatSend, { text: 'Private local text', sessionId: local.current().id }, runtime)
      await vi.waitFor(() => expect(local.snapshot().phase).toBe('idle'))
      const restored = storage.load().sessions[0].messages
      expect(restored.at(-1)?.ownership).toEqual(local.current().messages.at(-1)?.ownership)
      expect(onlineStorage.load().sessions[0].messages).toEqual([])
    } finally { local.dispose(); online.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('allows companion voice while online work is active, with independent history and cancellation', async () => {
    const pending = gate(), histories: string[][] = []
    const online = new ChatController({ origin: 'online-chat', phase: vi.fn(), changed: vi.fn(), provider: async () => ({ testConnection: async () => true, async *streamMessage(): AsyncGenerator<AIChunk> { await pending.promise; yield { type: 'done' } } }) })
    const local = new ChatController({ origin: 'athena-local', phase: vi.fn(), changed: vi.fn(), provider: async () => ({ testConnection: async () => true, async *streamMessage(messages): AsyncGenerator<AIChunk> { histories.push(messages.map(m => m.content)); yield { type: 'text', text: 'Local voice answer' }; yield { type: 'done' } } }) })
    try {
      online.send({ text: 'Online task' })
      expect(await local.answerHandsFree({ text: 'Private voice question' })).toMatchObject({ ok: true })
      expect(histories).toEqual([['Private voice question']])
      expect(local.current().messages).toHaveLength(0)
      expect(online.snapshot().phase).toBe('thinking')
      local.stop(); local.cancelHandsFreeReply()
      expect(online.snapshot().phase).toBe('thinking')
      local.command({ action: 'create' })
      await local.answerHandsFree({ text: 'New local session' })
      expect(histories[1]).toEqual(['New local session'])
    } finally { pending.release(); online.dispose(); local.dispose() }
  })
})
