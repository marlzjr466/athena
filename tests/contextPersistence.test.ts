// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import type { AIProvider, StreamOptions } from '../electron/main/ai/AIProvider'
import type { ChatMessage } from '../shared/chat'
import { contextDefaults } from '../shared/context'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const idle = (chat: ChatController) => vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
describe('context checkpoints independent of UI history', () => {
  it('persists canonical memory privately, restores it without resending the covered prefix, and invalidates it for model changes', async () => {
    const storage = new ConversationRepository(mkdtempSync(join(tmpdir(), 'athena-checkpoint-')))
    const calls: { messages: ChatMessage[]; options: StreamOptions }[] = []
    const provider: AIProvider = { testConnection: async () => true, streamMessage: async function* (messages, options = {}) {
      calls.push({ messages: structuredClone(messages), options })
      options.onCheckpoint?.([{ role: 'user', content: 'Checkpoint: preserve original constraints; task pending verification.' }])
      yield { type: 'text', text: 'Answer' }; yield { type: 'done' }
    } }
    const hooks = { provider: async () => provider, changed: vi.fn(), phase: vi.fn() }
    const first = new ChatController(hooks, storage), id = first.current().id
    first.command({ action: 'configure-model', id, model: 'gpt-5.6-sol' })
    first.command({ action: 'configure-context', id, settings: { ...contextDefaults(), maxSearchResults: 8, taskSpendLimitUsd: 2 } })
    first.send({ text: 'Original constraints' }); await idle(first)
    expect(JSON.stringify(first.snapshot())).not.toContain('Checkpoint:')
    expect(first.snapshot().messages[0].content).toBe('Original constraints')
    first.dispose()
    const restored = new ChatController(hooks, storage)
    expect(restored.current().config.contextSettings).toMatchObject({ maxSearchResults: 8, taskSpendLimitUsd: 2 })
    restored.send({ text: 'Continue verification' }); await idle(restored)
    expect(calls[1].options.checkpoint).toBeDefined()
    expect(calls[1].messages.map((entry) => entry.content)).toEqual(['Answer', 'Continue verification'])
    expect(restored.snapshot().messages.map((entry) => entry.content)).toEqual(['Original constraints', 'Answer', 'Continue verification', 'Answer'])
    restored.command({ action: 'configure-model', id, model: 'gpt-4.1' })
    restored.send({ text: 'New model' }); await idle(restored)
    expect(calls[2].options.checkpoint).toBeUndefined()
    expect(calls[2].messages[0].content).toBe('Original constraints')
    restored.dispose()
  })
  it('edited earlier messages invalidate cached context and the live timer survives checkpoint updates', async () => {
    let release!: () => void
    let options!: StreamOptions
    const gate = new Promise<void>((resolve) => { release = resolve })
    const provider: AIProvider = { testConnection: async () => true, streamMessage: async function* (_messages, supplied = {}) {
      options = supplied
      supplied.onCheckpoint?.([{ role: 'user', content: 'Reduced state' }])
      await gate; yield { type: 'text', text: 'Done' }; yield { type: 'done' }
    } }
    const chat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn() })
    chat.send({ text: 'Initial task' })
    await vi.waitFor(() => expect(options).toBeDefined())
    const started = chat.snapshot().messages.at(-1)!.execution!.startedAt
    options.onCheckpoint?.([{ role: 'user', content: 'Task state after tool execution' }])
    expect(chat.snapshot().messages.at(-1)!.execution!.startedAt).toBe(started)
    release(); await idle(chat)
    chat.command({ action: 'edit', id: chat.current().id, messageId: chat.current().messages[0].id, text: 'Changed objective' })
    await idle(chat); expect(options.checkpoint).toBeUndefined()
    chat.clear(); expect(chat.current().contextCheckpoint).toBeUndefined()
    chat.dispose()
  })
  it('durably checkpoints an output continuation without changing task identity, timer, or original messages', async () => {
    const storage = new ConversationRepository(mkdtempSync(join(tmpdir(), 'athena-output-checkpoint-')))
    let supplied!: StreamOptions, release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const provider: AIProvider = { testConnection: async () => true, async *streamMessage(_messages, options = {}) {
      supplied = options; await gate; yield { type: 'text', text: 'Completed safely.' }; yield { type: 'done' }
    } }
    const chat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn() }, storage)
    chat.command({ action: 'configure-model', id: chat.current().id, model: 'gpt-5.6-luna' })
    chat.send({ text: 'Keep user conventions. Implement and verify a component.' })
    await vi.waitFor(() => expect(supplied).toBeDefined())
    const initial = chat.snapshot().messages.at(-1)!
    const activity = chat.activity('run_typecheck', 'Run TypeScript checks')
    chat.finishActivity(activity, { status: 'complete', summary: 'Exit 0' })
    supplied.onCheckpoint?.([{ role: 'user', content: 'Canonical reduced task state' }])
    supplied.onRecovery?.({ attempts: 1, continuing: true, reason: 'max_output_tokens', outputBudget: 65536, effort: 'low', pendingTools: ['edit_file'] })
    const saved = storage.load().sessions[0].messages.at(-1)!
    expect(saved.id).toBe(initial.id)
    expect(saved.execution!.startedAt).toBe(initial.execution!.startedAt)
    expect(saved.execution!.taskCheckpoint).toMatchObject({ taskId: initial.id, model: 'gpt-5.6-luna', continuationAttempts: 1, verificationOperationIds: [activity], originalRequest: 'Keep user conventions. Implement and verify a component.' })
    expect(saved.execution!.taskCheckpoint!.pendingActions[0]).toContain('edit_file')
    expect(chat.snapshot().messages[0].content).toBe('Keep user conventions. Implement and verify a component.')
    release(); await idle(chat)
    const finished = storage.load().sessions[0].messages.at(-1)!.execution!
    expect(finished.status).toBe('complete'); expect(finished.recovery!.continuing).toBe(false)
    expect(finished.taskCheckpoint!.pendingActions).toEqual([])
    expect(finished.startedAt).toBe(initial.execution!.startedAt)
    chat.dispose()
  })
})
