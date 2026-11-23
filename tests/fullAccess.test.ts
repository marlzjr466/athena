// @vitest-environment node
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import type { AIProvider } from '../electron/main/ai/AIProvider'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

const workspace = { id: '58922cd4-0341-42bb-9c8d-2bc40c1d13eb', name: 'Authorized project' }
const otherWorkspace = { id: '620da693-ff43-4c2d-a402-ff6d387928a1', name: 'Other project' }

function controller(provider: AIProvider, storage?: ConversationRepository, workspaceOnly = true) {
  return new ChatController({ provider: async () => provider, authorized: id => id === workspace.id || id === otherWorkspace.id,
    workspaceOnly: () => workspaceOnly, changed: vi.fn(), phase: vi.fn() }, storage)
}

describe('conversation-scoped Full Access', () => {
  it('keeps an active request alive when the selected mode is unchanged', async () => {
    let finish!: () => void
    let activeSignal: AbortSignal | undefined
    const provider: AIProvider = { testConnection: async () => true, async *streamMessage(_messages, options) {
      activeSignal = options!.signal
      await new Promise<void>(resolve => { finish = resolve })
      yield { type: 'done' }
    } }
    const chat = controller(provider)
    try {
      chat.addWorkspace(chat.current().id, workspace)
      const id = chat.current().id
      chat.command({ action: 'agent-mode', id, mode: 'full-access', confirmed: true })
      chat.send({ text: 'Continue this task' })
      await vi.waitFor(() => expect(activeSignal).toBeDefined())
      expect(chat.command({ action: 'agent-mode', id, mode: 'full-access' }).ok).toBe(true)
      expect(activeSignal!.aborted).toBe(false)
      finish()
      await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    } finally { finish?.(); chat.dispose() }
  })
  it('stops the owning background task when its workspace permissions change', async () => {
    let taskSignal: AbortSignal | undefined
    const provider: AIProvider = { testConnection: async () => true, async *streamMessage(_messages, options) {
      taskSignal = options!.signal!
      await new Promise<void>(resolve => taskSignal!.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'done' }
    } }
    const chat = controller(provider)
    try {
      chat.addWorkspace(chat.current().id, workspace)
      const owner = chat.current().id
      chat.command({ action: 'agent-mode', id: owner, mode: 'full-access', confirmed: true })
      chat.send({ text: 'Run project generation' })
      await vi.waitFor(() => expect(taskSignal).toBeDefined())
      chat.command({ action: 'create', workspaceId: workspace.id })
      expect(chat.current().id).not.toBe(owner)
      chat.command({ action: 'project-permissions', id: owner, mode: 'read-only', allowDeletion: false, allowCommands: false })
      expect(taskSignal!.aborted).toBe(true)
      expect(chat.getSession(owner)?.config.contextSettings?.allowProjectCommands).toBe(false)
    } finally { chat.dispose() }
  })
  it('requires one explicit activation, auto-approves consecutive requests, and records each decision', async () => {
    const allowed: boolean[] = []
    const provider: AIProvider = { testConnection: async () => true, async *streamMessage(_messages, options) {
      for (const title of ['Create file', 'Edit file', 'Delete file', 'Run command outside project']) {
        allowed.push(await options!.requestApproval!(title, 'ACP requested this action', options!.signal!, undefined, undefined, true))
      }
      yield { type: 'done' }
    } }
    const chat = controller(provider)
    chat.addWorkspace(chat.current().id, workspace)
    const id = chat.current().id
    expect(chat.command({ action: 'agent-mode', id, mode: 'full-access' }).ok).toBe(false)
    expect(chat.command({ action: 'agent-mode', id, mode: 'full-access', confirmed: true }).ok).toBe(true)
    expect(chat.current().config.contextSettings).toMatchObject({ allowProjectCommands: true, allowProjectDeletion: true })
    expect(chat.send({ text: 'Work in this project' }).ok).toBe(true)
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(allowed).toEqual([true, true, true, true])
    expect(chat.snapshot().messages[1].execution?.approval).toBeUndefined()
    expect(chat.snapshot().messages[1].execution?.permissionDecisions?.map(entry => entry.decision)).toEqual(['automatic', 'automatic', 'automatic', 'automatic'])
    expect(chat.command({ action: 'agent-mode', id, mode: 'ask' }).ok).toBe(true)
    expect(chat.command({ action: 'agent-mode', id, mode: 'full-access' }).ok).toBe(true)
    chat.dispose()
  })

  it('keeps the grant with its conversation across restart and does not copy it to a new conversation or project', async () => {
    const repository = new ConversationRepository(await mkdtemp(join(tmpdir(), 'athena-full-access-')))
    const provider: AIProvider = { testConnection: async () => true, async *streamMessage() { yield { type: 'done' } } }
    const first = controller(provider, repository)
    first.addWorkspace(first.current().id, workspace)
    const originalId = first.current().id
    expect(first.command({ action: 'agent-mode', id: originalId, mode: 'full-access', confirmed: true }).ok).toBe(true)
    const created = first.command({ action: 'create', workspaceId: workspace.id })
    expect(created.ok).toBe(true)
    expect(first.current().config.agentMode).toBe('ask')
    first.command({ action: 'switch', id: originalId })
    expect(first.current().config.agentMode).toBe('full-access')
    first.dispose()
    const restored = controller(provider, repository)
    expect(restored.current().id).toBe(originalId)
    expect(restored.current().config).toMatchObject({ agentMode: 'full-access', fullAccessWorkspaceId: workspace.id })
    restored.command({ action: 'switch', id: restored.snapshot().sessions!.find(session => session.id !== originalId)!.id })
    expect(restored.current().config.agentMode).toBe('ask')
    restored.addWorkspace(restored.current().id, otherWorkspace)
    expect(restored.command({ action: 'agent-mode', id: restored.current().id, mode: 'full-access' }).ok).toBe(false)
    restored.dispose()
  })

  it('retains manual approval for an external or sensitive operation and disallows a broader filesystem scope', async () => {
    let approved = false
    let chat!: ChatController
    const provider: AIProvider = { testConnection: async () => true, async *streamMessage(_messages, options) {
      approved = await chat.approve({ title: 'Capture screen', description: 'External desktop operation', fullAccessEligible: false }, options!.signal!)
      yield { type: 'done' }
    } }
    chat = controller(provider)
    chat.addWorkspace(chat.current().id, workspace)
    const id = chat.current().id
    expect(chat.command({ action: 'agent-mode', id, mode: 'full-access', confirmed: true }).ok).toBe(true)
    chat.send({ text: 'Capture screen' })
    await vi.waitFor(() => expect(chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Capture screen'))
    const approvalId = chat.snapshot().messages.at(-1)!.execution!.approval!.id
    chat.command({ action: 'agent-approval', id, approvalId, allow: false })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(approved).toBe(false)
    expect(chat.snapshot().messages.at(-1)?.execution?.permissionDecisions?.[0]?.decision).toBe('rejected')
    chat.dispose()

    const wide = controller(provider, undefined, false)
    wide.addWorkspace(wide.current().id, workspace)
    expect(wide.command({ action: 'agent-mode', id: wide.current().id, mode: 'full-access', confirmed: true }).ok).toBe(false)
    wide.dispose()
  })
})
