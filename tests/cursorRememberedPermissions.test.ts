// @vitest-environment node
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { CursorACPProvider, CursorACPService } from '../electron/main/ai/cursorACP'
import { AgentCommands } from '../electron/main/ai/agentCommands'
import type { RememberedScope } from '../shared/permissions'

describe('Cursor host-created remembered permission scopes', () => {
  it.each(['read', 'edit', 'delete', 'execute'])('offers only exact native reads (%s)', async kind => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-cursor-permission-')))
    await writeFile(join(root, 'app.ts'), 'export {}')
    // No subprocess is required to test ACP message routing. Disable optional
    // terminal support rather than binding a real command-server socket.
    const supported = vi.spyOn(AgentCommands.prototype, 'supported').mockResolvedValue(false)
    const service = new CursorACPService(async (_command, args) => args[0] === 'status'
      ? { stdout: 'Logged in as athena@example.test', stderr: '' }
      : args[0] === 'models' ? { stdout: 'auto - Auto', stderr: '' } : { stdout: '1.0.0', stderr: '' }, async () => '/mock/cursor')
    type Message = { id?: number; method?: string; params?: Record<string, unknown> }
    let notification: ((message: Message) => void) | undefined
    let finish!: (value: Record<string, unknown>) => void
    const prompt = new Promise<Record<string, unknown>>(resolve => { finish = resolve })
    const responses: unknown[] = []
    const provider = new CursorACPProvider(service, root, false, 'athena@example.test', 'auto', async () => {}, () => ({
      set onNotification(value: ((message: Message) => void) | undefined) { notification = value },
      request: async method => {
        if (method === 'session/new') return { sessionId: 'permission-session', currentModelId: 'auto' }
        if (method === 'session/prompt') {
          notification?.({ id: 1, method: 'session/request_permission', params: { sessionId: 'permission-session', toolCall: { kind, title: 'Native operation', locations: [{ path: 'app.ts' }] } } })
          return prompt
        }
        return {}
      },
      notify: async () => {}, close: () => {}, respondError: () => { finish({}) },
      respond: (_id, response) => { responses.push(response); notification?.({ method: 'session/update', params: { sessionId: 'permission-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Operation resolved.' } } } }); finish({ stopReason: 'end_turn' }) },
    }))
    const scopes: Array<RememberedScope | undefined> = []
    try {
      for await (const _chunk of provider.streamMessage([], { permissionMode: 'ask', signal: AbortSignal.timeout(5000), requestApproval: async (_title, _description, _signal, _changes, scope) => { scopes.push(scope); return true } })) { /* consume */ }
      expect(scopes).toEqual(kind === 'execute' ? [] : [kind === 'read' ? { operation: 'cursor_read', project: root, resources: [join(root, 'app.ts')] } : undefined])
      expect(responses).toEqual([{ outcome: { outcome: 'selected', optionId: kind === 'execute' ? 'reject-once' : 'allow-once' } }])
    } finally { supported.mockRestore(); await rm(root, { recursive: true, force: true }) }
  })
})
