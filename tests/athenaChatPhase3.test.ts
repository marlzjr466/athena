// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { WebSearchService } from '../electron/main/ai/webSearchService'
import { ScreenCaptureTools } from '../electron/main/screenCapture/screenCaptureTools'
import { LocalActivityBridge } from '../electron/main/ai/localActivityBridge'
import { localChatProvider } from '../electron/main/ai/localCompanion'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { defaultConversationConfig } from '../shared/conversations'
import { defaultSettings } from '../shared/settings'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('Phase 3 Athena Chat isolation', () => {
  it('stores private local sessions separately from online and floating history, preserving per-session models', () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-phase3-')); directories.push(root)
    const hooks = { phase: vi.fn(), changed: vi.fn(), provider: async () => ({ testConnection: async () => true, async *streamMessage() { yield { type: 'text' as const, text: 'Done' }; yield { type: 'done' as const } } }) }
    const online = new ChatController({ ...hooks, origin: 'online-chat' }, new ConversationRepository(join(root, 'online')))
    const floating = new ChatController({ ...hooks, origin: 'athena-local' }, new ConversationRepository(join(root, 'athena-local', 'companion')))
    const local = new ChatController({ ...hooks, origin: 'athena-local' }, new ConversationRepository(join(root, 'athena-local', 'chat')))
    try {
      local.initializeModel('qwen2.5:3b')
      const firstId = local.current().id
      expect(local.command({ action: 'create' }).ok).toBe(true)
      const secondId = local.current().id
      expect(local.command({ action: 'configure-model', id: secondId, model: 'qwen2.5-coder:3b' }).ok).toBe(true)
      expect(local.command({ action: 'rename', id: secondId, title: 'Private coding' }).ok).toBe(true)
      expect(local.current().config.model).toBe('qwen2.5-coder:3b')
      expect(local.command({ action: 'switch', id: firstId }).ok).toBe(true)
      expect(local.current().config.model).toBe('qwen2.5:3b')
      expect(local.snapshot().sessions).toHaveLength(2)
      expect(online.snapshot().sessions).toHaveLength(1)
      expect(floating.snapshot().sessions).toHaveLength(1)
      expect(defaultSettings.localAI.model).toBeNull()
    } finally { online.dispose(); floating.dispose(); local.dispose() }
    const restored = new ChatController({ ...hooks, origin: 'athena-local' }, new ConversationRepository(join(root, 'athena-local', 'chat')))
    try { expect(restored.snapshot().sessions?.find(item => item.title === 'Private coding')?.config.model).toBe('qwen2.5-coder:3b') }
    finally { restored.dispose() }
  })

  it('sends a session-selected model only to loopback Ollama, independent of the floating and online selections', async () => {
    const requests: Array<{ url: string; model: string }> = []
    const service = new OllamaService(() => 'http://127.0.0.1:11434', vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)) as { model: string }
      requests.push({ url: String(url), model: body.model })
      return String(url).endsWith('/api/show')
        ? new Response(JSON.stringify({ capabilities: ['completion'], model_info: { 'qwen.context_length': 32768 } }))
        : new Response(JSON.stringify({ message: { content: 'Local only' }, done: true }) + '\n')
    }))
    const settings = { ...defaultSettings, aiMode: 'subscription' as const, localAI: { ...defaultSettings.localAI, model: 'floating:3b' } }
    const provider = await localChatProvider(service, settings, { ...defaultConversationConfig(), model: 'chat-only:3b' })
    const chunks = []
    for await (const chunk of provider.streamMessage([{ id: randomUUID(), role: 'user', status: 'complete', content: 'Hello', createdAt: 0 }])) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text', text: 'Local only' })
    expect(requests).toHaveLength(2)
    expect(requests.every(request => request.url.startsWith('http://127.0.0.1:11434/') && request.model === 'chat-only:3b')).toBe(true)
    expect(settings.localAI.model).toBe('floating:3b')
    expect(settings.aiMode).toBe('subscription')
  })

  it('requires an explicit active local chat focus before chat events can drive the avatar', () => {
    const floatingId = randomUUID(), localId = randomUUID()
    const avatar = { setConversationState: vi.fn(), setTaskActivity: vi.fn(), setTaskOutcome: vi.fn() }
    let focused = false, linked = true
    const bridge = new LocalActivityBridge(() => avatar, () => focused && linked ? localId : floatingId)
    const localOwner = { origin: 'athena-local' as const, sessionId: localId, correlationId: randomUUID() }
    const floatingOwner = { origin: 'athena-local' as const, sessionId: floatingId, correlationId: randomUUID() }
    bridge.phase('thinking', localOwner)
    expect(avatar.setConversationState).not.toHaveBeenCalled()
    focused = true; bridge.reset(); avatar.setConversationState.mockClear()
    bridge.phase('thinking', floatingOwner)
    expect(avatar.setConversationState).not.toHaveBeenCalled()
    bridge.phase('thinking', localOwner)
    expect(avatar.setConversationState).toHaveBeenCalledWith('thinking')
    linked = false; bridge.reset(); avatar.setConversationState.mockClear()
    bridge.phase('thinking', localOwner)
    expect(avatar.setConversationState).not.toHaveBeenCalled()
    bridge.phase('thinking', { ...localOwner, origin: 'online-chat' })
    expect(avatar.setConversationState).not.toHaveBeenCalled()
    bridge.phase('thinking', floatingOwner)
    expect(avatar.setConversationState).toHaveBeenCalledWith('thinking')
  })
  it('drops an obsolete avatar lease without falsely reporting a completed task', () => {
    const sessionId = randomUUID()
    const avatar = { setConversationState: vi.fn(), setTaskActivity: vi.fn(), setTaskOutcome: vi.fn(), clearTaskOwner: vi.fn() }
    const bridge = new LocalActivityBridge(() => avatar, () => sessionId)
    bridge.phase('thinking', { origin: 'athena-local', sessionId, correlationId: randomUUID() })
    bridge.reset()
    expect(avatar.clearTaskOwner).toHaveBeenCalledOnce()
    expect(avatar.setTaskOutcome).not.toHaveBeenCalled()
    expect(avatar.setConversationState).not.toHaveBeenCalledWith('idle')
  })

  it('keeps ordinary local chat free of unrelated web and screen warnings while reporting explicit screen limits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-local-context-')); directories.push(root)
    const chat = new ChatController({ provider: async () => { throw new Error('No inference needed') }, changed: vi.fn(), phase: vi.fn() })
    const screen = new ScreenCaptureTools({ displays: () => [], capture: async () => [], dispose: () => {} }, () => true, () => true)
    const context = new ChatContextService(chat, new AttachmentService(root, () => true, () => { throw new Error('No image decode needed') }), new WorkspaceService(() => true), { files: async () => [], folder: async () => undefined }, () => true,
      undefined, undefined, undefined, screen, () => ({ active: true, vision: false, tools: false, contextCharacters: 12_000 }),
      new WebSearchService({ read: async () => null, write: async () => {}, remove: async () => {} }), () => ({ ...defaultSettings, webAccess: { ...defaultSettings.webAccess, webSearchEnabled: false } }))
    try {
      const message = (content: string) => ({ id: randomUUID(), role: 'user' as const, content, status: 'complete' as const, createdAt: Date.now() })
      const ordinary = await context.prepare(chat.current(), [message('Explain this function')], new AbortController().signal)
      expect(ordinary.notice).not.toContain('Web search is disabled')
      expect(ordinary.notice).not.toContain('Screen awareness requires')
      const screenRequest = await context.prepare(chat.current(), [message('Read my screen')], new AbortController().signal)
      expect(screenRequest.notice).toContain('Screen awareness requires a model with verified vision')
      expect(screenRequest.projectTools?.definitions.some(tool => tool.name === 'capture_screen')).not.toBe(true)
    } finally { chat.dispose() }
  })
})
