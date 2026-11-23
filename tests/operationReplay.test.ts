// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { classifyCommandOperation, classifyOperation } from '../electron/main/ai/operationRisk'
import { AgentTools } from '../electron/main/ai/agentTools'
import { AgentCommands } from '../electron/main/ai/agentCommands'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { ProjectIntelligence } from '../electron/main/ai/projectIntelligence'
import { SlashCommandService } from '../electron/main/ai/slashCommandService'
import { combineTools } from '../electron/main/ai/applicationTools'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { ChatError, type AIProvider, type ProjectTools } from '../electron/main/ai/AIProvider'
import { ContinuationController } from '../electron/main/ai/continuationController'
import { ToolCallSession } from '../electron/main/ai/toolCallSession'
import type { OperationRisk } from '../shared/generation'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

it.each([
  ['git', ['status', '--short', '--branch'], 'read-only'],
  ['git', ['branch'], 'read-only'], ['git', ['branch', '--list', '-a'], 'read-only'],
  ['git', ['diff', '--cached', '--no-ext-diff', '--no-textconv'], 'read-only'],
  ['git', ['log', '-10', '--oneline'], 'read-only'],
  ['git', ['branch', 'new-branch'], 'non-idempotent'],
  ['git', ['branch', '-D', 'main'], 'destructive'],
  ['git', ['commit', '-m', 'message'], 'non-idempotent'],
  ['git', ['push', 'origin', 'main'], 'non-idempotent'],
  ['git', ['push', '--force', 'origin', 'main'], 'destructive'],
  ['git', ['clean', '-fd'], 'destructive'], ['git', ['add', '--', 'a.ts'], 'idempotent'],
  ['git', ['status', '--unknown'], 'unknown'],
  ['git', ['-c', 'alias.status=!echo injected', 'status'], 'unknown'],
  ['git', ['diff', '--output=result.txt'], 'unknown'], ['git', ['log', '--textconv'], 'unknown'],
  ['git', ['status', ';', 'rm', '-rf', '.'], 'unknown'],
  ['git', ['status', '$(touch marker)'], 'unknown'],
  ['sh', ['-c', 'git status'], 'unknown'],
  ['npm', ['run', 'build'], 'unknown'], ['npm', ['run', 'test'], 'unknown'],
  ['node', ['-e', 'require("fs").writeFileSync("x","y")'], 'unknown'],
  ['node', ['--version'], 'read-only'], ['curl', ['https://example.com'], 'unknown'],
] as const)('classifies %s %j as %s', (executable, args, risk) => {
  expect(classifyCommandOperation(executable, args)).toBe(risk)
})

it('does not equate parallel execution with repeat safety or trust unregistered tools', () => {
  const tools: ProjectTools = { definitions: [{ name: 'parallel_action', description: '', parameters: {} }], parallelSafe: () => true, assertAccess: () => {}, execute: async () => '{}' }
  expect(classifyOperation(tools, 'parallel_action', {})).toBe('unknown')
  expect(classifyOperation({ ...tools, operationRisk: () => 'read-only' }, 'unregistered', {})).toBe('unknown')
})

it.each(['ask', 'full-access'] as const)('restores legacy checkpoints and repeats real registered reads in %s without replay prompts', async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-replay-'))), storage = join(root, 'private')
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root)
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/app.ts'), 'export const version = 1\n')
  await writeFile(join(root, 'AGENTS.md'), 'Keep project evidence accurate.\n')
  const sandboxTest = process.env.ATHENA_REPLAY_SANDBOX_TEST === '1'
  if (sandboxTest) {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['add', '--', 'src/app.ts', 'AGENTS.md'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Athena Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'Fixture'], { cwd: root })
  }
  const repository = new ConversationRepository(storage), agent = new AgentTools(workspaces, storage)
  const intelligence = new ProjectIntelligence(workspaces, new SlashCommandService(workspaces, storage, () => true), storage, { call: vi.fn() })
  if (!sandboxTest) vi.spyOn(AgentCommands.prototype, 'supported').mockResolvedValue(true)
  const commands = vi.spyOn(AgentCommands.prototype, 'execute')
  if (!sandboxTest) commands.mockResolvedValue({ command: 'git inspection', exitCode: 0, output: 'verified fixture status', truncated: false, timedOut: false })
  let chat: ChatController, attempt = 0
  const manual: string[] = [], results: string[] = []
  const operations: [string, unknown][] = [['git_status', {}], ['git_branch', { create: null }], ['git_diff', {}], ['git_log', {}], ['inspect_project_instructions', { path: 'src/app.ts' }], ['read_file', { path: 'src/app.ts', start_line: 1, end_line: 10 }], ['list_directory', { path: 'src', offset: 0 }], ['search_files', { path: 'src', query: 'app', glob: '**/*.ts', offset: 0 }]]
  const provider: AIProvider = { testConnection: async () => true, async *streamMessage(_messages, options) {
    for (const [name, input] of operations) results.push(await options!.context!.projectTools!.execute(name, input, options!.signal!))
    if (++attempt === 1) throw new ChatError('Fixture transport interruption')
    yield { type: 'text', text: 'Fresh project state inspected.' }; yield { type: 'done' }
  } }
  const launch = () => {
    chat = new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, authorized: id => workspaces.authorized(id), workspaceRoot: id => workspaces.authorizedRoot(id), workspaceOnly: () => true,
      prepare: async session => {
        const tools = agent.create(chat, session.id, workspace.id, workspace.name, session.config.agentMode!, [], () => true)
        const projectTools = combineTools(tools, intelligence.createTools(session, tools, async () => { throw new Error('No embeddings used in this fixture') }, async () => {}))!
        expect(classifyOperation(projectTools, 'git_branch', { create: null })).toBe('read-only')
        expect(classifyOperation(projectTools, 'git_branch', { create: 'new-branch' })).toBe('non-idempotent')
        expect(classifyOperation(projectTools, 'git_status', { args: ['--evil'] })).toBe('unknown')
        return { attachments: [], repositoryText: '', sources: [], projectTools }
      }, approvalChanged: event => {
        if (event.action !== 'required') return
        manual.push(event.summary!)
        queueMicrotask(() => chat.command({ action: 'agent-approval', id: event.sessionId, approvalId: event.approvalId, allow: !event.summary?.startsWith('Confirm repeat') }))
      } }, repository)
  }
  try {
    launch(); chat!.addWorkspace(chat!.current().id, workspace)
    chat!.command({ action: 'agent-mode', id: chat!.current().id, mode, ...(mode === 'full-access' ? { confirmed: true as const } : {}) })
    chat!.send({ text: 'Inspect this project' })
    await vi.waitFor(() => expect(chat!.snapshot().phase).toBe('idle'))
    expect(chat!.snapshot().messages.at(-1)?.error).toContain('Fixture transport')
    chat!.dispose()
    // Reproduce receipts written by the previous release: all reads were
    // marked modifying, and the new risk property did not yet exist.
    const saved = repository.load()!
    for (const operation of saved.sessions[0].messages.at(-1)!.execution!.taskCheckpoint!.control!.operations) { operation.readOnly = false; delete operation.risk }
    repository.save(saved)
    await writeFile(join(root, 'src/app.ts'), 'export const version = 2\n')
    launch(); expect(chat!.retry().ok).toBe(true)
    await vi.waitFor(() => expect(chat!.snapshot().phase).toBe('idle'))
    expect(chat!.snapshot().messages.at(-1)?.status).toBe('complete')
    expect(manual.some(title => title.startsWith('Confirm repeat'))).toBe(false)
    expect(manual.length).toBe(mode === 'full-access' ? 0 : 8)
    expect(commands).toHaveBeenCalledTimes(8)
    expect((await Promise.all(commands.mock.results.map(result => result.value))).every(result => result.exitCode === 0)).toBe(true)
    expect(results.some(result => result.includes('version = 2'))).toBe(true)
    expect(chat!.snapshot().messages.at(-1)?.execution?.taskCheckpoint?.control?.operations.slice(-8).every(operation => operation.risk === 'read-only')).toBe(true)
  } finally { chat!?.dispose(); intelligence.dispose(); await agent.dispose(); await rm(root, { recursive: true, force: true }) }
}, 30_000)

it.each(['idempotent', 'non-idempotent', 'destructive', 'unknown'] as const)('protects saved %s operations even if a legacy receipt wrongly called them read-only', async risk => {
  const original = new ContinuationController(), input = { path: 'file' }
  original.operationStarted('operation', input, true)
  const restored = new ContinuationController({}, undefined, original.state), execute = vi.fn(async () => '{}')
  const tools: ProjectTools = { definitions: [{ name: 'operation', description: '', parameters: {} }], operationRisk: () => risk, assertAccess: () => {}, execute }
  const result = await new ToolCallSession(tools, new AbortController().signal, 10, restored).executeBatch([{ type: 'function_call', call_id: 'retry', name: 'operation', arguments: JSON.stringify(input), status: 'completed' }], 8000)
  expect(result[0]).toContain('uncertain_replay'); expect(execute).not.toHaveBeenCalled()
})

it('preserves a completed file creation and denies its replay in Full Access after restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-write-replay-')))
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root)
  const repository = new ConversationRepository(join(root, 'private')), agent = new AgentTools(workspaces, join(root, 'private'))
  let chat: ChatController, attempt = 0
  const manual: string[] = [], results: string[] = []
  const provider: AIProvider = { testConnection: async () => true, async *streamMessage(_messages, options) {
    results.push(await options!.context!.projectTools!.execute('create_file', { path: 'result.ts', content: 'export const result = 1\n' }, options!.signal!))
    if (++attempt === 1) throw new ChatError('Fixture interrupted after writing')
    yield { type: 'done' }
  } }
  const launch = () => { chat = new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, authorized: id => workspaces.authorized(id), workspaceRoot: id => workspaces.authorizedRoot(id), workspaceOnly: () => true,
    prepare: async session => ({ attachments: [], repositoryText: '', sources: [], projectTools: agent.create(chat, session.id, workspace.id, workspace.name, session.config.agentMode!, [], () => true) }),
    approvalChanged: event => { if (event.action === 'required') { manual.push(event.summary!); queueMicrotask(() => chat.command({ action: 'agent-approval', id: event.sessionId, approvalId: event.approvalId, allow: false })) } },
  }, repository) }
  try {
    launch(); chat!.addWorkspace(chat!.current().id, workspace); chat!.command({ action: 'agent-mode', id: chat!.current().id, mode: 'full-access', confirmed: true })
    chat!.send({ text: 'Create one fixture file' }); await vi.waitFor(() => expect(chat!.snapshot().phase).toBe('idle'))
    expect(await readFile(join(root, 'result.ts'), 'utf8')).toBe('export const result = 1\n')
    expect(manual).toEqual([]); chat!.dispose()
    await writeFile(join(root, 'result.ts'), 'export const result = 2\n')
    launch(); expect(chat!.retry().ok).toBe(true); await vi.waitFor(() => expect(chat!.snapshot().phase).toBe('idle'))
    expect(manual).toEqual(['Confirm repeat of a saved operation'])
    expect(results.at(-1)).toContain('uncertain_replay')
    expect(await readFile(join(root, 'result.ts'), 'utf8')).toBe('export const result = 2\n')
    expect(chat!.snapshot().messages.at(-1)?.execution?.taskCheckpoint?.control?.operations.filter(item => item.tool === 'create_file')).toHaveLength(1)
  } finally { chat!?.dispose(); await agent.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each(['read-only', 'non-idempotent', 'unknown'] as OperationRisk[])('uses trusted native operation classification on Full Access resume: %s', async risk => {
  const root = await mkdtemp(join(tmpdir(), 'athena-native-replay-')), repository = new ConversationRepository(root)
  const workspace = { id: '58922cd4-0341-42bb-9c8d-2bc40c1d13eb', name: 'Fixture' }
  let chat: ChatController, round = 0
  const manual: string[] = []
  const provider: AIProvider = { nativeAgent: true, testConnection: async () => true, async *streamMessage(_messages, options) {
    await options!.requestApproval!('Run isolated Git inspection', 'Fixture command', options!.signal!, undefined, undefined, undefined, { risk })
    if (++round === 1) throw new ChatError('Fixture interrupted')
    yield { type: 'done' }
  } }
  const launch = () => { chat = new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, authorized: () => true, workspaceOnly: () => true,
    approvalChanged: event => { if (event.action === 'required') { manual.push(event.summary!); queueMicrotask(() => chat.command({ action: 'agent-approval', id: event.sessionId, approvalId: event.approvalId, allow: false })) } },
  }, repository) }
  try {
    launch(); chat!.addWorkspace(chat!.current().id, workspace); chat!.command({ action: 'agent-mode', id: chat!.current().id, mode: 'full-access', confirmed: true })
    chat!.send({ text: 'Inspect project' }); await vi.waitFor(() => expect(chat!.snapshot().phase).toBe('idle')); chat!.dispose()
    launch(); chat!.retry(); await vi.waitFor(() => expect(chat!.snapshot().phase).toBe('idle'))
    expect(manual).toEqual(risk === 'read-only' ? [] : ['Confirm repeat: Run isolated Git inspection'])
  } finally { chat!?.dispose(); await rm(root, { recursive: true, force: true }) }
})
