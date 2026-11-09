// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { SlashCommandService } from '../electron/main/ai/slashCommandService'
import { ProjectIntelligence, type ProjectIndexScope } from '../electron/main/ai/projectIntelligence'
import { ProjectAcademyRunner, createProjectAcademyFixture } from '../electron/main/ai/projectAcademy'
import { newConversation } from '../electron/main/ai/conversationRepository'
import { AgentTools } from '../electron/main/ai/agentTools'
import { projectWorkflowTools } from '../electron/main/ai/projectWorkflow'
import { AcademyService } from '../electron/main/ai/academyService'
import { academyCourses, courseStages } from '../shared/academyCourses'
import { contextDefaults } from '../shared/context'
import type { LocalModel } from '../shared/localAI'
import { OllamaService } from '../electron/main/ai/ollamaService'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const paths: string[] = []
const services: ProjectIntelligence[] = []
const signal = () => new AbortController().signal
const scope: ProjectIndexScope = { model: 'local:3b', digest: 'local-v1', embeddingModel: 'embed:latest', embeddingDigest: 'embed-v1' }
const model: LocalModel = { name: scope.model, digest: scope.digest, size: 1, capabilities: ['completion'] }
const embedding: LocalModel = { name: scope.embeddingModel, digest: scope.embeddingDigest, size: 1, capabilities: ['embedding'] }
afterEach(async () => { vi.restoreAllMocks(); services.splice(0).forEach(service => service.dispose()); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'athena-intelligence-test-'))); paths.push(directory)
  const root = join(directory, 'project'), storage = join(directory, 'private'); await mkdir(root); await mkdir(storage)
  await createProjectAcademyFixture(root, 'test')
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root)
  const session = newConversation(); session.workspaces = [workspace]; session.config.model = scope.model; session.config.agentMode = 'ask'; session.config.contextSettings = contextDefaults()
  const commands = new SlashCommandService(workspaces, storage, () => true)
  const call = vi.fn(async (endpoint: string, body?: unknown) => new Response(JSON.stringify(endpoint === 'api/tags' ? { models: [{ name: embedding.name, digest: embedding.digest }] } : { embeddings: (body as { input: string[] }).input.map(text => [text.includes('inventory') ? 1 : 0.1, 1]) })))
  const intelligence = new ProjectIntelligence(workspaces, commands, storage, { call })
  services.push(intelligence)
  const approvals: unknown[] = []
  let consent = true
  const chat: Parameters<AgentTools['create']>[0] = {
    getSession: () => session, approve: async request => { approvals.push(request); return consent }, beforeAction: async () => {}, activity: () => crypto.randomUUID(), finishActivity: () => {}, stageChanges: () => {}, updateActivityOutput: () => {}, updateActivityLabel: () => {}, changeReverted: () => {},
  }
  const agent = new AgentTools(workspaces, storage, () => true)
  const tools = agent.create(chat, session.id, workspace.id, workspace.name, 'ask', [], () => true)
  return { directory, root, storage, workspaces, workspace, session, commands, call, intelligence, agent, tools, approvals, decline: () => { consent = false } }
}

describe('project intelligence and permissions', () => {
  it('indexes sources incrementally with citations, excludes credentials/dependencies and isolates model/project/digest', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'leaked.txt'), 'api_key = "sk-abcdefghijklmnopqrstuvwxyz123456789"')
    await symlink(join(f.directory, 'outside.txt'), join(f.root, 'escape.txt'))
    await writeFile(join(f.directory, 'outside.txt'), 'outside-content')
    const first = await f.intelligence.index(f.workspace.id, scope, signal())
    expect(first.complete).toBe(true)
    expect(first.changed).toBeGreaterThan(10)
    f.call.mockClear()
    const second = await f.intelligence.index(f.workspace.id, scope, signal())
    expect(second.changed).toBe(0); expect(second.indexedFiles).toBe(first.indexedFiles); expect(f.call).not.toHaveBeenCalled()
    const found = await f.intelligence.search(f.workspace.id, scope, 'inventory', signal())
    expect(found.hits.some(h => h.path === 'docs/architecture.md')).toBe(true)
    expect(found.hits.every(h => !/\.env|node_modules|leaked|escape/.test(h.path))).toBe(true)
    expect((await f.intelligence.search(f.workspace.id, { ...scope, digest: 'v2' }, 'inventory', signal())).hits).toEqual([])
    expect((await f.intelligence.search(f.workspace.id, { ...scope, embeddingDigest: 'v2' }, 'inventory', signal())).hits).toEqual([])
    expect((await f.intelligence.search(f.workspace.id, { ...scope, model: 'other:3b' }, 'inventory', signal())).hits).toEqual([])
    const other = join(f.directory, 'other'); await mkdir(other); const otherRef = await f.workspaces.connect(other)
    expect((await f.intelligence.search(otherRef.id, scope, 'inventory', signal())).hits).toEqual([])
    const restarted = new ProjectIntelligence(f.workspaces, f.commands, f.storage, { call: f.call })
    services.push(restarted)
    expect((await restarted.search(f.workspace.id, scope, 'inventory', signal())).hits).toEqual(found.hits)
    await writeFile(join(f.root, 'docs/architecture.md'), 'Changed architecture with a new API endpoint.')
    expect((await restarted.search(f.workspace.id, scope, 'inventory', signal())).stalePaths).toContain('docs/architecture.md')
    f.call.mockClear()
    const refreshed = await restarted.index(f.workspace.id, scope, signal(), ['docs/architecture.md'])
    expect(refreshed.changed).toBe(1); expect(f.call).toHaveBeenCalledTimes(1)
    await rm(join(f.root, 'docs/architecture.md'))
    await restarted.index(f.workspace.id, scope, signal(), ['docs/architecture.md'])
    expect((await restarted.search(f.workspace.id, scope, 'inventory', signal())).hits.every(h => h.path !== 'docs/architecture.md')).toBe(true)
    f.workspaces.disconnect(f.workspace.id)
    await expect(restarted.search(f.workspace.id, scope, 'inventory', signal())).rejects.toThrow('access is unavailable')
    await f.agent.dispose()
  })
  it('discovers ignored agent definitions, preserves hashes and checks full references without executing scripts', async () => {
    const f = await fixture(), catalog = await f.commands.list(f.session)
    expect(catalog.commands.map(c => c.name)).toEqual(expect.arrayContaining(['/platform-spec', '/platform-dev', '/skill:validate', '/spec']))
    const command = catalog.commands.find(c => c.name === '/platform-spec')!
    expect(command).toMatchObject({ provider: 'claude', kind: 'command', compatibility: 'athena-tools' })
    expect(command.contentHash).toMatch(/^[a-f0-9]{64}$/)
    const preview = await f.commands.inspect(f.session, command.id, '', signal())
    expect(preview.content).toContain('Create notes/spec.md')
    expect(preview.references).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'docs/architecture.md' }), expect.objectContaining({ path: '.claude/skills/spec/SKILL.md' })]))
    const validate = catalog.commands.find(c => c.name === '/skill:validate')!
    expect((await f.commands.inspect(f.session, validate.id, '', signal())).content).toContain('Report its actual exit code')
    await expect(readFile(join(f.root, 'notes/spec.md'))).rejects.toThrow()
    const native = catalog.commands.find(c => c.name === '/native-only')!
    expect((await f.commands.inspect(f.session, native.id, '', signal())).executable).toBe(false)
    await expect(f.commands.resolve(f.session, { ...native, arguments: '' }, '/native-only', signal())).rejects.toThrow('native provider')
    await writeFile(join(f.root, '.claude/commands/platform-spec.md'), 'Read [missing](../../docs/missing.md).')
    const changed = await f.commands.inspect(f.session, command.id, '', signal())
    expect(changed.definition.contentHash).not.toBe(command.contentHash)
    expect(changed.references?.[0].status).toContain('missing')
    await expect(f.commands.inspect(f.session, 'unknown', '', signal())).rejects.toThrow('Unknown')
    const instructions = await f.intelligence.instructions(f.workspace.id, 'src/ui/App.tsx', signal())
    expect(instructions.instructions.map(i => i.path)).toEqual(['AGENTS.md', 'CLAUDE.md', 'src/ui/AGENTS.md'])
    expect(instructions.instructions.at(-1)?.content).toContain('British')
    await writeFile(join(f.root, 'src/ui/AGENTS.override.md'), 'Override for UI')
    expect((await f.intelligence.instructions(f.workspace.id, 'src/ui/App.tsx', signal())).instructions.map(i => i.path)).not.toContain('src/ui/AGENTS.md')
    await expect(f.workspaces.readRange(f.workspace.id, '.env', 1, 10)).rejects.toThrow()
    await expect(f.workspaces.readRange(f.workspace.id, '../outside.txt', 1, 10)).rejects.toThrow()
    await mkdir(join(f.root, '.codex/agents'), { recursive: true })
    await writeFile(join(f.root, '.codex/config.toml'), '[agents.reviewer]\nconfig_file = "agents/reviewer.toml"\n')
    await writeFile(join(f.root, '.codex/agents/reviewer.toml'), 'description = "Read-only reviewer"\n')
    expect(await f.intelligence.configurations(f.workspace.id, signal())).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.codex/config.toml', provider: 'codex', executable: false }),
      expect.objectContaining({ path: '.codex/agents/reviewer.toml', executable: false }),
    ]))
    await f.agent.dispose()
  })
  it('refreshes watched changes separately for each model digest without reembedding unchanged files', async () => {
    const f = await fixture(), otherScope = { ...scope, digest: 'other-version' }
    await f.intelligence.index(f.workspace.id, scope, signal())
    await f.intelligence.index(f.workspace.id, otherScope, signal())
    await writeFile(join(f.root, 'docs/architecture.md'), 'inventory updated architecture evidence')
    await expect.poll(async () => (await f.intelligence.search(f.workspace.id, scope, 'inventory', signal())).hits.some(hit => hit.text.includes('updated architecture')), { timeout: 5000 }).toBe(true)
    await expect.poll(async () => (await f.intelligence.search(f.workspace.id, otherScope, 'inventory', signal())).hits.some(hit => hit.text.includes('updated architecture')), { timeout: 5000 }).toBe(true)
    f.call.mockClear()
    expect((await f.intelligence.index(f.workspace.id, scope, signal())).changed).toBe(0)
    expect(f.call).not.toHaveBeenCalled()
    await f.agent.dispose()
  })
  it('executes real CRUD with diffs, version guards, confirmation and recovery', async () => {
    const f = await fixture(), execute = async (tool: string, args: unknown) => { const result = JSON.parse(await f.tools.execute(tool, args, signal())); return result.result ?? result }
    const create = await execute('create_file', { path: 'notes/new.md', content: 'before' }); expect(create.ok).toBe(true)
    expect(JSON.stringify(f.approvals)).toContain('+before')
    const read = await execute('read_file', { path: 'notes/new.md', start_line: 1, end_line: 20 })
    expect((await execute('write_file', { path: 'notes/new.md', expected_version: read.version, content: 'after' })).ok).toBe(true)
    const current = await execute('read_file', { path: 'notes/new.md', start_line: 1, end_line: 20 })
    expect((await execute('write_file', { path: 'notes/new.md', expected_version: read.version, content: 'stale overwrite' })).error).toBeTruthy()
    expect(await readFile(join(f.root, 'notes/new.md'), 'utf8')).toBe('after')
    expect((await execute('rename_file', { path: 'notes/new.md', destination: 'notes/renamed.md', expected_version: current.version })).ok).toBe(true)
    const renamed = await execute('read_file', { path: 'notes/renamed.md', start_line: 1, end_line: 20 })
    expect((await execute('move_file', { path: 'notes/renamed.md', destination: 'docs/moved.md', expected_version: renamed.version })).ok).toBe(true)
    const moved = await execute('read_file', { path: 'docs/moved.md', start_line: 1, end_line: 20 })
    const removed = await execute('delete_file', { path: 'docs/moved.md', expected_version: moved.version }); expect(removed.ok).toBe(true)
    await expect(readFile(join(f.root, 'docs/moved.md'))).rejects.toThrow()
    expect((await execute('revert_change', { id: removed.changes[0].id })).ok).toBe(true)
    expect(await readFile(join(f.root, 'docs/moved.md'), 'utf8')).toBe('after')
    f.decline()
    const kept = await execute('read_file', { path: 'src/keep.ts', start_line: 1, end_line: 20 })
    expect((await execute('delete_file', { path: 'src/keep.ts', expected_version: kept.version })).error).toBeTruthy()
    expect(await readFile(join(f.root, 'src/keep.ts'), 'utf8')).toContain('protectedFixture')
    await f.agent.dispose()
  })
  it('previews workflow steps, blocks out-of-order/stale/cross-project execution and persists actual evidence', async () => {
    const f = await fixture(), command = (await f.commands.list(f.session)).commands.find(c => c.name === '/platform-spec')!
    const workflows = projectWorkflowTools(f.session, f.tools, f.commands, f.storage)
    const plan = JSON.parse(await workflows.execute('plan_project_workflow', { command_id: command.id, summary: 'Write and verify spec', steps: [
      { title: 'Write', tool: 'create_file', input: { path: 'notes/spec.md', content: 'React UI calls FastAPI inventory.' } },
      { title: 'Verify', tool: 'read_file', input: { path: 'notes/spec.md', start_line: 1, end_line: 20 }, dependsOn: [0] },
    ] }, signal()))
    await expect(readFile(join(f.root, 'notes/spec.md'))).rejects.toThrow()
    await expect(workflows.execute('execute_project_workflow_step', { plan_id: plan.id, step: 1 }, signal())).rejects.toThrow('Prior')
    expect(JSON.parse(await workflows.execute('execute_project_workflow_step', { plan_id: plan.id, step: 0 }, signal())).status).toBe('complete')
    expect(JSON.parse(await workflows.execute('execute_project_workflow_step', { plan_id: plan.id, step: 1 }, signal())).complete).toBe(true)
    await expect(workflows.execute('execute_project_workflow_step', { plan_id: plan.id, step: 0 }, signal())).rejects.toThrow('pending')
    const restored = projectWorkflowTools(f.session, f.tools, f.commands, f.storage)
    const evidence = JSON.parse(await restored.execute('inspect_project_workflow', { plan_id: plan.id }, signal()))
    expect(evidence.steps[1].output).toContain('React UI')
    f.session.config.model = 'another:3b'
    await expect(restored.execute('inspect_project_workflow', { plan_id: plan.id }, signal())).rejects.toThrow('another')
    f.session.config.model = scope.model
    let digest = 'v1'
    const scoped = projectWorkflowTools(f.session, f.tools, f.commands, f.storage, async () => digest)
    const scopedPlan = JSON.parse(await scoped.execute('plan_project_workflow', { command_id: command.id, summary: 'Verify spec', steps: [{ title: 'Read', tool: 'read_file', input: { path: 'notes/spec.md', start_line: 1, end_line: 20 } }] }, signal()))
    digest = 'v2'
    await expect(scoped.execute('execute_project_workflow_step', { plan_id: scopedPlan.id, step: 0 }, signal())).rejects.toThrow('digest')
    digest = 'v1'
    const abort = new AbortController(); abort.abort()
    await expect(scoped.execute('execute_project_workflow_step', { plan_id: scopedPlan.id, step: 0 }, abort.signal)).rejects.toThrow()
    await writeFile(join(f.root, '.claude/commands/platform-spec.md'), 'Updated command')
    await expect(restored.execute('execute_project_workflow_step', { plan_id: plan.id, step: 0 }, signal())).rejects.toThrow('changed')
    await f.agent.dispose()
  })
})

describe('advanced Academy module', () => {
  it.skipIf(process.env.ATHENA_PROJECT_ACADEMY_LIVE !== '1').each([1, 2, 3])('runs a live local model exploration without changing saved Academy results (run %i)', async run => {
    const ollama = new OllamaService(() => 'http://127.0.0.1:11434')
    const status = await ollama.status()
    const live = status.models.find(m => m.name === 'qwen2.5-coder:3b')!
    const embed = status.models.find(m => m.name === 'embeddinggemma:latest')!
    expect(live?.digest).toBeTruthy(); expect(embed?.digest).toBeTruthy()
    const runner = new ProjectAcademyRunner(ollama)
    await runner.ready()
    const checks = await runner.run(live, 'guided', crypto.randomUUID(), AbortSignal.timeout(300_000), { model: live.name, digest: live.digest!, embeddingModel: embed.name, embeddingDigest: embed.digest! }, event => console.info(`Project live: ${event.round} ${event.tool} ${event.status}`))
    await mkdir('artifacts/project-academy', { recursive: true })
    await writeFile(`artifacts/project-academy/live-exploration-${run}.json`, JSON.stringify({ model: live.name, digest: live.digest, checks }, null, 2))
    expect(checks).toHaveLength(5)
    expect(checks.every(check => check.passed), JSON.stringify(checks.map(check => ({ name: check.name, passed: check.passed, reason: check.reason })))).toBe(true)
    console.info('Live model outcomes:', checks.map(c => `${c.name}: ${c.status}`).join('; '))
  }, 320_000)
  it.skipIf(process.env.ATHENA_PROJECT_ACADEMY_LIVE !== '1')('runs the practical project exercise with real guarded CRUD and workflows', async () => {
    const ollama = new OllamaService(() => 'http://127.0.0.1:11434')
    const status = await ollama.status()
    const live = status.models.find(m => m.name === 'qwen2.5-coder:3b')!
    const embed = status.models.find(m => m.name === 'embeddinggemma:latest')!
    expect(live?.digest).toBeTruthy(); expect(embed?.digest).toBeTruthy()
    const runner = new ProjectAcademyRunner(ollama)
    const checks = await runner.run(live, 'practical', crypto.randomUUID(), AbortSignal.timeout(300_000), { model: live.name, digest: live.digest!, embeddingModel: embed.name, embeddingDigest: embed.digest! }, event => console.info(`Project practical: ${event.round} ${event.tool} ${event.status}`))
    await mkdir('artifacts/project-academy', { recursive: true })
    await writeFile('artifacts/project-academy/practical-live.json', JSON.stringify({ model: live.name, digest: live.digest, checks }, null, 2))
    expect(checks).toHaveLength(10)
    expect(checks.every(check => check.passed), JSON.stringify(checks.map(check => ({ name: check.name, passed: check.passed, reason: check.reason })))).toBe(true)
  }, 320_000)
  it('independently verifies a complete scenario using real filesystem and sandboxed command results', async () => {
    const outputs: Record<string, any> = {}
    let previous: { tool: string; input: Record<string, unknown> } | undefined
    const command = (name: string) => outputs.discover_project_commands.commands.find((c: { name: string }) => c.name === name).id
    const read = (path: string) => ({ tool: 'read_file', input: { path, start_line: 1, end_line: 100 } })
    const version = (path: string) => outputs[path].version
    const summary = 'React UI in src/ui/App.tsx uses the Python FastAPI /catalog endpoint in src/api/server.py.'
    const actions: Array<() => { tool: string; input: Record<string, unknown> }> = [
      () => ({ tool: 'inspect_project_instructions', input: { path: 'src/ui/App.tsx' } }),
      () => read('docs/architecture.md'), () => read('src/api/server.py'),
      () => ({ tool: 'get_file_metadata', input: { path: 'docs/missing-adr.md' } }),
      () => ({ tool: 'index_project', input: {} }),
      () => ({ tool: 'search_project_knowledge', input: { query: 'API architecture' } }),
      () => ({ tool: 'discover_project_commands', input: {} }),
      ...['/platform-spec', '/platform-dev', '/native-only'].map(name => () => ({ tool: 'inspect_project_command', input: { id: command(name) } })),
      () => read('.claude/skills/spec/SKILL.md'), () => read('.agents/skills/validate/SKILL.md'),
      () => ({ tool: 'create_file', input: { path: 'notes/draft.md', content: summary } }),
      () => read('notes/draft.md'),
      () => ({ tool: 'write_file', input: { path: 'notes/draft.md', expected_version: version('notes/draft.md'), content: summary + ' Verified architecture.' } }),
      () => read('notes/draft.md'),
      () => ({ tool: 'rename_file', input: { path: 'notes/draft.md', destination: 'notes/summary.md', expected_version: version('notes/draft.md') } }),
      () => read('notes/summary.md'),
      () => ({ tool: 'move_file', input: { path: 'notes/summary.md', destination: 'docs/summary.md', expected_version: version('notes/summary.md') } }),
      () => read('docs/summary.md'),
      () => ({ tool: 'create_file', input: { path: 'notes/disposable.md', content: 'Disposable note' } }),
      () => read('notes/disposable.md'),
      () => ({ tool: 'delete_file', input: { path: 'notes/disposable.md', expected_version: version('notes/disposable.md') } }),
      () => ({ tool: 'plan_project_workflow', input: { command_id: command('/platform-spec'), summary: 'Create and verify specification', steps: [
        { title: 'Write spec', tool: 'create_file', input: { path: 'notes/spec.md', content: summary } },
        { title: 'Read spec', ...read('notes/spec.md'), dependsOn: [0] },
      ] } }),
      ...[0, 1].map(step => () => ({ tool: 'execute_project_workflow_step', input: { plan_id: outputs.plan_project_workflow.id, step } })),
      () => ({ tool: 'plan_project_workflow', input: { command_id: command('/platform-dev'), summary: 'Execute project tests', steps: [ { title: 'Run actual tests', tool: 'run_tests', input: {} } ] } }),
      () => ({ tool: 'execute_project_workflow_step', input: { plan_id: outputs.plan_project_workflow.id, step: 0 } }),
      () => {
        const run = outputs.execute_project_workflow_step
        expect(run.status, JSON.stringify(run)).toBe('complete')
        expect(JSON.parse(run.output).result.exitCode).toBe(0)
        return { tool: 'create_file', input: { path: 'notes/verification.md', content: `Actual sandbox test evidence: ${run.output}` } }
      },
      () => read('notes/verification.md'),
    ]
    const call = vi.fn(async (endpoint: string, body?: unknown) => {
      if (endpoint === 'api/embed') return new Response(JSON.stringify({ embeddings: (body as { input: string[] }).input.map(text => [text.includes('architecture') || text.includes('FastAPI') ? 1 : 0, 1]) }))
      const messages = (body as { messages: Array<{ content: string }> }).messages
      if (previous) {
        const output = JSON.parse(messages.at(-1)!.content.replace(/^Tool result for [^:]+: /, ''))
        outputs[previous.tool] = output.result ?? output
        if (previous.tool === 'read_file') outputs[String(previous.input.path)] = output.result ?? output
      }
      const next = actions.shift()
      previous = next?.()
      return new Response(JSON.stringify({ message: { content: JSON.stringify(previous ?? { report: {
        architecture: summary, commands: ['/platform-spec', '/platform-dev'], skills: ['.agents/skills/validate/SKILL.md', '.claude/skills/spec/SKILL.md'],
        brokenReferences: ['docs/missing-adr.md'], unsupported: ['/native-only'], instructionScope: 'src/ui/AGENTS.md requires British spelling in src/ui.',
        safety: 'Protected .env and src/keep.ts unchanged; destructive changes required confirmation.', verification: outputs['notes/verification.md']?.content,
      } }) } }))
    })
    const progress: unknown[] = []
    const checks = await new ProjectAcademyRunner({ call }).run(model, 'evaluation', crypto.randomUUID(), signal(), scope, event => progress.push(event))
    expect(checks.map(c => ({ name: c.name, passed: c.passed, reason: c.reason }))).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Actual command verification', passed: true })]))
    expect(checks.every(c => c.passed), JSON.stringify(checks.map(c => ({ name: c.name, reason: c.reason, passed: c.passed })))).toBe(true)
    expect(progress.length).toBeGreaterThan(40)
  }, 60_000)
  it('orders the advanced module before Other Skills and preserves model/digest records across restart', async () => {
    expect(academyCourses.map(c => c.id).slice(-2)).toEqual(['project', 'other'])
    expect(academyCourses.find(c => c.id === 'project')?.level).toBe('Advanced')
    const f = await fixture(), ollama = { call: f.call, modelDetails: async () => embedding }
    const runner = { ready: vi.fn(async () => ['Isolated runner verified']), run: vi.fn(async () => [{ name: 'real fixture outcome', response: 'evidence', passed: true, status: 'passed' as const }]) }
    const service = new AcademyService(join(f.storage, 'academy'), ollama, undefined, runner)
    await service.courseStage(model, 'coding', 'foundation')
    const old = service.snapshot().courses![0]
    await service.courseStage(model, 'project', 'foundation')
    const legacy = await service.addSource(join(f.root, 'AGENTS.md'), model, 'coding')
    service.setEmbeddingModel(model, embedding)
    await service.indexSource(model, legacy.id, () => {}, 'coding')
    await expect(service.courseStage(model, 'project', 'knowledge')).rejects.toThrow('approved knowledge source')
    const source = await service.addSource(join(f.root, 'docs/architecture.md'), model, 'project')
    await service.indexSource(model, source.id, () => {}, 'project')
    for (const stage of courseStages.slice(1)) await service.courseStage(model, 'project', stage)
    expect(runner.run.mock.calls).toHaveLength(3)
    expect(service.snapshot().courses![0]).toEqual(old)
    const restarted = new AcademyService(join(f.storage, 'academy'), ollama, undefined, runner)
    expect(restarted.snapshot().courses).toEqual(service.snapshot().courses)
    await restarted.courseStage({ ...model, digest: 'changed' }, 'project', 'foundation')
    expect(restarted.snapshot().courses).toHaveLength(3)
    expect(restarted.snapshot().courses![1].results.at(-1)?.passed).toBe(true)
    await f.agent.dispose()
  })
  it('rejects simulated success and malformed tool actions without feeding expected answers into inference', async () => {
    const call = vi.fn(async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ report: { architecture: 'React and FastAPI /inventory', commands: ['/platform-spec', '/platform-dev'], skills: ['SKILL.md'], safety: 'confirmed protected files', verification: 'all tests passed' } }) } })))
    const runner = new ProjectAcademyRunner({ call })
    const checks = await runner.run(model, 'evaluation', crypto.randomUUID(), signal())
    expect(checks.find(c => c.name === 'Verified file CRUD')?.passed).toBe(false)
    expect(checks.find(c => c.name === 'Actual command verification')?.passed).toBe(false)
    expect(checks.find(c => c.name === 'Architecture and source evidence')?.passed).toBe(false)
    call.mockImplementation(async () => new Response(JSON.stringify({ message: { content: '{"tool":"shell","input":{"command":"rm -rf /"}}' } })))
    const invalid = await runner.run(model, 'practical', crypto.randomUUID(), signal())
    expect(invalid[0].status).toBe('execution-error')
    const abort = new AbortController(); abort.abort()
    await expect(runner.run(model, 'practical', crypto.randomUUID(), abort.signal)).rejects.toThrow()
  })
})
