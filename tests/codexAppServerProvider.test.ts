// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AIChunk, ChatMessage } from '../shared/chat'
import type { CodexCLIModel } from '../shared/codex'
import { CodexAppServerProvider } from '../electron/main/ai/CodexAppServerProvider'
import type { CodexAppServerProcess, CodexAppServerSession, CodexCLIService } from '../electron/main/ai/codexCLIService'

const model: CodexCLIModel = { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true }
const messages: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'Inspect the project.', status: 'complete', createdAt: 1 }]

class FakeAppServer {
  notifications = new Set<(message: { method?: string; params?: Record<string, unknown> }) => void>()
  requests = new Set<(message: { id?: number | string; method?: string; params?: Record<string, unknown> }) => void>()
  outbound: Array<{ id: number | string; result?: unknown; error?: unknown }> = []
  rpc = {
    request: vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: model.id }
      if (method === 'turn/start') {
        setTimeout(() => {
          this.notify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Reviewed the project.' } })
          this.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
        }, 40)
        return { turn: { id: 'turn-1' } }
      }
      return {}
    }),
    notify: vi.fn(),
    onNotification: (listener: (message: { method?: string; params?: Record<string, unknown> }) => void) => { this.notifications.add(listener); return () => this.notifications.delete(listener) },
    onServerRequest: (listener: (message: { id?: number | string; method?: string; params?: Record<string, unknown> }) => void) => { this.requests.add(listener); return () => this.requests.delete(listener) },
    respond: (id: number | string, result: unknown) => { this.outbound.push({ id, result }) },
    rejectRequest: (id: number | string, error: string) => { this.outbound.push({ id, error }) },
  }
  notify(message: { method?: string; params?: Record<string, unknown> }) { for (const listener of this.notifications) listener(message) }
  request(message: { id?: number | string; method?: string; params?: Record<string, unknown> }) { for (const listener of this.requests) listener(message) }
}

function fixture(overrides: Partial<{ status: () => Promise<unknown>; tools: boolean }> = {}) {
  const server = new FakeAppServer()
  const session: CodexAppServerSession = { rpc: server.rpc as unknown as CodexAppServerProcess, sandboxRoot: '/tmp/athena-codex-test', accountEmail: 'user@example.com', models: [model], version: 'test', close: vi.fn(async () => {}) }
  const service = { status: overrides.status ?? vi.fn(async () => ({ authenticated: true, models: [model] })), openSession: vi.fn(async () => session) } as unknown as CodexCLIService
  return { provider: new CodexAppServerProvider(service, model.id, 'user@example.com'), server, service }
}

async function collect(provider: CodexAppServerProvider, options: Parameters<CodexAppServerProvider['streamMessage']>[1] = {}) {
  const chunks: AIChunk[] = []
  for await (const chunk of provider.streamMessage(messages, options)) chunks.push(chunk)
  return chunks
}

describe('Codex app-server coding provider', () => {
  it('streams the selected model through a private read-only app-server thread', async () => {
    const { provider, server } = fixture()
    const chunks = await collect(provider, { effort: 'high' })
    expect(chunks).toEqual([{ type: 'text', text: 'Reviewed the project.' }, { type: 'done' }])
    expect(server.rpc.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      model: model.id, cwd: '/tmp/athena-codex-test',
      sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
    }))
    expect(server.rpc.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-1', effort: 'high' }))
  })

  it('exposes only Athena dynamic tools and routes their execution through the guarded project tool adapter', async () => {
    const { provider, server } = fixture()
    const execute = vi.fn(async () => 'Read-only project evidence')
    const context = { attachments: [], repositoryText: '', sources: [], projectTools: {
      definitions: [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      assertAccess: vi.fn(), execute, maxCalls: 3,
    } }
    const streaming = collect(provider, { context })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const threadStart = server.rpc.request.mock.calls.find(([method]) => method === 'thread/start')?.[1] as { dynamicTools?: Array<{ name?: string; tools?: Array<{ name?: string }> }> }
    expect(threadStart.dynamicTools?.[0]).toMatchObject({ name: 'athena', tools: [expect.objectContaining({ name: 'read_file' })] })
    server.request({ id: 41, method: 'item/tool/call', params: { namespace: 'athena', tool: 'read_file', arguments: { path: 'README.md' } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(execute).toHaveBeenCalledWith('read_file', { path: 'README.md' }, expect.any(AbortSignal))
    expect(context.projectTools.assertAccess).toHaveBeenCalled()
    expect(server.outbound).toContainEqual({ id: 41, result: { contentItems: [{ type: 'inputText', text: 'Read-only project evidence' }], success: true } })
    await expect(streaming).resolves.toEqual([{ type: 'text', text: 'Reviewed the project.' }, { type: 'done' }])
  })

  it('rejects native Codex shell requests and never executes them', async () => {
    const { provider, server } = fixture()
    const execute = vi.fn()
    const context = { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [], assertAccess: vi.fn(), execute } }
    const streaming = collect(provider, { context })
    await new Promise((resolve) => setTimeout(resolve, 10))
    server.request({ id: 99, method: 'execCommandApproval', params: { command: 'touch unsafe' } })
    expect(server.outbound).toContainEqual({ id: 99, error: 'Athena allows only its explicitly supplied dynamic tools. Native Codex operations are disabled.' })
    expect(execute).not.toHaveBeenCalled()
    await streaming
  })

  it('does not silently change accounts, models, or treat a plan limit as a full-plan exhaustion', async () => {
    const accountChanged = fixture()
    const session = (await accountChanged.service.openSession()) as unknown as CodexAppServerSession
    Object.defineProperty(session, 'accountEmail', { value: 'other@example.com' })
    await expect(collect(accountChanged.provider)).rejects.toThrow('account changed')

    const invalidModel = new CodexAppServerProvider({ openSession: vi.fn(async () => ({ ...session, accountEmail: 'user@example.com', models: [] })) } as unknown as CodexCLIService, model.id)
    await expect(collect(invalidModel)).rejects.toThrow('no longer available')

    const limited = fixture()
    limited.server.rpc.request.mockImplementation(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: model.id }
      if (method === 'turn/start') {
        setTimeout(() => limited.server.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded' } } } }), 0)
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    await expect(collect(limited.provider)).rejects.toThrow('does not establish that your entire plan allowance is exhausted')
  })
})
