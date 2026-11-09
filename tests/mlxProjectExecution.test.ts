// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, stat, chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { AgentTools } from '../electron/main/ai/agentTools'
import { SlashCommandService } from '../electron/main/ai/slashCommandService'
import { ProjectIntelligence } from '../electron/main/ai/projectIntelligence'
import { combineTools } from '../electron/main/ai/applicationTools'
import { newConversation } from '../electron/main/ai/conversationRepository'
import { mlxProjectTools } from '../electron/main/ai/mlxProjectTools'
import { MLXProvider } from '../electron/main/ai/MLXProvider'
import { OllamaProvider } from '../electron/main/ai/OllamaProvider'
import { directFileRequest } from '../electron/main/ai/mlxDirectFiles'
import { guardMLXTools } from '../electron/main/ai/mlxProjectTools'
import { defaultSettings } from '../shared/settings'
import { contextDefaults } from '../shared/context'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { MLXInference } from '../electron/main/ai/mlxInference'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import type { ChatController } from '../electron/main/ai/chatController'
import type { AttachmentService } from '../electron/main/ai/attachmentService'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const roots: string[] = []
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }) })
async function fixture(mode: 'ask' | 'read-only' | 'advanced' = 'ask') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-mlx-crud-'))); roots.push(root)
  const project = join(root, 'project'), storage = join(root, 'storage')
  for (const dir of ['src/nested', 'docs', '.claude/commands', 'skills/platform-spec', '.agents/skills/review']) await mkdir(join(project, dir), { recursive: true })
  await mkdir(storage)
  await writeFile(join(project, 'src/nested/keep.ts'), 'export const keep = true;\n')
  await writeFile(join(project, '.claude/commands/platform-spec.md'), '---\ndescription: Produce a safe fixture artifact\nargument-hint: [topic]\n---\nRead [skill](../../skills/platform-spec/CLAUDE.md). Create src/artifact.ts containing export const artifact = true; then read it back.\n')
  await writeFile(join(project, 'skills/platform-spec/CLAUDE.md'), 'Read [architecture](../../docs/architecture.md). Do not run shell commands.')
  await writeFile(join(project, 'docs/architecture.md'), 'This fixture stores TypeScript utilities in src/.')
  await writeFile(join(project, '.agents/skills/review/SKILL.md'), '---\nname: review\ndescription: Review code\n---\nRead sources.')
  await writeFile(join(project, 'AGENTS.md'), 'Preserve unrelated content.')
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(project)
  const session = newConversation(); session.workspaces = [workspace]; session.config.model = 'mlx:fixture'; session.config.agentMode = mode
  const approve = vi.fn(async (_request: any, _signal: AbortSignal) => true)
  const activity = vi.fn((_tool: string, _label: string) => randomUUID()), finishActivity = vi.fn(), stageChanges = vi.fn()
  const chat = { getSession: () => session, activity, finishActivity, approve, beforeAction: async () => {}, stageChanges, updateActivityOutput: vi.fn(), updateActivityLabel: vi.fn(), changeReverted: vi.fn() }
  const agent = new AgentTools(workspaces, storage)
  const base = mlxProjectTools(agent.create(chat, session.id, workspace.id, workspace.name, mode, [], () => true, { ...contextDefaults(), maxToolCalls: 150 }, undefined, 'project-only', true))
  const commands = new SlashCommandService(workspaces, storage, () => true, join(root, 'user'))
  const intelligence = new ProjectIntelligence(workspaces, commands, storage, { call: vi.fn() })
  const tools = mlxProjectTools(combineTools(base, intelligence.createTools(session, base, async () => { throw Error('No embeddings required') }, async () => {}))!)
  const signal = new AbortController().signal
  const run = async (name: string, input: unknown = {}) => { const raw = JSON.parse(await tools.execute(name, input, signal)); return raw.result ?? raw }
  const read = (path: string) => run('read_file', { path, start_line: 1, end_line: 400 })
  return { root, project, storage, session, commands, workspaces, workspace, tools, signal, run, read, approve, activity, finishActivity, stageChanges, agent, chat, intelligence }
}
describe('MLX authorized coding on disposable projects', () => {
  it('keeps ordinary chat available without a project and exposes no filesystem tools', async () => {
    const f = await fixture()
    const service = { call: vi.fn(async () => new Response(JSON.stringify({ message: { content: 'Hello!' }, done: true, done_reason: 'stop' }) + '\n')) }
    const provider = new MLXProvider(service as unknown as OllamaService, 'mlx:fixture', { ...defaultSettings.localAI, contextLength: 32768 }, { name: 'mlx:fixture', provider: 'mlx', capabilities: ['completion'], size: 1, contextLength: 32768 })
    const context = { authorizedProject: false, projectTools: f.tools, attachments: [], sources: [], repositoryText: '' }
    const messages = [{ id: 'u', role: 'user' as const, content: 'Hello', status: 'complete' as const, createdAt: 1 }]
    const chunks = []
    for await (const chunk of provider.streamMessage(messages, { context })) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text', text: 'Hello!' })
    expect((service.call.mock.calls as unknown as any[][])[0][1].tools ?? []).toHaveLength(0)
    expect(f.activity).not.toHaveBeenCalled()
    await expect((async () => { for await (const _ of provider.streamMessage([{ ...messages[0], content: 'Analyze this project architecture' }], { context })) {} })()).rejects.toThrow('authorized project')
  })
  it('A–E: creates, reads, patches, renames and deletes through MLX tool rounds and real approvals', async () => {
    const f = await fixture(), pending: Array<() => void> = []
    f.approve.mockImplementation(async () => new Promise<boolean>(resolve => pending.push(() => resolve(true))))
    const bodies: any[] = []; let step = 0
    const service = { call: vi.fn(async (_path: string, body: any) => {
      bodies.push(body)
      const last = [...body.messages].reverse().find((m: any) => m.role === 'tool')
      const data = last ? JSON.parse(last.content) : undefined
      const calls = [
        ['create_file', { path: 'src/add.ts', content: 'export const add = (a: number, b: number) => a + b;\n// keep this line\n' }],
        ['read_file', { path: 'src/add.ts', start_line: 1, end_line: 20 }],
        ['edit_file', { path: 'src/add.ts', expected_version: data?.version, old_text: 'a + b', new_text: 'a + b + 1' }],
        ['read_file', { path: 'src/add.ts', start_line: 1, end_line: 20 }],
        ['rename_file', { path: 'src/add.ts', destination: 'src/sum.ts', expected_version: data?.version }],
        ['read_file', { path: 'src/sum.ts', start_line: 1, end_line: 20 }],
        ['delete_file', { path: 'src/sum.ts', expected_version: data?.version }],
      ] as const
      const next = calls[step++]
      return new Response(JSON.stringify({ message: next ? { tool_calls: [{ function: { name: next[0], arguments: next[1] } }] } : { content: 'Completed the approved file changes and read back the utility.' }, done: true, done_reason: 'stop' }) + '\n')
    }) }
    const provider = new MLXProvider(service as unknown as OllamaService, 'mlx:fixture', { ...defaultSettings.localAI, contextLength: 32768 }, { name: 'mlx:fixture', provider: 'mlx', capabilities: ['completion'], size: 1, contextLength: 32768 })
    const task = (async () => { for await (const _ of provider.streamMessage([{ id: 'u', role: 'user', content: 'Create, inspect, edit, rename and delete a TypeScript utility.', status: 'complete', createdAt: 1 }], { context: { authorizedProject: true, projectName: 'fixture', projectTools: f.tools, attachments: [], sources: [], repositoryText: '' } })) {} })()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    await expect(readFile(join(f.project, 'src/add.ts'))).rejects.toThrow()
    pending.shift()!()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    expect(await readFile(join(f.project, 'src/add.ts'), 'utf8')).toContain('a + b;')
    pending.shift()!()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    expect(await readFile(join(f.project, 'src/add.ts'), 'utf8')).toContain('a + b + 1;\n// keep this line')
    pending.shift()!()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    await expect(stat(join(f.project, 'src/add.ts'))).rejects.toThrow()
    expect(await readFile(join(f.project, 'src/sum.ts'), 'utf8')).toContain('a + b + 1')
    pending.shift()!(); await task
    await expect(stat(join(f.project, 'src/sum.ts'))).rejects.toThrow()
    expect(f.stageChanges).toHaveBeenCalledTimes(4)
    expect(bodies[1].messages.some((m: any) => m.role === 'tool')).toBe(true)
    expect(f.activity).toHaveBeenCalledWith('create_file', expect.any(String))
    expect(f.finishActivity).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'complete' }))
  })
  it('F–H: discovers actual commands and Codex skills, resolves references, previews and verifies a safe workflow', async () => {
    const f = await fixture()
    const catalog = await f.run('discover_project_commands')
    const command = catalog.commands.find((c: any) => c.name === '/platform-spec')
    expect(catalog.commands.some((c: any) => c.name === '/skill:review')).toBe(true)
    expect(catalog.commands.some((c: any) => c.name === '/platform-build')).toBe(false)
    expect(await f.commands.invocation(f.session, '/platform-spec demo')).toMatchObject({ id: command.id, arguments: 'demo' })
    const preview = await f.run('inspect_project_command', { id: command.id, arguments: 'demo' })
    expect(preview.content).toContain('Create src/artifact.ts')
    expect(preview.references).toContainEqual(expect.objectContaining({ path: 'skills/platform-spec/CLAUDE.md' }))
    expect((await f.read('skills/platform-spec/CLAUDE.md')).content).toContain('docs/architecture.md')
    expect((await f.read('docs/architecture.md')).content).toContain('TypeScript')
    const plan = await f.run('plan_project_workflow', { command_id: command.id, arguments: 'demo', summary: 'Create and verify a harmless TypeScript artifact.', steps: [
      { title: 'Create', tool: 'create_file', input: { path: 'src/artifact.ts', content: 'export const artifact = true;\n' }, dependsOn: [] },
      { title: 'Verify', tool: 'read_file', input: { path: 'src/artifact.ts', start_line: 1, end_line: 5 }, dependsOn: [0] },
    ] })
    await expect(stat(join(f.project, 'src/artifact.ts'))).rejects.toThrow()
    expect((await f.run('execute_project_workflow_step', { plan_id: plan.id, step: 0 })).status).toBe('complete')
    expect(f.approve).toHaveBeenCalledTimes(1)
    const verified = await f.run('execute_project_workflow_step', { plan_id: plan.id, step: 1 })
    expect(verified.complete).toBe(true); expect(verified.output).toContain('artifact = true')
    expect(await readFile(join(f.project, 'src/artifact.ts'), 'utf8')).toBe('export const artifact = true;\n')
    await expect(f.run('execute_project_workflow_step', { plan_id: plan.id, step: 0 })).rejects.toThrow('pending')
  })
  it('I: rejects path escapes, symlinks, protected files, Git writes and workflow bypasses', async () => {
    const f = await fixture()
    await symlink(f.root, join(f.project, 'escape'))
    for (const path of ['../outside.ts', '/tmp/outside.ts', '~/.ssh/key']) await expect(f.run('create_file', { path, content: 'x' })).rejects.toThrow('authorized project')
    for (const path of ['escape/out.ts', '.env', 'node_modules/out.ts']) expect(await f.run('create_file', { path, content: 'x' })).toHaveProperty('error')
    for (const name of ['git_commit', 'git_add', 'start_dev_server']) await expect(f.run(name, {})).rejects.toThrow('unavailable')
    const command = (await f.commands.list(f.session)).commands.find(c => c.name === '/platform-spec')!
    await expect(f.run('plan_project_workflow', { command_id: command.id, arguments: '', summary: 'Forbidden', steps: [{ title: 'Commit', tool: 'git_commit', input: { message: 'bad' }, dependsOn: [] }] })).rejects.toThrow('Unknown tool')
  })
  it('enforces Read only, rejected approvals, cancellation and stale versions', async () => {
    const readOnly = await fixture('read-only')
    await expect(readOnly.run('create_file', { path: 'x.ts', content: 'x' })).rejects.toThrow('unavailable')
    const f = await fixture()
    const source = await f.read('src/nested/keep.ts')
    await writeFile(join(f.project, 'src/nested/keep.ts'), '// external edit\n')
    expect(await f.run('edit_file', { path: 'src/nested/keep.ts', expected_version: source.version, old_text: 'true', new_text: 'false' })).toHaveProperty('error')
    f.approve.mockResolvedValue(false)
    expect(await f.run('create_file', { path: 'denied.ts', content: 'x' })).toHaveProperty('error')
    await expect(stat(join(f.project, 'denied.ts'))).rejects.toThrow()
    const abort = new AbortController(); abort.abort()
    await expect(f.tools.execute('create_directory', { path: 'cancelled' }, abort.signal)).rejects.toThrow()
    await expect(stat(join(f.project, 'cancelled'))).rejects.toThrow()
  })
  it('moves populated directories, recovers deletion, and preserves file bytes/modes', async () => {
    const f = await fixture()
    await chmod(join(f.project, 'src/nested/keep.ts'), 0o755)
    expect(await f.run('rename_directory', { path: 'src/nested', destination: 'src/renamed' })).toMatchObject({ ok: true, verified: true })
    await expect(stat(join(f.project, 'src/nested'))).rejects.toThrow()
    expect((await stat(join(f.project, 'src/renamed/keep.ts'))).mode & 0o777).toBe(0o755)
    const deletion = await f.run('delete_directory', { path: 'src/renamed', recursive: true })
    expect(deletion).toMatchObject({ ok: true, verified: true })
    await expect(stat(join(f.project, 'src/renamed'))).rejects.toThrow()
    expect(await f.run('revert_change', { id: deletion.changes[0].id })).toMatchObject({ ok: true })
    expect(await readFile(join(f.project, 'src/renamed/keep.ts'), 'utf8')).toBe('export const keep = true;\n')
    expect(f.approve).toHaveBeenCalledTimes(3)
  })
  it('rejects changed trees, destination overwrite, and trees containing protected files', async () => {
    const f = await fixture()
    const preview = await f.agent.edits.prepareTree(f.session.id, f.workspace.id, 'src/nested', 'src/moved')
    await writeFile(join(f.project, 'src/nested/new.ts'), 'external')
    await expect(f.agent.edits.apply(preview, f.signal)).rejects.toThrow('changed')
    expect(await f.run('move_directory', { path: 'src/nested', destination: 'docs' })).toHaveProperty('error')
    await writeFile(join(f.project, 'src/nested/.env'), 'PRIVATE_VALUE=fixture')
    expect(await f.run('delete_directory', { path: 'src/nested', recursive: true })).toHaveProperty('error')
    expect(await readFile(join(f.project, 'src/nested/new.ts'), 'utf8')).toBe('external')
  })
  it('preserves BOM, CRLF and executable modes during targeted edits and file moves', async () => {
    const f = await fixture(), text = '\ufeffexport const x = 1;\r\n// unchanged\r\n'
    await writeFile(join(f.project, 'src/bom.ts'), text); await chmod(join(f.project, 'src/bom.ts'), 0o755)
    const before = await f.read('src/bom.ts')
    expect(await f.run('edit_file', { path: 'src/bom.ts', expected_version: before.version, old_text: 'x = 1', new_text: 'x = 2' })).toMatchObject({ ok: true })
    expect(await readFile(join(f.project, 'src/bom.ts'), 'utf8')).toBe(text.replace('x = 1', 'x = 2'))
    const current = await f.read('src/bom.ts')
    expect(await f.run('move_file', { path: 'src/bom.ts', destination: 'src/moved.ts', expected_version: current.version })).toMatchObject({ ok: true })
    expect((await stat(join(f.project, 'src/moved.ts'))).mode & 0o777).toBe(0o755)
  })
  it('reports unavailable native syntax and broken references without executing a plan', async () => {
    const f = await fixture()
    await writeFile(join(f.project, '.claude/commands/native.md'), '---\ncontext: fork\n---\nDo provider-only work.')
    await writeFile(join(f.project, '.claude/commands/broken.md'), 'Read [required](absent.md).')
    await expect(f.commands.invocation(f.session, '/native')).rejects.toThrow('native')
    const broken = (await f.commands.list(f.session)).commands.find(c => c.name === '/broken')!
    await expect(f.run('plan_project_workflow', { command_id: broken.id, summary: 'Missing dependency', steps: [{ title: 'Create', tool: 'create_file', input: { path: 'bad.ts', content: 'x' } }] })).rejects.toThrow('missing')
    expect(f.approve).not.toHaveBeenCalled()
  })
})

// Explicitly opt in: loads the installed adapter but writes only to a disposable
// fixture. It does not launch Athena, access the user's project, or edit registry.
describe('bounded direct MLX file operations', () => {
  const utility = 'export function sum(a: number, b: number): number {\n  return a + b;\n}\n// unrelated comment\n'
  async function setup() {
    const f = await fixture()
    const execute = vi.fn(f.tools.execute.bind(f.tools)), tools = { ...f.tools, execute }
    const call = vi.fn(async (_path: string, _body: any, _signal: AbortSignal): Promise<Response> => { throw Error('Unexpected model request') })
    const provider = new MLXProvider({ call } as unknown as OllamaService, 'mlx:fixture', { ...defaultSettings.localAI, contextLength: 32768 }, { name: 'mlx:fixture', provider: 'mlx', capabilities: ['completion'], size: 1, contextLength: 32768 })
    const run = async (content: string, signal?: AbortSignal) => {
      tools.invalidate?.(); let answer = ''
      for await (const event of provider.streamMessage([{ id: randomUUID(), role: 'user', content, createdAt: 1, status: 'complete' }], { signal, context: { authorizedProject: true, projectTools: tools, attachments: [], sources: [], repositoryText: '' } })) if (event.type === 'text') answer += event.text
      return answer
    }
    const proposal = (name: string, args: unknown) => new Response(JSON.stringify({ message: { tool_calls: [{ function: { name, arguments: args } }] }, done: true, done_reason: 'stop' }) + '\n')
    return { ...f, execute, call, run, proposal }
  }
  it('creates valid TypeScript, reports exact saved content, and reads only target/scoped guidance', async () => {
    const f = await setup()
    const result = await f.run('Create src/sum.ts and show its contents:\n```ts\n' + utility.trimEnd() + '\n```')
    expect(result).toContain('completed'); expect(result).toContain('syntax parser'); expect(result).toContain(utility.trimEnd())
    expect(await readFile(join(f.project, 'src/sum.ts'), 'utf8')).toBe(utility)
    expect(f.approve).toHaveBeenCalledTimes(1); expect(f.call).not.toHaveBeenCalled()
    expect(f.execute.mock.calls.map(([name]) => name)).toEqual(['get_file_metadata', 'inspect_project_instructions', 'create_file', 'read_file'])
    const readResult = await f.run('Read src/sum.ts')
    expect(readResult).toContain(utility.trimEnd()); expect(f.execute.mock.calls.at(-1)?.[0]).toBe('read_file')
    expect(f.execute.mock.calls.filter(([name]) => name === 'read_file').every(([, args]) => (args as any).path === 'src/sum.ts')).toBe(true)
  })
  it('uses the same direct CRUD and approval path for Ollama without Academy leakage', async () => {
    const f = await fixture()
    const execute = vi.fn(f.tools.execute.bind(f.tools)), tools = { ...f.tools, execute }
    const call = vi.fn(async (_path: string, _body: any, _signal: AbortSignal): Promise<Response> => { throw Error('Unexpected model request') })
    const provider = new OllamaProvider({ call } as unknown as OllamaService, 'qwen2.5-coder:3b', { ...defaultSettings.localAI, contextLength: 32768 }, { name: 'qwen2.5-coder:3b', provider: 'ollama', capabilities: ['completion', 'tools'], size: 1, contextLength: 32768 }, 'RAW ACADEMY EXCERPT MUST NOT BE SENT')
    const run = async (content: string) => {
      tools.invalidate?.(); let answer = ''
      for await (const event of provider.streamMessage([{ id: randomUUID(), role: 'user', content, createdAt: 1, status: 'complete' }], { context: { authorizedProject: true, projectName: 'fixture', projectTools: tools, attachments: [], sources: [], repositoryText: 'RAW RETRIEVED ACADEMY EXCERPT' } })) if (event.type === 'text') answer += event.text
      return answer
    }
    const explicit = await run('Create src/athena-test.ts:\n```ts\nexport function answer(): number { return 42; }\n```')
    expect(explicit).toContain('Create `src/athena-test.ts` — completed')
    expect(await readFile(join(f.project, 'src/athena-test.ts'), 'utf8')).toBe('export function answer(): number { return 42; }\n')
    expect(call).not.toHaveBeenCalled()
    expect(f.approve).toHaveBeenCalledTimes(1)
    call.mockResolvedValueOnce(new Response(JSON.stringify({ message: { tool_calls: [{ function: { name: 'propose_file_content', arguments: { content: 'export const generated: number = 7;\n' } } }] }, done: true, done_reason: 'stop' }) + '\n'))
    const generated = await run('Create src/generated.ts with one typed exported constant.')
    expect(generated).toContain('completed'); expect(call).toHaveBeenCalledTimes(1)
    expect(await readFile(join(f.project, 'src/generated.ts'), 'utf8')).toBe('export const generated: number = 7;\n')
    call.mockResolvedValueOnce(new Response(JSON.stringify({ message: { tool_calls: [{ function: { name: 'propose_targeted_edit', arguments: { old_text: 'generated: number = 7', new_text: 'generated: number = 8' } } }] }, done: true, done_reason: 'stop' }) + '\n'))
    const updated = await run('Update src/generated.ts to change the value from 7 to 8.')
    expect(updated).toContain('completed'); expect(call).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(call.mock.calls[1][1])).not.toContain('RAW RETRIEVED ACADEMY EXCERPT')
    expect(JSON.stringify(call.mock.calls[1][1])).not.toContain('RAW ACADEMY EXCERPT')
    expect(await readFile(join(f.project, 'src/generated.ts'), 'utf8')).toBe('export const generated: number = 8;\n')
    execute.mockClear(); f.approve.mockClear()
    const deleted = await run('Delete src/athena-test.ts')
    expect(deleted).toContain('target no longer exists')
    await expect(stat(join(f.project, 'src/athena-test.ts'))).rejects.toThrow()
    expect(execute.mock.calls.map(([name, args]) => [name, (args as any).path])).toEqual([['read_file', 'src/athena-test.ts'], ['delete_file', 'src/athena-test.ts']])
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('uses one bounded model proposal for generation and rejects invalid syntax before approval', async () => {
    const f = await setup()
    f.call.mockResolvedValueOnce(f.proposal('propose_file_content', { content: 'export function sum(a: number): number => a;' }))
      .mockResolvedValueOnce(f.proposal('propose_file_content', { content: utility }))
    const result = await f.run('Create src/sum.ts with a typed sum function and show its contents.')
    expect(result).toContain('completed'); expect(f.call).toHaveBeenCalledTimes(2)
    expect(f.approve).toHaveBeenCalledTimes(1)
    expect(await readFile(join(f.project, 'src/sum.ts'), 'utf8')).toBe(utility)
    expect(f.stageChanges.mock.calls[0][1][0].diff).toContain('return a + b;')
  })
  it('fails invalid explicit code and self-imports without approval or writing', async () => {
    const f = await setup()
    for (const content of ['export function sum(a: number): number => a;', 'import { sum } from "./sum";\nexport { sum };']) {
      const result = await f.run('Create src/sum.ts:\n```ts\n' + content + '\n```')
      expect(result).toContain('failed'); expect(result).toContain('before approval')
      await expect(stat(join(f.project, 'src/sum.ts'))).rejects.toThrow()
    }
    expect(f.approve).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled()
    const invalid = JSON.parse(await f.tools.execute('create_file', { path: 'src/broken.ts', content: 'export function broken( {' }, f.signal))
    expect(invalid.error).toContain('Source validation failed'); expect(f.approve).not.toHaveBeenCalled()
  })
  it('applies a unique targeted function edit and preserves unrelated bytes', async () => {
    const f = await setup(); await writeFile(join(f.project, 'src/sum.ts'), utility)
    f.call.mockResolvedValueOnce(f.proposal('propose_targeted_edit', { old_text: 'return a + b;', new_text: 'return a + b + 1;' }))
    const result = await f.run('Update src/sum.ts to add 1 to the result and show the diff.')
    expect(result).toContain('completed'); expect(result).toContain('+  return a + b + 1;')
    expect(await readFile(join(f.project, 'src/sum.ts'), 'utf8')).toBe(utility.replace('a + b;', 'a + b + 1;'))
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls.map(([name]) => name)).toEqual(['read_file', 'inspect_project_instructions', 'edit_file', 'read_file'])
  })
  it('performs an explicit literal replacement without generation and rejects unsolicited examples', async () => {
    const f = await setup(); await writeFile(join(f.project, 'src/sum.ts'), utility)
    const result = await f.run('Update src/sum.ts to replace the unique expression a + b with a + b + 1. Preserve the rest of the file and show the diff.')
    expect(result).toContain('completed'); expect(f.call).not.toHaveBeenCalled()
    expect(await readFile(join(f.project, 'src/sum.ts'), 'utf8')).toBe(utility.replace('a + b;', 'a + b + 1;'))
    f.call.mockImplementation(async () => f.proposal('propose_file_content', { content: utility + '// Example usage:\n// sum(1, 2)\n' }))
    expect(await f.run('Create src/add.ts with a typed sum function.')).toContain('unsolicited usage example')
    expect(f.call).toHaveBeenCalledTimes(2)
    await expect(stat(join(f.project, 'src/add.ts'))).rejects.toThrow()
  })
  it('renames and deletes only the target, confirms deletion, then finishes without inference', async () => {
    const f = await setup(); await writeFile(join(f.project, 'src/sum.ts'), utility)
    expect(await f.run('Rename src/sum.ts to src/total.ts')).toContain('previous path no longer exists')
    await expect(stat(join(f.project, 'src/sum.ts'))).rejects.toThrow()
    expect(await readFile(join(f.project, 'src/total.ts'), 'utf8')).toBe(utility)
    f.execute.mockClear(); f.approve.mockClear()
    let allow!: (value: boolean) => void
    f.approve.mockImplementationOnce(async () => new Promise(resolve => { allow = resolve }))
    const task = f.run('Delete src/total.ts')
    await vi.waitFor(() => expect(f.approve).toHaveBeenCalledTimes(1))
    expect(await readFile(join(f.project, 'src/total.ts'), 'utf8')).toBe(utility)
    allow(true)
    expect(await task).toContain('target no longer exists')
    await expect(stat(join(f.project, 'src/total.ts'))).rejects.toThrow()
    expect(await readFile(join(f.project, 'src/nested/keep.ts'), 'utf8')).toContain('keep = true')
    expect(f.execute.mock.calls.map(([name, args]) => [name, (args as any).path])).toEqual([['read_file', 'src/total.ts'], ['delete_file', 'src/total.ts']])
    expect(f.call).not.toHaveBeenCalled()
  })
  it('rejects outside/symlink targets and preserves a file after declined deletion', async () => {
    const f = await setup(); await symlink(f.root, join(f.project, 'escape'))
    expect(await f.run('Delete ../outside.ts')).toContain('failed')
    expect(await f.run('Delete /tmp/outside.ts')).toContain('failed')
    expect(f.execute).not.toHaveBeenCalled()
    expect(await f.run('Delete escape/outside.ts')).toContain('failed')
    f.approve.mockResolvedValue(false)
    expect(await f.run('Delete src/nested/keep.ts')).toContain('cancelled')
    expect(await readFile(join(f.project, 'src/nested/keep.ts'), 'utf8')).toContain('keep = true')
  })
  it('cancels blocked generation immediately and dispatches no mutation afterward', async () => {
    const f = await setup(), abort = new AbortController()
    f.call.mockImplementationOnce(async (_path, _body, signal) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }) }))
    const task = f.run('Create src/sum.ts with a typed sum function.', abort.signal)
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce())
    abort.abort()
    expect(await task).toContain('cancelled')
    expect(f.approve).not.toHaveBeenCalled(); await expect(stat(join(f.project, 'src/sum.ts'))).rejects.toThrow()
    expect(f.execute.mock.calls.some(([name]) => name === 'create_file')).toBe(false)
  })
  it('cancels pending approval and retains verified work if stopped after a commit', async () => {
    const f = await setup(), abort = new AbortController()
    f.approve.mockImplementationOnce(async (_request, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })))
    const deleting = f.run('Delete src/nested/keep.ts', abort.signal)
    await vi.waitFor(() => expect(f.approve).toHaveBeenCalledOnce()); abort.abort()
    expect(await deleting).toContain('cancelled'); expect(await stat(join(f.project, 'src/nested/keep.ts'))).toBeTruthy()
    const afterCommit = new AbortController(), execute = f.tools.execute.bind(f.tools)
    f.execute.mockImplementation(async (name, args, signal) => { const result = await execute(name, args, signal); if (name === 'create_file') afterCommit.abort(); return result })
    const result = await f.run('Create src/sum.ts:\n```ts\n' + utility.trimEnd() + '\n```', afterCommit.signal)
    expect(result).toContain('partially completed'); expect(result).toContain('src/sum.ts (saved)')
    expect(await readFile(join(f.project, 'src/sum.ts'), 'utf8')).toBe(utility)
  })
  it('terminates repeated model reads with only one actual filesystem read', async () => {
    const f = await setup()
    f.call.mockImplementation(async () => f.proposal('read_file', { path: 'src/nested/keep.ts', start_line: 1, end_line: 10 }))
    await expect(f.run('Implement the requested project changes using relevant context.')).rejects.toThrow('Repeated identical')
    expect(f.call).toHaveBeenCalledTimes(3)
    expect(f.execute.mock.calls.filter(([name]) => name === 'read_file')).toHaveLength(1)
  })
  it('canonicalizes arguments and never replays a failed mutation', async () => {
    const f = await setup(), guarded = guardMLXTools(f.tools)
    await guarded.execute('delete_file', { path: 'src/nested/keep.ts', expected_version: 'a'.repeat(64) }, f.signal)
    await expect(guarded.execute('delete_file', { expected_version: 'a'.repeat(64), path: 'src/nested/keep.ts' }, f.signal)).rejects.toThrow('Repeated identical')
    expect(f.approve).not.toHaveBeenCalled()
  })
  it('does not load root instructions or Academy retrieval while preparing a direct delete', async () => {
    const f = await fixture(), instructions = vi.spyOn(f.intelligence, 'instructions'), reads = vi.spyOn(f.workspaces, 'readRange')
    const knowledge = vi.fn(async () => ({ text: '', sources: [] }))
    const chat = { ...f.chat, current: () => f.session, activeExecution: () => undefined } as unknown as ChatController
    const context = new ChatContextService(chat, {} as AttachmentService, f.workspaces, { files: async () => [], folder: async () => undefined }, () => true, f.agent,
      undefined, undefined, undefined, () => ({ active: true, tools: true, vision: false, contextCharacters: 20000 }), undefined,
      () => ({ ...defaultSettings, aiMode: 'local', strictOffline: true }), undefined, knowledge)
    context.setProjectIntelligence(f.intelligence, async () => { throw Error('No indexing requested') })
    await context.prepare(f.session, [{ id: 'delete', role: 'user', content: 'Delete src/nested/keep.ts', status: 'complete', createdAt: 1 }], f.signal)
    expect(instructions).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(knowledge).not.toHaveBeenCalled()
  })
  it('builds the same scoped project surface for a non-MLX local model', async () => {
    const f = await fixture(); f.session.config.model = 'qwen2.5-coder:3b'
    const chat = { ...f.chat, current: () => f.session, activeExecution: () => undefined } as unknown as ChatController
    const context = new ChatContextService(chat, {} as AttachmentService, f.workspaces, { files: async () => [], folder: async () => undefined }, () => true, f.agent,
      undefined, undefined, undefined, () => ({ active: true, tools: true, vision: false, contextCharacters: 20_000 }), undefined,
      () => ({ ...defaultSettings, aiMode: 'local', strictOffline: true, automationPermissions: { ...defaultSettings.automationPermissions, fileReading: true, fileModification: true, terminalExecution: true, destructiveOperations: true } }))
    const prepared = await context.prepare(f.session, [{ id: 'inspect', role: 'user', content: 'Inspect the project files.', status: 'complete', createdAt: 1 }], f.signal)
    expect(prepared.projectName).toBe(f.workspace.name)
    expect(prepared.projectTools?.definitions.map(tool => tool.name)).toContain('read_file')
    expect(prepared.projectTools?.policy).toContain('Local project coding')
    const result = JSON.parse(await prepared.projectTools!.execute('read_file', { path: 'src/nested/keep.ts', start_line: 1, end_line: 5 }, f.signal))
    expect(result.content).toContain('keep = true')
  })
  it('makes Ollama project requests use a real tool before completing', async () => {
    const f = await fixture(), base = f.agent.create(f.chat, f.session.id, f.workspace.id, f.workspace.name, 'ask', [], () => true, contextDefaults(), undefined, 'project-only', true)
    let calls = 0
    const service = { call: vi.fn(async (_path: string, body: any) => {
      calls++
      if (calls === 1) return new Response(JSON.stringify({ message: { content: 'I will inspect the project now.' }, done: true, done_reason: 'stop' }) + '\n')
      if (calls === 2) return new Response(JSON.stringify({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'src/nested/keep.ts', start_line: 1, end_line: 5 } } }] }, done: true, done_reason: 'stop' }) + '\n')
      expect(body.messages.some((entry: any) => entry.role === 'tool')).toBe(true)
      return new Response(JSON.stringify({ message: { content: 'Verified src/nested/keep.ts from the authorized project.' }, done: true, done_reason: 'stop' }) + '\n')
    }) }
    const provider = new OllamaProvider(service as unknown as OllamaService, 'qwen2.5-coder:3b', { ...defaultSettings.localAI, contextLength: 32768 }, { name: 'qwen2.5-coder:3b', provider: 'ollama', capabilities: ['completion', 'tools'], size: 1, contextLength: 32768 })
    let answer = ''
    for await (const event of provider.streamMessage([{ id: randomUUID(), role: 'user', content: 'Inspect the project files and report what is in src/nested/keep.ts.', createdAt: 1, status: 'complete' }], { context: { authorizedProject: true, projectName: f.workspace.name, projectTools: base, attachments: [], sources: [], repositoryText: '' } })) if (event.type === 'text') answer += event.text
    expect(calls).toBe(3); expect(base.execute).toBeDefined(); expect(answer).toContain('Verified src/nested/keep.ts')
  })
  it('executes a Qwen tool call left in message content', async () => {
    const f = await fixture(), base = f.agent.create(f.chat, f.session.id, f.workspace.id, f.workspace.name, 'ask', [], () => true, contextDefaults(), undefined, 'project-only', true)
    let calls = 0
    const tool = { name: 'read_file', arguments: { path: 'src/nested/keep.ts', start_line: 1, end_line: 5 } }
    const service = { call: vi.fn(async (_path: string, body: any) => {
      calls++
      if (calls === 1) return new Response(JSON.stringify({ message: { content: `<tool_call>\n${JSON.stringify(tool)}\n</tool_call>` }, done: true, done_reason: 'stop' }) + '\n')
      expect(body.messages.some((entry: any) => entry.role === 'tool' && String(entry.content).includes('keep = true'))).toBe(true)
      expect(body.messages.some((entry: any) => entry.role === 'assistant' && entry.content === '' && entry.tool_calls?.[0]?.function?.name === 'read_file')).toBe(true)
      return new Response(JSON.stringify({ message: { content: 'Verified src/nested/keep.ts from the authorized project.' }, done: true, done_reason: 'stop' }) + '\n')
    }) }
    const provider = new OllamaProvider(service as unknown as OllamaService, 'qwen2.5-coder:3b', { ...defaultSettings.localAI, contextLength: 32768 }, { name: 'qwen2.5-coder:3b', provider: 'ollama', capabilities: ['completion', 'tools'], size: 1, contextLength: 32768 })
    let answer = ''
    for await (const event of provider.streamMessage([{ id: randomUUID(), role: 'user', content: 'Inspect the project files and report what is in src/nested/keep.ts.', createdAt: 1, status: 'complete' }], { context: { authorizedProject: true, projectName: f.workspace.name, projectTools: base, attachments: [], sources: [], repositoryText: '' } })) if (event.type === 'text') answer += event.text
    expect(calls).toBe(2)
    expect(answer).toBe('Verified src/nested/keep.ts from the authorized project.')
  })
  it('still rejects a project description that never selects a tool', async () => {
    const f = await fixture(), base = f.agent.create(f.chat, f.session.id, f.workspace.id, f.workspace.name, 'ask', [], () => true, contextDefaults(), undefined, 'project-only', true)
    const service = { call: vi.fn(async () => new Response(JSON.stringify({ message: { content: 'I will inspect the project and describe the files.' }, done: true, done_reason: 'stop' }) + '\n')) }
    const provider = new OllamaProvider(service as unknown as OllamaService, 'qwen2.5-coder:3b', { ...defaultSettings.localAI, contextLength: 32768 }, { name: 'qwen2.5-coder:3b', provider: 'ollama', capabilities: ['completion', 'tools'], size: 1, contextLength: 32768 })
    const run = provider.streamMessage([{ id: randomUUID(), role: 'user', content: 'Inspect the project files and report what is in src/nested/keep.ts.', createdAt: 1, status: 'complete' }], { context: { authorizedProject: true, projectName: f.workspace.name, projectTools: base, attachments: [], sources: [], repositoryText: '' } })
    await expect((async () => { for await (const _event of run) { /* consume */ } })()).rejects.toThrow('did not issue a valid tool call')
    expect(service.call).toHaveBeenCalledTimes(2)
  })
  it('rebuilds local project context when the authorized project changes', async () => {
    const f = await fixture(), secondRoot = await realpath(await mkdtemp(join(tmpdir(), 'athena-local-project-'))); roots.push(secondRoot)
    const secondProject = join(secondRoot, 'second'); await mkdir(join(secondProject, 'src'), { recursive: true }); await writeFile(join(secondProject, 'src/only.ts'), 'export const only = true;\n')
    const second = await f.workspaces.connect(secondProject); f.session.workspaces = [second]; f.session.config.model = 'future-local:1b'
    const chat = { ...f.chat, current: () => f.session, activeExecution: () => undefined } as unknown as ChatController
    const context = new ChatContextService(chat, {} as AttachmentService, f.workspaces, { files: async () => [], folder: async () => undefined }, () => true, f.agent,
      undefined, undefined, undefined, () => ({ active: true, tools: true, vision: false, contextCharacters: 20_000 }), undefined,
      () => ({ ...defaultSettings, aiMode: 'local', strictOffline: true, automationPermissions: { ...defaultSettings.automationPermissions, fileReading: true, fileModification: true, terminalExecution: true, destructiveOperations: true } }))
    const prepared = await context.prepare(f.session, [{ id: 'switch', role: 'user', content: 'Read src/only.ts.', status: 'complete', createdAt: 1 }], f.signal)
    expect(prepared.projectName).toBe(second.name)
    const result = JSON.parse(await prepared.projectTools!.execute('read_file', { path: 'src/only.ts', start_line: 1, end_line: 5 }, f.signal))
    expect(result.content).toContain('only = true'); expect(result.content).not.toContain('keep = true')
  })
  it('rejects stale versions after approval and never overwrites an external edit', async () => {
    const f = await setup(); await writeFile(join(f.project, 'src/sum.ts'), utility)
    f.approve.mockImplementationOnce(async () => { await writeFile(join(f.project, 'src/sum.ts'), '// external work\n'); return true })
    expect(await f.run('Update src/sum.ts to replace `a + b` with `a + b + 1`.')).toContain('changed while awaiting approval')
    expect(await readFile(join(f.project, 'src/sum.ts'), 'utf8')).toBe('// external work\n')
    expect(f.call).not.toHaveBeenCalled()
  })
  it('stops varied unsuccessful tool actions at the configured no-progress limit', async () => {
    const f = await setup(); let attempt = 0
    f.call.mockImplementation(async () => f.proposal('read_file', { path: `src/missing-${++attempt}.ts`, start_line: 1, end_line: 10 }))
    await expect(f.run('Implement the requested project changes using relevant context.')).rejects.toThrow('repeated unsuccessful')
    expect(f.call).toHaveBeenCalledTimes(contextDefaults().noProgressWindow)
  })
  it('bounds reads, labels truncation, and avoids a rescan for a large file', async () => {
    const f = await setup(); await writeFile(join(f.project, 'src/large.ts'), Array.from({ length: 800 }, (_, i) => `export const value${i} = ${i};`).join('\n'))
    const result = await f.run('Read src/large.ts lines 500 to 510')
    expect(result).toContain('value499'); expect(result).toContain('value509'); expect(result).toContain('Only the displayed range')
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.call).not.toHaveBeenCalled()
  })
  it.each(['Delete src/sum.ts if unused', 'Do not delete src/sum.ts', 'Explain how to delete src/sum.ts', 'Delete src/sum.ts and src/other.ts', 'Rename src/sum.ts to src/other.ts and delete README.md', 'Create src/sum.ts and run tests', 'Update src/sum.ts if safe to replace `a` with `b`.'])('keeps ambiguous or compound request out of the direct path: %s', request => {
    expect(directFileRequest(request)).toBeUndefined()
  })
  it.each(['Create a TypeScript file named src/typed.ts.', 'Create a simple file called src/simple.ts.'])('recognizes explicit named single-file requests: %s', request => {
    expect(directFileRequest(request)).toMatchObject({ operation: 'create' })
  })
})

it.skipIf(process.env.ATHENA_MLX_CRUD_LIVE !== '1')('native MLX adapter executes approved CRUD and a fixture command', async () => {
  const f = await fixture()
  const mlx = new MLXInference(join(homedir(), 'Library/Application Support/Athena/athena-local/mlx-inference'))
  const model = mlx.metadata('mlx:athena-coder-v2')
  const service = new OllamaService(() => 'http://127.0.0.1:11434', vi.fn()); service.mlx = mlx
  const provider = new MLXProvider(service, model.name, { ...defaultSettings.localAI, contextLength: 32768, maxOutputTokens: 1536, temperature: 0 }, model)
  const request = async (content: string, command?: Awaited<ReturnType<typeof f.commands.invocation>>) => {
    let answer = ''
    f.tools.invalidate?.()
    for await (const event of provider.streamMessage([{ id: randomUUID(), role: 'user', content, command, createdAt: 1, status: 'complete' }], { signal: AbortSignal.timeout(120000), context: { authorizedProject: true, projectName: 'disposable fixture', projectTools: f.tools, attachments: [], sources: [], repositoryText: '' } })) if (event.type === 'text') answer += event.text
    console.log('Native fixture request:', content.slice(0, 100), 'Answer:', answer.slice(0, 800))
    return answer
  }
  await request('Create src/add.ts with an exported TypeScript add function taking two numbers a and b and returning their sum. Show the actual saved contents.')
  expect(await readFile(join(f.project, 'src/add.ts'), 'utf8')).toContain('a + b')
  expect(f.approve).toHaveBeenCalled()
  expect(f.activity.mock.calls.some(([name]) => name === 'create_file')).toBe(true)
  expect(f.activity.mock.calls.some(([name]) => name === 'read_file')).toBe(true)
  await request('Update src/add.ts to replace the unique expression a + b with a + b + 1. Preserve the rest of the file and show the diff.')
  expect(await readFile(join(f.project, 'src/add.ts'), 'utf8')).toContain('a + b + 1')
  await request('Rename src/add.ts to src/sum.ts')
  expect(await readFile(join(f.project, 'src/sum.ts'), 'utf8')).toContain('a + b + 1')
  await expect(stat(join(f.project, 'src/add.ts'))).rejects.toThrow()
  const approvalsBefore = f.approve.mock.calls.length
  await request('Delete src/sum.ts')
  expect(f.approve.mock.calls.length).toBeGreaterThan(approvalsBefore)
  await expect(stat(join(f.project, 'src/sum.ts'))).rejects.toThrow()
  const command = (await f.commands.invocation(f.session, '/platform-spec fixture'))!
  const prompt = await f.commands.resolve(f.session, command, '/platform-spec fixture', f.signal)
  await request(prompt, command)
  expect(await readFile(join(f.project, 'src/artifact.ts'), 'utf8')).toContain('artifact = true')
  expect(f.activity.mock.calls.filter(([name]) => name === 'create_file').length).toBeGreaterThanOrEqual(2)
}, 600000)

it.skipIf(process.env.ATHENA_SANDBOX_TEST !== '1')('runs approved terminal verification and blocks source writes and outside reads', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'outside.md'), 'outside fixture data')
  const result = await f.run('execute_command', { executable: 'node', args: ['-e', 'console.log("fixture verified")'], network: false, install_dependencies: false })
  expect(result.exitCode).toBe(0); expect(result.output).toContain('fixture verified')
  expect(f.approve).toHaveBeenCalled()
  const rejected = await f.run('execute_command', { executable: 'node', args: ['-e', 'require("fs").writeFileSync("src/unauthorized.ts", "bad")'], network: false, install_dependencies: false })
  expect(rejected.exitCode).not.toBe(0)
  await expect(stat(join(f.project, 'src/unauthorized.ts'))).rejects.toThrow()
  const read = await f.run('execute_command', { executable: 'node', args: ['-e', 'console.log(require("fs").readFileSync("../outside.md", "utf8"))'], network: false, install_dependencies: false })
  expect(read.exitCode).not.toBe(0); expect(read.output).not.toContain('outside fixture data')
})
