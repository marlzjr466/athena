// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { AgentTools } from '../electron/main/ai/agentTools'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { SlashCommandService } from '../electron/main/ai/slashCommandService'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { contextDefaults, contextSettingsSchema } from '../shared/context'
import { agentBudgetNotice } from '../electron/main/ai/agentBudget'
import { supportsProjectTools } from '../electron/main/ai/projectTools'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const sse = (output: unknown[]) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const call = (name: string, args: unknown, n: number) => ({ type: 'function_call', name, namespace: 'athena', arguments: JSON.stringify(args), call_id: `c${n}`, id: `fc${n}`, status: 'completed' })
describe('coding budgets and authorized slash execution', () => {
  it('migrates saved limits safely, rejects unlimited budgets and warns before exhaustion', () => {
    expect(contextSettingsSchema.parse({})).toMatchObject({ maxAgentIterations: 64, maxToolCalls: 160, maxExecutionMinutes: 30 })
    expect(contextSettingsSchema.safeParse({ maxAgentIterations: Infinity }).success).toBe(false)
    expect(agentBudgetNotice(50, 64, 20, 160)).toBeUndefined()
    expect(agentBudgetNotice(51, 64, 20, 160)).toContain('Approaching')
    expect(agentBudgetNotice(64, 64, 64, 160)).toContain('NOT been revoked')
    expect(supportsProjectTools('claude-sonnet-4-5')).toBe(true)
    expect(supportsProjectTools('unverified-model')).toBe(false)
  })
  it('expands platform-build, batches independent inspection and edits real files via subscription transport', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'athena-build-budget-')), root = join(dir, 'project'), storage = join(dir, 'storage')
    await mkdir(join(root, '.claude/commands'), { recursive: true })
    await writeFile(join(root, '.claude/commands/platform-build.md'), '---\ndescription: Build a fixture\n---\nImplement $ARGUMENTS using approved project tools. Preserve user changes.')
    await writeFile(join(root, 'app.ts'), 'export const value = 1\r\n// existing user work\r\n')
    const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root)
    const slash = new SlashCommandService(workspaces, storage, () => true)
    let n = 0, context: ChatContextService
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      expect(body.tools[0].tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['create_file', 'edit_file', 'apply_patch', 'move_file', 'delete_file', 'run_tests']))
      expect(body.input.some((m: { content?: string }) => typeof m.content === 'string' && m.content.includes('Implement MBM-11390'))).toBe(true)
      expect(body.parallel_tool_calls).toBe(true)
      n++
      if (n === 1) return sse([call('get_file_metadata', { path: 'app.ts' }, 1), call('read_file', { path: 'app.ts', start_line: 1, end_line: 10 }, 2)])
      if (n === 2) {
        const evidence = JSON.parse(body.input.find((item: { type: string; call_id?: string }) => item.type === 'function_call_output' && item.call_id === 'c2').output)
        return sse([call('edit_file', { path: 'app.ts', expected_version: evidence.version, old_text: 'value = 1', new_text: 'value = 2' }, 3)])
      }
      return sse([{ type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Updated app.ts. Validation not run.', annotations: [] }] }])
    })
    const repository = new ConversationRepository(storage)
    const chat = new ChatController({ provider: async () => new OpenAIProvider('fixture', 'gpt-5.6-luna', request, undefined, true), prepare: (...args) => context.prepare(...args), resolveCommand: (...args) => slash.resolve(...args), authorized: id => workspaces.authorized(id), changed: vi.fn(), phase: vi.fn() }, repository)
    context = new ChatContextService(chat, new AttachmentService(storage, () => true, () => { throw new Error() }), workspaces, { files: async () => [], folder: async () => root }, () => true, new AgentTools(workspaces, storage))
    chat.addWorkspace(chat.current().id, workspace)
    chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-5.6-luna', effort: 'high', agentMode: 'workspace-auto', contextSettings: contextDefaults() } })
    const entry = (await slash.list(chat.current())).commands.find(c => c.name === '/platform-build')!
    expect(entry).toBeDefined()
    chat.send({ text: '/platform-build MBM-11390' }, { id: entry.id, name: entry.name, source: entry.source, arguments: 'MBM-11390' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'), { timeout: 8000 })
    expect(chat.snapshot().messages.at(-1)?.error).toBeUndefined()
    expect(chat.snapshot().messages.at(-1)?.status).toBe('complete')
    expect(n).toBe(3)
    expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe('export const value = 2\r\n// existing user work\r\n')
    expect(repository.load().sessions[0].messages.at(-1)?.execution?.taskCheckpoint?.modifiedFiles).toEqual(['app.ts'])
    expect(repository.load().sessions[0].messages.at(-1)?.execution?.budgetSummary).toMatchObject({ iterations: 3, toolCalls: 3, successfulModifications: 1 })
    chat.dispose()
  }, 10000)
})
