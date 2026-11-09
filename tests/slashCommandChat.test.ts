import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import type { AIProvider } from '../electron/main/ai/AIProvider'
import { sessionSchema } from '../electron/main/ai/conversationRepository'
import type { ChatMessage } from '../shared/chat'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

describe('slash commands in the existing conversation engine', () => {
  it('retains partial work and original command history when retrying a failed command', async () => {
    let runs = 0
    const provider: AIProvider = { testConnection: async () => true, streamMessage: vi.fn(async function* () {
      if (++runs === 1) {
        const activity = chat.activity('apply_patch', 'Update a source file')
        chat.finishActivity(activity, { status: 'complete', summary: 'Saved authorized change', changes: [{ id: 'change-1', path: 'src/component.ts', diff: '+corrected', status: 'applied' }] })
        throw new Error('Provider failed after saved change')
      }
      yield { type: 'text', text: 'Reviewed the saved change; remaining verification is pending.' } as const
      yield { type: 'done' } as const
    }) }
    const chat = new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, resolveCommand: async () => 'Expanded command requirements' })
    chat.send({ text: '/platform-init' }, { id: 'project:init', name: '/platform-init', source: 'Claude Project', arguments: '' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    const first = structuredClone(chat.snapshot().messages)
    expect(first[1].status).toBe('error')
    expect(chat.retry().ok).toBe(true)
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages.slice(0, 2)).toEqual(first)
    expect(chat.snapshot().messages.at(-1)?.status).toBe('complete')
    const retryInput = vi.mocked(provider.streamMessage).mock.calls[1][0]
    expect(retryInput.find(message => message.role === 'assistant')?.content).toContain('src/component.ts (applied, change change-1)')
    expect(retryInput.find(message => message.role === 'assistant')?.content).toContain('do not repeat completed edits blindly')
    chat.dispose()
  })
  it('persists original text and command identity while sending expanded instructions only to the active provider', async () => {
    const provider: AIProvider = { testConnection: async () => true, streamMessage: vi.fn(async function* () { yield { type: 'text', text: 'Done.' } as const; yield { type: 'done' } as const }) }
    const resolveCommand = vi.fn(async (_session, _command, _text) => 'Expanded project workflow for MBM-11559')
    const chat = new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, resolveCommand })
    const command = { id: 'project:one:claude-command:.claude/commands/platform-spec.md', name: '/platform-spec', source: 'Claude Project' as const, arguments: 'MBM-11559' }
    expect(chat.send({ text: '/platform-spec MBM-11559' }, command).ok).toBe(true)
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages[0]).toMatchObject({ content: '/platform-spec MBM-11559', command })
    expect(sessionSchema.parse(chat.current()).messages[0].command).toEqual(command)
    expect(vi.mocked(provider.streamMessage).mock.calls[0][0].at(-1)?.content).toBe('Expanded project workflow for MBM-11559')
    expect(chat.snapshot().messages[1].content).toBe('Done.')
    chat.send({ text: 'A normal follow-up' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(resolveCommand).toHaveBeenCalledTimes(1)
    expect(vi.mocked(provider.streamMessage).mock.calls[1][0].at(-1)?.content).toBe('A normal follow-up')
    chat.dispose()
  })
  it('does not retain command identity when a user edits its historical message', async () => {
    const provider: AIProvider = { testConnection: async () => true, streamMessage: async function* () { yield { type: 'done' } } }
    const chat = new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, resolveCommand: async () => 'expanded' })
    const command = { id: 'project:a', name: '/review', source: 'Claude Project' as const, arguments: '' }
    chat.send({ text: '/review' }, command)
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    const id = chat.snapshot().messages[0].id
    expect(chat.command({ action: 'edit', id: chat.current().id, messageId: id, text: 'Please review this.' }).ok).toBe(true)
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages[0].command).toBeUndefined()
    chat.dispose()
  })
  it('stores a freshly re-resolved command identity when an existing user message is edited and resent', async () => {
    const streamMessage = vi.fn(async function* (_messages: ChatMessage[]) { yield { type: 'text', text: 'Rebuilt.' } as const; yield { type: 'done' } as const })
    const provider: AIProvider = { testConnection: async () => true, streamMessage }
    const chat = new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, resolveCommand: async (_session, command) => `Fresh definition ${command.id}: ${command.arguments}` })
    chat.send({ text: 'Build this.' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    const id = chat.snapshot().messages[0].id
    expect(chat.command({ action: 'edit', id: chat.current().id, messageId: id, text: '/platform-build MBM-11390' }, { id: 'project:current', name: '/platform-build', source: 'Claude Project', arguments: 'MBM-11390' }).ok).toBe(true)
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages[0]).toMatchObject({ content: '/platform-build MBM-11390', command: { id: 'project:current', arguments: 'MBM-11390' } })
    expect(streamMessage.mock.calls.at(-1)?.[0].at(-1)?.content).toContain('Fresh definition project:current: MBM-11390')
    chat.dispose()
  })
})
