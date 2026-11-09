// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '../shared/settings'
import { defaultConversationConfig, type ConversationConfig } from '../shared/conversations'
import { newConversation } from '../electron/main/ai/conversationRepository'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import type { ChatController } from '../electron/main/ai/chatController'
import type { AttachmentService } from '../electron/main/ai/attachmentService'
import type { WorkspaceService } from '../electron/main/ai/workspaceService'
import type { WebSearchService } from '../electron/main/ai/webSearchService'

function setup(overrides: Partial<Settings> = {}) {
  const session = newConversation({ ...defaultConversationConfig(), model: 'gpt-5.5' as ConversationConfig['model'] })
  const chat = {
    current: () => session,
    activeExecution: () => undefined,
    getSession: () => session,
    beforeAction: vi.fn(async () => {}),
  } as unknown as ChatController
  const settings: Settings = { ...defaultSettings, ...overrides, aiMode: overrides.aiMode ?? 'subscription',
    webAccess: { ...defaultSettings.webAccess, webSearchEnabled: true, searchProvider: 'openai-built-in' as const } }
  const workspaces = { authorized: vi.fn(() => false), filesystemMode: vi.fn(() => 'project-only') } as unknown as WorkspaceService
  const searchOpenAI = vi.fn(async () => ({
    query: 'Search the web for the latest React release', model: 'gpt-5.5', answer: 'The React blog has current release information.',
    sources: [{ title: 'React Blog', url: 'https://react.dev/blog', source: 'react.dev', retrievedAt: '2026-10-11T00:00:00.000Z' }],
    retrievedAt: '2026-10-11T00:00:00.000Z',
  }))
  const rememberResults = vi.fn()
  const service = new ChatContextService(chat, {} as AttachmentService, workspaces, { files: async () => [], folder: async () => undefined }, () => true,
    undefined, undefined, undefined, undefined, () => ({ active: settings.aiMode === 'local', vision: false, tools: true, contextCharacters: 4096 }),
    { searchOpenAI, rememberResults } as unknown as WebSearchService, () => settings,
    async () => ({ apiKey: 'sk-test-openai-search-key', model: 'gpt-5.5', validated: false }))
  const message = { id: 'request-1', role: 'user', content: 'Search the web for the latest React release', status: 'complete', createdAt: 1 } as const
  return { service, session, message, searchOpenAI, rememberResults, chat, settings, workspaces }
}

describe('provider-independent OpenAI web search preparation', () => {
  it('runs OpenAI search while ChatGPT Subscription is the conversation provider and attaches cited evidence', async () => {
    const { service, session, message, searchOpenAI, chat } = setup()
    const context = await service.prepare(session, [message], new AbortController().signal)
    expect(searchOpenAI).toHaveBeenCalledWith(message.content, 'sk-test-openai-search-key', 'gpt-5.5', 45_000, expect.any(AbortSignal))
    expect(chat.beforeAction).toHaveBeenCalledWith('web_search', { query: message.content }, expect.any(AbortSignal))
    expect(context.repositoryText).toContain('OpenAI Responses live web-search evidence')
    expect(context.repositoryText).toContain('The React blog has current release information.')
    expect(context.webSources).toEqual([expect.objectContaining({ title: 'React Blog', url: 'https://react.dev/blog' })])
    expect(context.projectTools?.definitions.map((tool) => tool.name)).toContain('web_search')
    expect(context.realtimeInstructions).toContain('A live OpenAI search was already completed')
  })

  it('keeps web tools when a project is attached, but exposes only read-only realtime tools to voice turns', async () => {
    const { service, session, message, workspaces } = setup()
    session.workspaces.push({ id: '935c6a46-9502-450f-b8e5-e54151a7c179', name: 'React project' })
    vi.mocked(workspaces.authorized).mockReturnValue(true)
    const chatContext = await service.prepare(session, [message], new AbortController().signal)
    expect(chatContext.projectTools?.definitions.map((tool) => tool.name)).toEqual(expect.arrayContaining(['web_search', 'read_file']))
    const voiceContext = await service.prepare(session, [message], new AbortController().signal, true)
    expect(voiceContext.projectTools?.definitions.map((tool) => tool.name)).toContain('web_search')
    expect(voiceContext.projectTools?.definitions.map((tool) => tool.name)).not.toContain('read_file')
  })

  it('keeps OpenAI search out of local inference while allowing public page reading', async () => {
    const { service, session, message, searchOpenAI, settings } = setup({ aiMode: 'local', automationPermissions: { ...defaultSettings.automationPermissions, browserAccess: true } })
    session.config.model = 'gpt-oss:20b'
    const context = await service.prepare(session, [message], new AbortController().signal)
    expect(searchOpenAI).not.toHaveBeenCalled()
    expect(context.projectTools?.definitions.map((tool) => tool.name)).not.toContain('web_search')
    expect(context.projectTools?.definitions.map((tool) => tool.name)).toContain('open_web_page')
    expect(context.repositoryText).not.toContain('OpenAI Responses live web-search evidence')
    expect(settings.aiMode).toBe('local')
  })

  it('does not issue the sidecar request in Strict Offline mode', async () => {
    const { service, session, message, searchOpenAI } = setup({ strictOffline: true })
    await expect(service.prepare(session, [message], new AbortController().signal)).rejects.toThrow('Strict Offline Mode')
    expect(searchOpenAI).not.toHaveBeenCalled()
  })

  it('reports OpenAI search failure without silently switching providers', async () => {
    const { service, session, message, searchOpenAI } = setup()
    searchOpenAI.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(service.prepare(session, [message], new AbortController().signal)).rejects.toThrow('OpenAI Responses web search failed')
  })
})
