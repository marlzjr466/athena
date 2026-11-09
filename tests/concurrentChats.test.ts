import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import type { AIProvider } from '../electron/main/ai/AIProvider'
import { ChatError } from '../electron/main/ai/AIProvider'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function setup(limit = 3) {
  const gates = new Map<string, ReturnType<typeof deferred>>()
  const started: string[] = []
  const endings: Array<{ sessionId: string; status: string; unreadCount: number }> = []
  const provider: AIProvider = {
    testConnection: async () => true,
    streamMessage: async function* (messages, options) {
      const signal = options!.signal!
      const prompt = messages.at(-1)?.content ?? ''
      started.push(prompt)
      yield { type: 'text', text: `${prompt}:begin` }
      await Promise.race([gates.get(prompt)!.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))])
      if (signal.aborted) return
      yield { type: 'text', text: ':done' }
      yield { type: 'done' }
    },
  }
  const chat = new ChatController({ provider: async () => provider, maxConcurrent: () => limit, changed: vi.fn(), phase: vi.fn(), executionEnded: event => endings.push(event) })
  const create = (prompt: string) => {
    const id = chat.current().id
    gates.set(prompt, deferred())
    expect(chat.send({ text: prompt, sessionId: id })).toEqual({ ok: true })
    return id
  }
  return { chat, gates, started, endings, create }
}

describe('independent background conversations', () => {
  it('publishes globally ordered revisions when switching between sessions', () => {
    const f = setup()
    const first = f.chat.current().id
    for (let index = 0; index < 5; index++) f.chat.command({ action: 'draft', id: first, text: `Draft ${index}` })
    const before = f.chat.snapshot().revision
    f.chat.command({ action: 'create' })
    const second = f.chat.current().id
    expect(f.chat.snapshot().sessionId).toBe(second)
    expect(f.chat.snapshot().revision).toBeGreaterThan(before)
    f.chat.command({ action: 'switch', id: first })
    expect(f.chat.snapshot().revision).toBeGreaterThan(before + 1)
    f.chat.dispose()
  })
  it('runs three streams while switching and preserves each reply and completion', async () => {
    const f = setup()
    const a = f.create('A')
    f.chat.command({ action: 'create' }); const b = f.create('B')
    f.chat.command({ action: 'create' }); const c = f.create('C')
    await vi.waitFor(() => expect(f.started).toEqual(['A', 'B', 'C']))
    expect(f.chat.snapshot().sessions?.map(entry => entry.executionStatus)).toEqual(['running', 'running', 'running'])
    f.gates.get('A')!.resolve()
    await vi.waitFor(() => expect(f.chat.getSession(a)?.messages[1].status).toBe('complete'))
    expect(f.chat.snapshot().sessions?.find(entry => entry.id === a)?.unreadCompletion).toBe('complete')
    expect(f.chat.unreadCompletions()).toBe(1)
    f.chat.command({ action: 'switch', id: a })
    expect(f.chat.snapshot().messages[1].content).toBe('A:begin:done')
    expect(f.chat.unreadCompletions()).toBe(0)
    expect(f.chat.getSession(b)?.messages[1].status).toBe('streaming')
    expect(f.chat.getSession(c)?.messages[1].status).toBe('streaming')
    f.gates.get('B')!.resolve(); f.gates.get('C')!.resolve()
    await vi.waitFor(() => expect(f.chat.getSession(c)?.messages[1].status).toBe('complete'))
    expect(f.chat.getSession(b)?.messages[1].content).toBe('B:begin:done')
    expect(f.chat.getSession(c)?.messages[1].content).toBe('C:begin:done')
    expect(f.endings.map(item => item.sessionId)).toContain(a)
    f.chat.dispose()
  })

  it('queues a fourth task and can cancel it without affecting three running tasks', async () => {
    const f = setup()
    const a = f.create('A')
    f.chat.command({ action: 'create' }); const b = f.create('B')
    f.chat.command({ action: 'create' }); const c = f.create('C')
    f.chat.command({ action: 'create' }); const d = f.create('D')
    await vi.waitFor(() => expect(f.started).toHaveLength(3))
    expect(f.chat.snapshot().sessions?.find(item => item.id === d)?.executionStatus).toBe('queued')
    f.chat.stop()
    f.gates.get('A')!.resolve()
    await vi.waitFor(() => expect(f.chat.getSession(a)?.messages[1].status).toBe('complete'))
    expect(f.started).not.toContain('D')
    expect(f.chat.getSession(b)?.messages[1].status).toBe('streaming')
    expect(f.chat.getSession(c)?.messages[1].status).toBe('streaming')
    f.gates.get('B')!.resolve(); f.gates.get('C')!.resolve()
    f.chat.dispose()
  })

  it('only cancels the selected running conversation', async () => {
    const f = setup()
    const a = f.create('A')
    f.chat.command({ action: 'create' }); const b = f.create('B')
    f.chat.command({ action: 'switch', id: a })
    f.chat.stop()
    expect(f.chat.getSession(a)?.messages[1].status).toBe('stopped')
    expect(f.chat.getSession(b)?.messages[1].status).toBe('streaming')
    f.gates.get('B')!.resolve()
    await vi.waitFor(() => expect(f.chat.getSession(b)?.messages[1].status).toBe('complete'))
    f.chat.dispose()
  })

  it('routes delayed tool and child activity to its original conversation', async () => {
    const ready = deferred(), finish = deferred()
    let chat!: ChatController
    const provider: AIProvider = { testConnection: async () => true, streamMessage: async function* () {
      const activityId = chat.activity('read_file', 'Read original project')
      const childId = crypto.randomUUID()
      const release = chat.registerChildCancellation(childId, chat.current().id, vi.fn())
      ready.resolve()
      await finish.promise
      chat.finishActivity(activityId, { status: 'complete', summary: 'Read complete' })
      release()
      yield { type: 'text', text: 'Original response' }
      yield { type: 'done' }
    } }
    chat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn() })
    const original = chat.current().id
    chat.send({ text: 'Original task' })
    await ready.promise
    chat.command({ action: 'create' })
    const other = chat.current().id
    finish.resolve()
    await vi.waitFor(() => expect(chat.getSession(original)?.messages[1].status).toBe('complete'))
    expect(chat.getSession(original)?.messages[1].execution?.activities[0].summary).toBe('Read complete')
    expect(chat.getSession(other)?.messages).toHaveLength(0)
    chat.dispose()
  })

  it('keeps another conversation running when one provider fails', async () => {
    const finish = deferred()
    const provider: AIProvider = { testConnection: async () => true, streamMessage: async function* (messages) {
      if (messages.at(-1)?.content === 'Fail') throw new ChatError('Provider failure')
      await finish.promise
      yield { type: 'text', text: 'Still running' }
      yield { type: 'done' }
    } }
    const chat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn() })
    const a = chat.current().id
    chat.send({ text: 'Keep running' })
    chat.command({ action: 'create' })
    const b = chat.current().id
    chat.send({ text: 'Fail' })
    await vi.waitFor(() => expect(chat.getSession(b)?.messages[1].status).toBe('error'))
    expect(chat.getSession(a)?.messages[1].status).toBe('streaming')
    finish.resolve()
    await vi.waitFor(() => expect(chat.getSession(a)?.messages[1].status).toBe('complete'))
    chat.dispose()
  })

  it('persists unread completions and checkpoints without replaying interrupted tools', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-concurrent-recovery-'))
    const finish = deferred()
    const provider: AIProvider = { testConnection: async () => true, streamMessage: async function* () { await finish.promise; yield { type: 'text', text: 'Finished' }; yield { type: 'done' } } }
    const hooks = { provider: async () => provider, changed: vi.fn(), phase: vi.fn() }
    try {
      const chat = new ChatController(hooks, new ConversationRepository(directory))
      const a = chat.current().id
      chat.send({ text: 'Background work' })
      chat.command({ action: 'create' })
      finish.resolve()
      await vi.waitFor(() => expect(chat.getSession(a)?.messages[1].status).toBe('complete'))
      expect(chat.unreadCompletions()).toBe(1)
      chat.dispose()
      const restored = new ChatController(hooks, new ConversationRepository(directory))
      expect(restored.unreadCompletions()).toBe(1)
      expect(restored.getSession(a)?.messages[1].content).toBe('Finished')
      restored.command({ action: 'switch', id: a })
      expect(restored.unreadCompletions()).toBe(0)
      restored.dispose()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('bounds local inference across separate Athena chat controllers', async () => {
    const hold = deferred()
    const started: string[] = []
    const provider: AIProvider = { testConnection: async () => true, streamMessage: async function* (messages) {
      const prompt = messages.at(-1)?.content ?? ''
      started.push(prompt)
      if (prompt === 'First') await hold.promise
      yield { type: 'text', text: prompt }
      yield { type: 'done' }
    } }
    const hooks = { resource: 'local' as const, maxConcurrent: () => 1, provider: async () => provider, changed: vi.fn(), phase: vi.fn() }
    const first = new ChatController(hooks), second = new ChatController(hooks)
    first.send({ text: 'First' }); second.send({ text: 'Second' })
    await vi.waitFor(() => expect(started).toEqual(['First']))
    expect(second.snapshot().sessions?.[0].executionStatus).toBe('queued')
    hold.resolve()
    await vi.waitFor(() => expect(started).toEqual(['First', 'Second']))
    first.dispose(); second.dispose()
  })
})
