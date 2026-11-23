// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '../shared/settings'
import { defaultConversationConfig, type ConversationConfig } from '../shared/conversations'
import { newConversation } from '../electron/main/ai/conversationRepository'
import { ChatContextService, selectRequestAttachments } from '../electron/main/ai/chatContextService'
import type { ChatController } from '../electron/main/ai/chatController'
import type { AttachmentService } from '../electron/main/ai/attachmentService'
import type { WorkspaceService } from '../electron/main/ai/workspaceService'
import type { WebSearchService } from '../electron/main/ai/webSearchService'

function setup(overrides: Partial<Settings> = {}) {
  const session = newConversation({ ...defaultConversationConfig(), model: 'gpt-5.5' as ConversationConfig['model'] })
  const chat = {
    current: () => session,
    activeExecution: () => undefined,
    recordSearchAttempts: vi.fn(),
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
  const search = vi.fn(async () => [{ title: 'React Blog', url: 'https://react.dev/blog', source: 'react.dev', snippet: 'Current release information.', retrievedAt: new Date().toISOString() }])
  const service = new ChatContextService(chat, {} as AttachmentService, workspaces, { files: async () => [], folder: async () => undefined }, () => true,
    undefined, undefined, undefined, undefined, () => ({ active: settings.aiMode === 'local', vision: false, tools: true, contextCharacters: 4096 }),
    { searchOpenAI, rememberResults, search } as unknown as WebSearchService, () => settings,
    async () => ({ apiKey: 'sk-test-openai-search-key', model: 'gpt-5.5', validated: false }))
  const message = { id: 'request-1', role: 'user', content: 'Search the web for the latest React release', status: 'complete', createdAt: 1 } as const
  return { service, session, message, searchOpenAI, rememberResults, search, chat, settings, workspaces }
}

describe('provider-independent OpenAI web search preparation', () => {
  it.each(['subscription', 'cloud', 'claude-api', 'cursor', 'antigravity', 'copilot', 'third-party', 'local'] as const)('supplies SearXNG evidence before inference for %s', async aiMode => {
    const { service, session, message, search, searchOpenAI, settings } = setup({ aiMode, automationPermissions: { ...defaultSettings.automationPermissions, browserAccess: true } })
    settings.webAccess.searchProvider = 'searxng'
    const context = await service.prepare(session, [message], new AbortController().signal)
    expect(search).toHaveBeenCalledOnce()
    expect(searchOpenAI).not.toHaveBeenCalled()
    expect(context.repositoryText).toContain('Live search evidence from Local SearXNG')
    expect(context.webSources).toEqual([expect.objectContaining({ url: 'https://react.dev/blog' })])
  })
  it.each(['subscription', 'cloud', 'claude-api', 'cursor', 'antigravity', 'copilot', 'third-party', 'local'] as const)('continues preparation after empty SearXNG results for %s', async aiMode => {
    const { service, session, message, search, settings } = setup({ aiMode, automationPermissions: { ...defaultSettings.automationPermissions, browserAccess: true } })
    settings.webAccess.searchProvider = 'searxng'
    search.mockResolvedValueOnce([])
    const context = await service.prepare(session, [message], new AbortController().signal)
    expect(context.repositoryText).toContain('"status":"empty"')
    expect(context.webSources).toEqual([])
    expect(context.notice).toContain('Continuing')
  })
  it('routes an expanded slash command and synthetic resume through local tools without searching its instructions', async () => {
    const { service, session, search, settings } = setup()
    settings.webAccess.searchProvider = 'searxng'
    settings.webAccess.automaticSearch = true
    const original = { id: 'slash', role: 'user' as const, status: 'complete' as const, createdAt: 1, content: '/platform-dev MBM-11825', command: { id: 'fixture', name: '/platform-dev', arguments: 'MBM-11825', source: 'Claude Project' as const } }
    session.messages.push(original)
    const expanded = { ...original, content: 'Inspect current source version and current workflow before changes.' }
    await service.prepare(session, [expanded], new AbortController().signal)
    await service.prepare(session, [expanded, { id: 'resume', role: 'user', status: 'complete', createdAt: 2, content: 'Continue the unfinished request. Inspect the current filesystem state.' }], new AbortController().signal)
    expect(search).not.toHaveBeenCalled()
  })
  it('continues preparation after SearXNG connectivity failure', async () => {
    const { service, session, message, search, settings } = setup()
    settings.webAccess.searchProvider = 'searxng'
    search.mockRejectedValueOnce(new Error('network'))
    const context = await service.prepare(session, [message], new AbortController().signal)
    expect(context.repositoryText).toContain('"status":"unavailable"')
  })
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

  it('does not spend OpenAI API search credits when Antigravity is selected', async () => {
    const { service, session, message, searchOpenAI } = setup({ aiMode: 'antigravity' })
    session.config.model = 'gemini-3-pro' as ConversationConfig['model']
    const context = await service.prepare(session, [message], new AbortController().signal)
    expect(searchOpenAI).not.toHaveBeenCalled()
    expect(context.repositoryText).not.toContain('OpenAI Responses live web-search evidence')
    expect(context.notice).toContain('does not use Athena’s separate OpenAI API web search')
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

describe('request-scoped attachment selection', () => {
  const attachment = (id: string, name: string) => ({ id, name, mime: 'text/plain', size: 10, kind: 'text' as const, characters: 10, origin: 'paste' as const })
  it('does not re-embed unrelated attachments from older turns', () => {
    const messages = [
      { id: 'old', role: 'user' as const, content: 'See this', status: 'complete' as const, createdAt: 1, attachments: [attachment('a', 'old-notes.txt')] },
      { id: 'current', role: 'user' as const, content: 'Continue the project task', status: 'complete' as const, createdAt: 2 },
    ]
    expect(selectRequestAttachments(messages, 'Continue the project task')).toEqual([])
  })

  it('includes a prior attachment when the current request names it', () => {
    const old = attachment('a', 'lifecycle-plan.txt')
    const current = attachment('b', 'new-notes.txt')
    const messages = [
      { id: 'old', role: 'user' as const, content: 'Attached plan', status: 'complete' as const, createdAt: 1, attachments: [old] },
      { id: 'current', role: 'user' as const, content: 'Compare lifecycle-plan.txt against this update', status: 'complete' as const, createdAt: 2, attachments: [current] },
    ]
    expect(selectRequestAttachments(messages, messages[1].content).map(item => item.id)).toEqual(['b', 'a'])
  })

  it('uses the latest prior attachment group for an explicit generic reference', () => {
    const messages = [
      { id: 'old', role: 'user' as const, content: 'Old', status: 'complete' as const, createdAt: 1, attachments: [attachment('a', 'old.txt')] },
      { id: 'newer', role: 'user' as const, content: 'New', status: 'complete' as const, createdAt: 2, attachments: [attachment('b', 'latest.txt')] },
      { id: 'current', role: 'user' as const, content: 'Review the attached content', status: 'complete' as const, createdAt: 3 },
    ]
    expect(selectRequestAttachments(messages, messages[2].content).map(item => item.id)).toEqual(['b'])
  })
})
vi.mock('../electron/main/ai/projectGitService', () => ({ ProjectGitService: class { async guard() { return () => {} } } }))
