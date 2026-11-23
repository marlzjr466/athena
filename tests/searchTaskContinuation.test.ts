// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { newConversation, sessionSchema, type ConversationStorage } from '../electron/main/ai/conversationRepository'
import type { AIProvider } from '../electron/main/ai/AIProvider'
import type { WebSearchService } from '../electron/main/ai/webSearchService'
import type { AttachmentService } from '../electron/main/ai/attachmentService'
import { defaultSettings } from '../shared/settings'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

it.each(['ask', 'advanced', 'full-access'] as const)('resumes /platform-dev in %s after restart, retains empty search history, and reads real local workflow files', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'athena-search-recovery-'))
  const workspaces = new WorkspaceService(() => true)
  const search = { search: vi.fn(async () => []), rememberResults: vi.fn() }
  const settings = { ...defaultSettings, aiMode: 'subscription' as const, webAccess: { ...defaultSettings.webAccess, webSearchEnabled: true, automaticSearch: true, searchProvider: 'searxng' as const } }
  let chat: ChatController, context: ChatContextService, rounds = 0
  const session = newConversation(); session.config.model = 'gpt-5.6-terra'
  let saved = { version: 1 as const, activeId: session.id, sessions: [session] }
  const storage: ConversationStorage = { load: () => structuredClone(saved), save: library => { saved = { ...structuredClone(library), sessions: library.sessions.map(item => sessionSchema.parse(item)) } }, archive: () => {} }
  const reads: string[] = [], outcomes: unknown[] = []
  const provider: AIProvider = { modelId: 'gpt-5.6-terra', testConnection: async () => true, streamMessage: async function* (_messages, options) {
    const tools = options!.context!.projectTools!, signal = options!.signal!
    outcomes.push(JSON.parse(await tools.execute('web_search', { query: 'Public API reference for fixture' }, signal)))
    reads.push(await tools.execute('search_files', { path: 'docs', query: 'workflow', glob: '**/*.yaml', offset: 0 }, signal))
    reads.push(await tools.execute('read_file', { path: 'docs/tickets/MBM-11825/workflow.yaml', start_line: 1, end_line: 10 }, signal))
    if (++rounds === 1) throw new Error('Temporary provider interruption')
    yield { type: 'text', text: 'Read local workflow and continued without external evidence.' }
    yield { type: 'done' }
  } }
  const launch = () => {
    chat = new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, authorized: id => workspaces.authorized(id), workspaceRoot: id => workspaces.authorizedRoot(id), resolveCommand: async () => 'Inspect current workflow and current source version for MBM-11825.', prepare: (session, messages, signal) => context.prepare(session, messages, signal) }, storage)
    context = new ChatContextService(chat, {} as AttachmentService, workspaces, { files: async () => [], folder: async () => undefined }, () => true, undefined, undefined, undefined, undefined, undefined, search as unknown as WebSearchService, () => settings)
  }
  try {
    await mkdir(join(root, 'docs/tickets/MBM-11825'), { recursive: true })
    await writeFile(join(root, 'docs/tickets/MBM-11825/workflow.yaml'), 'status: verification-pending\n')
    session.workspaces = [await workspaces.connect(root)]
    session.config.agentMode = mode
    if (mode === 'full-access') session.config.fullAccessWorkspaceId = session.workspaces[0].id
    launch()
    chat!.send({ text: '/platform-dev MBM-11825' }, { id: 'fixture:platform-dev', name: '/platform-dev', source: 'Claude Project', arguments: 'MBM-11825' })
    await vi.waitFor(() => expect(chat!.snapshot().phase).toBe('idle'))
    expect(chat!.snapshot().messages.at(-1)?.status).toBe('error')
    expect(saved.sessions[0].messages.at(-1)?.execution?.taskCheckpoint?.searchAttempts?.[0].status).toBe('empty')
    chat!.dispose(); launch()
    expect(chat!.retry().ok).toBe(true)
    await vi.waitFor(() => expect(chat!.snapshot().phase).toBe('idle'))
    expect(chat!.snapshot().messages.at(-1)?.status).toBe('complete')
    expect(outcomes).toEqual([expect.objectContaining({ status: 'empty' }), expect.objectContaining({ status: 'empty', repeated: true })])
    expect(search.search).toHaveBeenCalledOnce()
    expect(reads.join('\n')).toContain('verification-pending')
    expect(reads.join('\n')).toContain('workflow.yaml')
  } finally { chat!.dispose(); await rm(root, { recursive: true, force: true }) }
})
