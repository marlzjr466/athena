// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { recentContext } from '../electron/main/ai/contextBudget'
import { modelCapabilities } from '../shared/conversations'
import { timelineBlocks } from '../src/features/chat/agentTimelinePresentation'
import type { AIProvider } from '../electron/main/ai/AIProvider'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const stream: AIProvider = { testConnection: async () => true, streamMessage: async function* () { yield { type: 'text', text: 'Answer' }; yield { type: 'done' } } }
const hooks = () => ({ provider: vi.fn(async () => stream), changed: vi.fn(), phase: vi.fn() })
const idle = (chat: ChatController) => vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
describe('persistent conversation sessions', () => {
  it('keeps every saved session when a Copilot account id is not a UUID', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-copilot-history-'))
    const storage = new ConversationRepository(directory)
    const chat = new ChatController({ ...hooks(), accountIdentity: async () => 'copilot:cli:octocat' }, storage)
    const id = chat.snapshot().sessionId!
    chat.send({ text: 'Keep this chat', sessionId: id }); await idle(chat)
    chat.command({ action: 'create' })
    chat.dispose()
    const restored = new ChatController(hooks(), new ConversationRepository(directory))
    expect(restored.snapshot().error).toBeNull()
    expect(restored.snapshot().sessions?.map(session => session.title).sort()).toEqual(['Keep this chat', 'New conversation'])
    restored.command({ action: 'switch', id })
    expect(restored.snapshot().messages.at(-1)?.execution?.accountId).toBe('copilot:cli:octocat')
    restored.dispose()
  })
  it('creates, titles, renames, searches and restores independent contexts/configs/drafts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-sessions-')), storage = new ConversationRepository(directory), h = hooks()
    const chat = new ChatController(h, storage), first = chat.snapshot().sessionId!
    chat.send({ text: 'Explain authentication', sessionId: first }); await idle(chat)
    expect(chat.snapshot().sessions?.[0].title).toBe('Explain authentication')
    chat.command({ action: 'configure', id: first, config: { provider: 'OpenAI', model: 'gpt-5.2', effort: 'high' } })
    chat.command({ action: 'create' }); const second = chat.snapshot().sessionId!
    expect(second).not.toBe(first); expect(chat.snapshot().messages).toEqual([])
    chat.command({ action: 'configure', id: second, config: { provider: 'OpenAI', model: 'gpt-4.1', effort: 'high' } })
    expect(chat.snapshot().config?.effort).toBe('auto')
    chat.command({ action: 'draft', id: second, text: 'A saved draft' })
    chat.command({ action: 'rename', id: first, title: 'Auth architecture' })
    expect(chat.search('authentication')).toEqual([first])
    chat.dispose()
    const restored = new ChatController(hooks(), new ConversationRepository(directory))
    expect(restored.snapshot()).toMatchObject({ sessionId: second, draft: 'A saved draft', config: { model: 'gpt-4.1' } })
    restored.command({ action: 'switch', id: first })
    expect(restored.snapshot().messages.map((message) => message.content)).toEqual(['Explain authentication', 'Answer'])
    expect(restored.snapshot().config).toMatchObject({ model: 'gpt-5.2', effort: 'high' })
    expect(restored.command({ action: 'delete', id: first }).ok).toBe(true)
    expect(restored.snapshot().sessionId).toBe(second)
    expect(readdirSync(join(directory, 'conversation-archive'))).toHaveLength(1)
    restored.dispose()
  })
  it('keeps a stream running and saves its late output after switching sessions', async () => {
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const chat = new ChatController({ ...hooks(), provider: async () => ({ ...stream, streamMessage: async function* () { yield { type: 'text', text: 'Partial' }; await gate; yield { type: 'text', text: ' stale' }; yield { type: 'done' } } }) })
    const first = chat.snapshot().sessionId!
    chat.send({ text: 'Hello' }); await vi.waitFor(() => expect(chat.snapshot().phase).toBe('speaking'))
    chat.command({ action: 'create' }); resume(); await new Promise((resolve) => setTimeout(resolve, 10))
    expect(chat.snapshot().messages).toEqual([])
    chat.command({ action: 'switch', id: first })
    expect(chat.snapshot().messages.at(-1)).toMatchObject({ content: 'Partial stale', status: 'complete' })
    chat.dispose()
  })
  it('persists inline progress-to-operation ordering across an app-style conversation restore', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-inline-timeline-')), storage = new ConversationRepository(directory)
    let chat!: ChatController
    const provider: AIProvider = {
      testConnection: async () => true,
      async *streamMessage() {
        yield { type: 'text', text: 'I am inspecting the implementation.' }
        const read = chat.activity('read_file', 'Read · src/service.ts')
        chat.finishActivity(read, { status: 'complete', summary: 'Source read completed.' })
        yield { type: 'text', text: 'I found the affected path.' }
        yield { type: 'done' }
      },
    }
    chat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn() }, storage)
    chat.send({ text: 'Inspect this project' }); await idle(chat); chat.dispose()

    const restored = new ChatController(hooks(), new ConversationRepository(directory))
    const execution = restored.snapshot().messages.at(-1)!.execution!
    expect(execution.timeline?.map((event) => event.kind)).toEqual(['text', 'activity', 'text'])
    expect(timelineBlocks(execution)).toMatchObject([
      { kind: 'text', text: 'I am inspecting the implementation.' },
      { kind: 'activity-group', activities: [{ tool: 'read_file', summary: 'Source read completed.' }] },
      { kind: 'text', text: 'I found the affected path.' },
    ])
    restored.dispose()
  })
  it('queues a Cursor model switch until the active response ends and persists each conversation choice', async () => {
    const storage = new ConversationRepository(mkdtempSync(join(tmpdir(), 'athena-cursor-models-')))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const used: (string | null)[] = []
    const chat = new ChatController({ provider: async (config) => { used.push(config.model); return { testConnection: async () => true, async *streamMessage() { await gate; yield { type: 'text', text: 'Done' }; yield { type: 'done' } } } }, changed: vi.fn(), phase: vi.fn() }, storage)
    chat.selectCursorModel('grok-4.7')
    const first = chat.current().id
    chat.send({ text: 'Work on this task', sessionId: first })
    await vi.waitFor(() => expect(used).toEqual(['grok-4.7']))
    chat.queueCursorModel('kimi-k2')
    expect(chat.current().config).toMatchObject({ model: 'grok-4.7', cursorPendingModel: 'kimi-k2' })
    release(); await idle(chat)
    expect(chat.current().config).toMatchObject({ model: 'kimi-k2', cursorModel: 'kimi-k2' })
    chat.command({ action: 'create' }); chat.selectCursorModel('auto')
    chat.command({ action: 'switch', id: first })
    expect(chat.current().config.model).toBe('kimi-k2')
    chat.dispose()
    const restored = new ChatController(hooks(), storage)
    expect(restored.current().config.cursorModel).toBe('kimi-k2')
    restored.dispose()
  })
  it('restores the full Cursor context, effort and speed selection without reducing it to a base model', () => {
    const storage = new ConversationRepository(mkdtempSync(join(tmpdir(), 'athena-cursor-parameters-')))
    const chat = new ChatController(hooks(), storage)
    const selection = 'grok-4.7[context=500k,reasoning_effort=medium,fast=false]'
    chat.selectCursorModel(selection)
    const first = chat.current().id
    chat.command({ action: 'create' })
    chat.selectCursorModel('grok-4.6[effort=high,fast=true]')
    chat.dispose()
    const restored = new ChatController(hooks(), storage)
    expect(restored.current().config.model).toBe('grok-4.6[effort=high,fast=true]')
    restored.command({ action: 'switch', id: first })
    expect(restored.current().config).toMatchObject({ cursorModel: selection, model: selection })
    restored.dispose()
  })
  it('editing an earlier turn removes later context and regeneration preserves the edited input', async () => {
    const chat = new ChatController(hooks())
    chat.send({ text: 'First' }); await idle(chat); chat.send({ text: 'Second' }); await idle(chat)
    chat.command({ action: 'edit', id: chat.snapshot().sessionId!, messageId: chat.snapshot().messages[0].id, text: 'Revised' }); await idle(chat)
    expect(chat.snapshot().messages.map((message) => message.content)).toEqual(['Revised', 'Answer'])
    chat.retry(); await idle(chat); expect(chat.snapshot().messages).toHaveLength(2); chat.dispose()
  })
  it('rejects stale sends and prevents duplicate messages with request IDs', async () => {
    const chat = new ChatController(hooks()), id = chat.snapshot().sessionId!
    const input = { text: 'Only once', sessionId: id, requestId: '2fdf1fb4-7cf7-41e1-885d-2ea951e4b764' }
    chat.send(input); chat.send(input); await idle(chat); chat.send(input)
    expect(chat.snapshot().messages).toHaveLength(2)
    chat.command({ action: 'create' }); expect(chat.send({ text: 'stale', sessionId: id }).ok).toBe(false); chat.dispose()
  })
  it('persists partial streams and recovers interrupted responses as stopped', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-interrupted-')), storage = new ConversationRepository(directory)
    const chat = new ChatController({ ...hooks(), provider: async () => new Promise(() => {}) }, storage)
    chat.send({ text: 'Interrupted' })
    expect(new ConversationRepository(directory).load().sessions[0].messages.at(-1)?.status).toBe('stopped')
    chat.dispose()
  })
  it('reclassifies an existing token-expired coding run as recoverable without replaying it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-expired-')), storage = new ConversationRepository(directory)
    const chat = new ChatController(hooks(), storage)
    chat.send({ text: '/platform-build MBM-11390' }); await idle(chat)
    const session = chat.current(), reply = session.messages.at(-1)!
    reply.status = 'error'; reply.error = 'ChatGPT authorization expired or was rejected (HTTP 401 (token_expired)). Reconnect in Settings → AI.'
    reply.execution!.status = 'error'; reply.execution!.activities.push({ id: 'read-1', tool: 'read_file', label: 'Read src/App.tsx', startedAt: 1, finishedAt: 2, status: 'complete' })
    storage.save({ version: 1, activeId: session.id, sessions: [session] })
    const restored = storage.load().sessions[0].messages.at(-1)!
    expect(restored.execution?.status).toBe('waiting-auth')
    expect(restored.execution?.activities).toHaveLength(1)
    expect(restored.execution?.taskCheckpoint?.pendingActions[0]).toContain('Reconnect')
    chat.dispose()
  })
  it('does not overwrite corrupt saved history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-corrupt-')), path = join(directory, 'conversations.json')
    writeFileSync(path, 'damaged history')
    const chat = new ChatController(hooks(), new ConversationRepository(directory))
    expect(chat.snapshot().error).toContain('cannot be saved')
    chat.command({ action: 'create' }); chat.dispose(); expect(readFileSync(path, 'utf8')).toBe('damaged history')
  })
  it('paginates history and bounds provider context without deleting saved turns', async () => {
    const chat = new ChatController(hooks())
    for (let index = 0; index < 32; index++) { chat.send({ text: `Message ${index}` }); await idle(chat) }
    expect(chat.snapshot().messages).toHaveLength(60); expect(chat.snapshot().hasMore).toBe(true)
    chat.command({ action: 'more', id: chat.snapshot().sessionId! }); expect(chat.snapshot().messages).toHaveLength(64)
    const context = recentContext(chat.snapshot().messages, 1000)
    expect(context.truncated).toBe(true); expect(context.messages[0].role).toBe('user'); expect(context.messages.at(-1)?.content).toBe('Answer'); chat.dispose()
  })
  it('unknown models expose only Auto and no unverified vision capability', () => {
    expect(modelCapabilities('unknown-future-model')).toMatchObject({ efforts: ['auto'], vision: false })
    expect(modelCapabilities('gpt-4.1').efforts).toEqual(['auto'])
    expect(modelCapabilities('gpt-5.2').efforts).toContain('xhigh')
    expect(modelCapabilities('gpt-5.6-luna')).toMatchObject({ efforts: ['auto', 'low', 'medium', 'high', 'xhigh'], vision: true })
  })
})
