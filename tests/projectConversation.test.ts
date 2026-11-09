// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { createProjectTools } from '../electron/main/ai/projectTools'
import { AgentTools } from '../electron/main/ai/agentTools'
import type { PreparedContext } from '../electron/main/ai/AIProvider'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const call = (name: string, args: unknown, id: string) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id, id: `fc_${id}`, status: 'completed' })
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { output } })
const message = { id: 'user', role: 'user' as const, content: 'Explain the project.', status: 'complete' as const, createdAt: 1 }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'athena-project-chat-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.json'), '{"name":"fixture","main":"src/entry.ts"}')
  await writeFile(join(root, 'src', 'entry.ts'), 'import { authenticate } from "./auth"\nexport const app = authenticate')
  await writeFile(join(root, 'src', 'auth.ts'), 'export function authenticate() {\n  return "local-session"\n}')
  const workspaces = new WorkspaceService(() => true), project = await workspaces.connect(root)
  return { root, project, workspaces }
}

describe('repository exploration through the real conversation/provider pipeline', () => {
  it('automatically continues output exhaustion in the same real-file task, discarding unfinished mutations', async () => {
    const f = await fixture()
    let round = 0, context: ChatContextService, taskId = '', startedAt = 0
    const request = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(init!.body as string)
      const execution = chat.snapshot().messages.at(-1)!.execution!
      if (++round === 1) {
        taskId = execution.taskCheckpoint!.taskId; startedAt = execution.startedAt
        return sse(completed([call('create_file', { path: 'src/Button.tsx', content: 'export const Button = 1' }, 'first')]))
      }
      expect(execution.taskCheckpoint!.taskId).toBe(taskId); expect(execution.startedAt).toBe(startedAt)
      if (round === 2) return sse({ type: 'response.incomplete', response: { output: [{ ...call('create_file', { path: 'src/Discarded.ts', content: 'must not exist' }, 'partial'), status: 'incomplete' }], incomplete_details: { reason: 'max_output_tokens' } } })
      expect(body.input.some((item: any) => item.call_id === 'partial')).toBe(false)
      expect(body.input.find((item: any) => item.type === 'function_call_output' && item.call_id === 'first').output).toContain('"ok":true')
      if (round === 3) return sse(completed([call('read_file', { path: 'src/Button.tsx', start_line: 1, end_line: 5 }, 'reread')]))
      if (round === 4) {
        const evidence = JSON.parse(body.input.find((item: any) => item.type === 'function_call_output' && item.call_id === 'reread').output)
        return sse(completed([call('edit_file', { path: 'src/Button.tsx', expected_version: evidence.version, old_text: 'Button = 1', new_text: 'Button = 2' }, 'finish-edit')]))
      }
      return sse({ type: 'response.output_text.delta', delta: 'Created and updated Button.tsx. Tests not run.' }, completed([]))
    })
    const chat = new ChatController({ provider: async () => new OpenAIProvider('sk-fake', 'gpt-5.6-luna', request), prepare: (...args) => context.prepare(...args), authorized: (id) => f.workspaces.authorized(id), changed: vi.fn(), phase: vi.fn() })
    context = new ChatContextService(chat, new AttachmentService(f.root, () => true, () => { throw new Error() }), f.workspaces, { files: async () => [], folder: async () => f.root }, () => true, new AgentTools(f.workspaces, join(f.root, 'fixture-storage')))
    chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-5.6-luna', effort: 'medium', agentMode: 'workspace-auto' } })
    await context.run({ action: 'connect', sessionId: chat.current().id })
    expect(chat.current().config.agentMode).toBe('ask')
    chat.command({ action: 'agent-mode', id: chat.current().id, mode: 'workspace-auto' })
    chat.send({ text: 'Create and update a component.' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'), { timeout: 5000 })
    expect(chat.snapshot().messages.at(-1)?.status).toBe('complete')
    expect(chat.snapshot().messages.at(-1)?.execution).toMatchObject({ startedAt, recovery: { attempts: 1, continuing: false }, taskCheckpoint: { taskId, modifiedFiles: ['src/Button.tsx'], pendingActions: [] } })
    expect(chat.snapshot().messages.at(-1)?.execution?.activities).toHaveLength(3)
    expect(await readFile(join(f.root, 'src/Button.tsx'), 'utf8')).toBe('export const Button = 2')
    await expect(readFile(join(f.root, 'src/Discarded.ts'))).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(5)
    chat.dispose()
  })
  it('executes OpenAI function calls that read a version, create a file and edit actual source', async () => {
    const f = await fixture()
    let round = 0, context: ChatContextService
    const request = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(init!.body as string)
      expect(body.model).toBe('gpt-4.1')
      if (++round === 1) return sse(completed([call('read_file', { path: 'src/auth.ts', start_line: 1, end_line: 30 }, 'read')]))
      if (round === 2) {
        const evidence = JSON.parse(body.input.find((item: { type: string; call_id: string }) => item.type === 'function_call_output' && item.call_id === 'read').output)
        expect(evidence.version).toMatch(/^[a-f0-9]{64}$/)
        return sse(completed([call('create_file', { path: 'src/Button.tsx', content: 'export const Button = () => <button>Hi</button>' }, 'create'), call('edit_file', { path: 'src/auth.ts', expected_version: evidence.version, old_text: 'local-session', new_text: 'updated-session' }, 'edit')]))
      }
      expect(body.input.filter((item: { type: string }) => item.type === 'function_call_output')).toHaveLength(3)
      return sse({ type: 'response.output_text.delta', delta: 'Created Button.tsx and updated auth.ts. Validation has not run.' }, completed([]))
    })
    const chat = new ChatController({ provider: async () => new OpenAIProvider('sk-test-not-real', 'gpt-4.1', request), prepare: (...args) => context.prepare(...args), authorized: (id) => f.workspaces.authorized(id), changed: vi.fn(), phase: vi.fn() })
    context = new ChatContextService(chat, new AttachmentService(f.root, () => true, () => { throw new Error() }), f.workspaces, { files: async () => [], folder: async () => f.root }, () => true, new AgentTools(f.workspaces, join(f.root, 'fixture-storage')))
    chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-4.1', effort: 'auto', agentMode: 'workspace-auto' } })
    await context.run({ action: 'connect', sessionId: chat.current().id })
    chat.command({ action: 'agent-mode', id: chat.current().id, mode: 'workspace-auto' })
    chat.send({ text: 'Create a Button and update the authentication fixture.' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'), { timeout: 5000 })
    expect(chat.snapshot().messages.at(-1)?.status).toBe('complete')
    expect(await readFile(join(f.root, 'src/Button.tsx'), 'utf8')).toContain('<button>Hi</button>')
    expect(await readFile(join(f.root, 'src/auth.ts'), 'utf8')).toContain('updated-session')
    expect(chat.snapshot().messages.at(-1)?.execution?.activities).toHaveLength(3)
    chat.dispose()
  })
  it('executes multiple rounds and reads an unseen file, returns evidence to the selected model, and persists source references', async () => {
    const f = await fixture(), sources: unknown[] = []
    const bodies: Array<Record<string, any>> = []
    const reasoning = { type: 'reasoning', id: 'rs_one', summary: [], encrypted_content: 'opaque-encrypted-context' }
    const request = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(init!.body as string); bodies.push(body)
      expect(body.model).toBe('gpt-5.6-luna'); expect(body.reasoning.effort).toBe('high')
      if (bodies.length === 1) {
        expect(body.tools.map((tool: { name: string }) => tool.name)).toContain('read_file')
        expect(JSON.stringify(body.input)).not.toContain('local-session')
        // This file did not exist at folder authorization or context preparation.
        await writeFile(join(f.root, 'src', 'unseen.ts'), 'export const previouslyUnseen = "fresh-runtime-value"')
        return sse(completed([reasoning, call('get_project_structure', { path: '', depth: 3 }, 'tree'), call('search_code', { path: '', query: 'authenticate', glob: '**/*.ts', mode: 'symbol', case_sensitive: true, offset: 0 }, 'search')]))
      }
      const outputs = body.input.filter((item: { type: string }) => item.type === 'function_call_output')
      if (bodies.length === 2) {
        expect(body.input).toContainEqual(reasoning)
        expect(outputs).toHaveLength(2)
        expect(outputs[0].output).toContain('src/unseen.ts')
        expect(outputs[1].output).toContain('src/auth.ts')
        return sse(completed([call('read_file', { path: 'src/unseen.ts', start_line: 1, end_line: 20 }, 'read'), call('read_file', { path: 'src/auth.ts', start_line: 1, end_line: 20 }, 'auth')]))
      }
      expect(outputs).toHaveLength(4)
      const unseen = JSON.parse(outputs.find((item: { call_id: string }) => item.call_id === 'read').output)
      expect(unseen.content).toBe('1: export const previouslyUnseen = "fresh-runtime-value"')
      sources.push(unseen)
      return sse({ type: 'response.output_text.delta', delta: 'src/unseen.ts:1 contains fresh-runtime-value. Authentication lives in src/auth.ts:1–3.' }, completed([]))
    })
    let context: ChatContextService
    const chat = new ChatController({ provider: async (config) => new OpenAIProvider('sk-test-not-real', config.model!, request), prepare: (...args) => context.prepare(...args), authorized: (id) => f.workspaces.authorized(id), changed: vi.fn(), phase: vi.fn() })
    const attachments = new AttachmentService(f.root, () => true, () => { throw new Error('Not used') })
    context = new ChatContextService(chat, attachments, f.workspaces, { files: async () => [], folder: async () => f.root }, () => true)
    chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-5.6-luna', effort: 'high' } })
    await context.run({ action: 'connect', sessionId: chat.current().id })
    chat.send({ text: 'Explain the architecture and inspect any new modules.' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'), { timeout: 5000 })
    const reply = chat.snapshot().messages.at(-1)!
    expect(reply.status).toBe('complete'); expect(sources).toHaveLength(1); expect(request).toHaveBeenCalledTimes(3)
    expect(reply.sources).toContainEqual({ workspace: f.project.name, path: 'src/unseen.ts', start: 1, end: 1 })
    expect(reply.sources).toContainEqual({ workspace: f.project.name, path: 'src/auth.ts', start: 1, end: 3 })
    expect(chat.snapshot().contextNotice).toContain('Project access active')
    chat.dispose()
  })
  it('isolates projects across sessions and retains retrieval for unsupported models', async () => {
    const f = await fixture()
    const chat = new ChatController({ provider: async () => { throw new Error('Not used') }, changed: vi.fn(), phase: vi.fn() })
    const context = new ChatContextService(chat, new AttachmentService(f.root, () => true, () => { throw new Error() }), f.workspaces, { files: async () => [], folder: async () => f.root }, () => true)
    const first = chat.current().id
    chat.command({ action: 'configure-model', id: first, model: 'gpt-4.1' })
    await context.run({ action: 'connect', sessionId: first })
    const prepared = await context.prepare(chat.current(), [message], new AbortController().signal)
    expect(prepared.projectTools).toBeDefined(); expect(prepared.repositoryText).toBe('')
    chat.command({ action: 'create' })
    expect((await context.prepare(chat.current(), [message], new AbortController().signal)).projectTools).toBeUndefined()
    await expect(prepared.projectTools!.execute('read_file', { path: 'src/auth.ts', start_line: 1, end_line: 3 }, new AbortController().signal)).rejects.toThrow('disconnected')
    chat.command({ action: 'switch', id: first })
    chat.command({ action: 'configure-model', id: first, model: 'unknown-model' })
    const fallback = await context.prepare(chat.current(), [{ ...message, content: 'Where is authentication?' }], new AbortController().signal)
    expect(fallback.projectTools).toBeUndefined(); expect(fallback.repositoryText).toContain('authenticate'); expect(fallback.notice).toContain('retrieval-only')
    f.workspaces.disconnect(f.project.id)
    expect((await context.prepare(chat.current(), [message], new AbortController().signal)).notice).toContain('paused')
    chat.dispose()
  })
  it('stops at the budget without asking a tool-disabled model to invent an access error', async () => {
    const f = await fixture(), context: PreparedContext = { attachments: [], repositoryText: '', sources: [], projectName: f.project.name }
    context.projectTools = createProjectTools(f.workspaces, f.project.id, f.project.name, context.sources, () => true)
    const request = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(init!.body as string)
      return body.tool_choice === 'none'
        ? sse({ type: 'response.output_text.delta', delta: 'Reached exploration limit.' }, completed([]))
        : sse(completed([call('list_directory', { path: '', offset: 0 }, `call-${request.mock.calls.length}`)]))
    })
    const chunks: unknown[] = []
    await expect(async () => {
      for await (const chunk of new OpenAIProvider('sk-test-not-real', 'gpt-4.1', request).streamMessage([message], { context })) chunks.push(chunk)
    }).rejects.toThrow('Agent execution budget reached')
    expect(request).toHaveBeenCalledTimes(8); expect(chunks).toEqual([])
  })
  it('returns denied-call errors to the model without fabricating source evidence', async () => {
    const f = await fixture(), context: PreparedContext = { attachments: [], repositoryText: '', sources: [] }
    context.projectTools = createProjectTools(f.workspaces, f.project.id, f.project.name, context.sources, () => true)
    const request = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(init!.body as string)
      if (request.mock.calls.length === 1) return sse(completed([call('read_file', { path: '../outside.ts', start_line: 1, end_line: 3 }, 'bad')]))
      expect(body.input.find((item: { type: string }) => item.type === 'function_call_output').output).toContain('Invalid project-relative path')
      return sse({ type: 'response.output_text.delta', delta: 'Access denied.' }, completed([]))
    })
    for await (const _chunk of new OpenAIProvider('sk-test-not-real', 'gpt-4.1', request).streamMessage([message], { context })) { /* consume */ }
    expect(context.sources).toEqual([])
  })
  it('does not execute tools after cancellation or send further requests after access is revoked', async () => {
    const f = await fixture(), abort = new AbortController(), context: PreparedContext = { attachments: [], repositoryText: '', sources: [] }
    context.projectTools = createProjectTools(f.workspaces, f.project.id, f.project.name, context.sources, () => true)
    const execute = vi.spyOn(context.projectTools, 'execute')
    const request = vi.fn<typeof fetch>(async () => { abort.abort(); return sse(completed([call('read_file', { path: 'src/auth.ts', start_line: 1, end_line: 3 }, 'cancelled')])) })
    for await (const _chunk of new OpenAIProvider('sk-test-not-real', 'gpt-4.1', request).streamMessage([message], { signal: abort.signal, context })) { /* consume */ }
    expect(execute).not.toHaveBeenCalled()
    f.workspaces.disconnect(f.project.id)
    await expect(async () => { for await (const _chunk of new OpenAIProvider('sk-test-not-real', 'gpt-4.1', request).streamMessage([message], { context })) { /* consume */ } }).rejects.toThrow('disconnected')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
