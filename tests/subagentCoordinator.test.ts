// @vitest-environment node
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { AgentTools } from '../electron/main/ai/agentTools'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { SubagentCoordinator } from '../electron/main/ai/subagentCoordinator'
import { ChatError, type AIProvider, type ProjectTools, type StreamOptions } from '../electron/main/ai/AIProvider'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { ToolCallSession } from '../electron/main/ai/toolCallSession'
import { subagentDefaults, type SubagentResult, type SubagentRequirement, type SubagentSettings } from '../shared/subagents'
import type { ChatMessage } from '../shared/chat'
import type { ConversationConfig } from '../shared/conversations'
import { workflowSubagentRequirements } from '../electron/main/ai/subagentWorkflow'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const result = (summary = 'Reviewed the artifact independently.'): SubagentResult => ({ status: 'completed', summary, findings: [], blockers: [], evidence: ['spec.md:1'], filesReviewed: [], checksPerformed: ['Read assigned artifact'], limitations: ['No runtime tests requested'], nextActions: [] })
const assignment = { taskKey: 'review', role: 'Cold-read reviewer', task: 'Review the specification.', criteria: 'Check explicit acceptance criteria.', files: ['spec.md'] }
const call = async (tools: ProjectTools, signal: AbortSignal, name: string, args: unknown) => {
  if (!tools.executionBudget) return JSON.parse(await tools.execute(name, args, signal))
  return JSON.parse(await new ToolCallSession(tools, signal, tools.maxCalls ?? 100).execute({ type: 'function_call', call_id: randomUUID(), name, arguments: JSON.stringify(args), status: 'completed' }, 10000))
}
const read = (options: StreamOptions, path = 'spec.md', end = 400, start = 1) => call(options.context!.projectTools!, options.signal!, 'read_file', { path, start_line: start, end_line: end })
type Child = (options: StreamOptions, messages: ChatMessage[], config: ConversationConfig, attempt: number) => Promise<SubagentResult | string>
async function fixture(parent: (tools: ProjectTools, signal: AbortSignal, chat: ChatController) => Promise<void>, options: { child?: Child; childProvider?: (config: ConversationConfig) => AIProvider; settings?: Partial<SubagentSettings>; gates?: SubagentRequirement[]; mode?: 'read-only' | 'advanced'; unavailable?: boolean; text?: string; projectRoot?: string } = {}) {
  const directory = options.projectRoot ? undefined : await realpath(await mkdtemp(join(tmpdir(), 'athena-child-test-'))), root = options.projectRoot ?? join(directory!, 'project'), storage = join(directory ?? await realpath(await mkdtemp(join(tmpdir(), 'athena-child-storage-'))), 'storage')
  if (!options.projectRoot) { await mkdir(root); await writeFile(join(root, 'spec.md'), options.text ?? 'Acceptance criteria\nHandle empty and error states.\n'); await writeFile(join(root, 'unrelated.md'), 'Unrelated private parent notes') }
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root), agent = new AgentTools(workspaces, storage)
  const settings = { ...subagentDefaults(), ...options.settings }, repository = new ConversationRepository(storage)
  const requests: Array<{ messages: ChatMessage[]; options: StreamOptions; config: ConversationConfig }> = []
  const assertionFailures: unknown[] = []
  let childCount = 0
  const chat: ChatController = new ChatController({
    provider: async (config, child) => {
      if (child?.isolated && options.unavailable) throw new ChatError('Requested model unavailable.')
      if (child?.isolated && options.childProvider) return options.childProvider(config)
      return { modelId: config.model ?? 'gpt-5', testConnection: async () => true, async *streamMessage(messages, stream = {}) {
        if (child?.isolated) {
          const count = ++childCount
          requests.push({ messages, options: stream, config })
          stream.beforeModelRequest?.(JSON.stringify(messages).length, 1024)
          let output: SubagentResult | string
          try { output = options.child ? await options.child(stream, messages, config, count) : (await read(stream), result()) }
          catch (error) { if (error instanceof Error && /AssertionError/.test(error.name)) assertionFailures.push(error); throw error }
          yield { type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }
        } else {
          try { await parent(stream.context!.projectTools!, stream.signal!, chat) }
          catch (error) { if (error instanceof Error && /AssertionError/.test(error.name)) assertionFailures.push(error); throw error }
          yield { type: 'text', text: 'Parent reviewed the returned findings.' }
        }
        yield { type: 'done' }
      } }
    },
    authorized: (id) => workspaces.authorized(id),
    prepare: async (session, _messages, signal) => {
      if (options.gates) chat.activeExecution()!.execution!.subagentRequirements = options.gates
      const base = agent.create(chat, session.id, workspace.id, workspace.name, options.mode ?? 'advanced', [], () => true)
      const coordinator = new SubagentCoordinator(chat, session, workspace.id, workspace.name, agent, workspaces, () => settings, signal)
      return { attachments: [], repositoryText: 'PARENT_REPOSITORY_CONTEXT_NOT_FOR_CHILD', sources: [], projectTools: coordinator.tools(base) }
    }, changed: vi.fn(), phase: vi.fn(),
  }, repository)
  chat.addWorkspace(chat.current().id, workspace)
  chat.current().config.model = 'gpt-5'; chat.current().config.effort = 'high'
  chat.command({ action: 'agent-mode', id: chat.current().id, mode: options.mode ?? 'advanced' })
  chat.current().messages.push({ id: randomUUID(), role: 'user', content: 'PARENT_HISTORY_MUST_NOT_LEAK', createdAt: Date.now(), status: 'complete' })
  cleanups.push(async () => { chat.dispose(); await agent.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); else await rm(storage, { recursive: true, force: true }) })
  chat.send({ text: 'Delegate review of the selected artifact.' })
  const idle = async () => { await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'), { timeout: 5000 }); if (assertionFailures.length) throw assertionFailures[0] }
  const runs = () => chat.subagentRecords(chat.current().id).map((entry) => entry.run)
  return { chat, root, settings, requests, repository, idle, runs, get childCount() { return childCount } }
}

describe('isolated child executions through the shared agent', () => {
  it.skipIf(!['docs/tickets/MBM-11400/artifacts/define.md', 'docs/tickets/MBM-11400/artifacts/tds-azure-devops-trace.md', 'skills/platform-spec/prompt.md'].every((file) => existsSync(join('/Users/mariojrlangomez/Desktop/projects/mbtc/web/map-governance-ui', file))))('runs a focused cold read against the existing MBM-11400 artifacts without writing them', async () => {
    const root = '/Users/mariojrlangomez/Desktop/projects/mbtc/web/map-governance-ui'
    const files = ['docs/tickets/MBM-11400/artifacts/define.md', 'docs/tickets/MBM-11400/artifacts/tds-azure-devops-trace.md', 'skills/platform-spec/prompt.md']
    const focused = { ...assignment, taskKey: 'mbm-11400-focused-cold-read', files, criteria: 'Review only these three artifacts and return an evidence-backed assessment.' }
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', focused)
      const waited = await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      expect(waited.results[0].status).toBe('completed')
    }, { projectRoot: root, child: async (options) => {
      for (const file of files) {
        let start = 1
        do {
          const page = await read(options, file, start + 399, start)
          start = typeof page.nextStartLine === 'number' ? page.nextStartLine : 0
        } while (start > 0)
      }
      return { status: 'completed', assessment: 'PASS', summary: 'The three selected MBM-11400 artifacts were reviewed independently.', findings: [], blockers: [], evidence: files.map((file) => `${file}:1`), filesReviewed: files, checksPerformed: ['Read each selected artifact and compared it with the review criteria'], limitations: [], nextActions: [] }
    } })
    await f.idle()
    expect(f.runs()[0]).toMatchObject({ status: 'completed', reviewAccepted: false })
    expect(f.runs()[0].result?.filesReviewed).toEqual(files)
    expect(f.runs()[0].resultDiagnostics?.terminationReason).toBe('parsed_completed')
  })

  it('applies newly saved limits to new children during the same parent and records explicit workflow ceilings', async () => {
    const f = await fixture(async (tools, signal) => {
      const first = await call(tools, signal, 'spawn_subagent', assignment)
      expect(first.executionBudget).toMatchObject({ effectiveToolCalls: 40, effectiveIterations: 24 })
      await call(tools, signal, 'wait_subagents', { ids: [first.id] })
      f.settings.maxToolCalls = 60; f.settings.maxIterations = 20
      const second = await call(tools, signal, 'spawn_subagent', { ...assignment, taskKey: 'new-preferences' })
      expect(second.executionBudget).toMatchObject({ configuredToolCalls: 60, effectiveToolCalls: 60, configuredIterations: 20, effectiveIterations: 20, requestedToolCalls: null })
      const capped = await call(tools, signal, 'spawn_subagent', { ...assignment, taskKey: 'explicit-cap', gateId: 'review', maxToolCalls: 50 })
      expect(capped.executionBudget).toMatchObject({ configuredToolCalls: 60, requestedToolCalls: 20, effectiveToolCalls: 20, configuredIterations: 20, requestedIterations: 12, effectiveIterations: 12 })
      await call(tools, signal, 'wait_subagents', { ids: [second.id, capped.id] })
    }, { gates: [{ id: 'review', required: false, mode: 'cold_read', role: 'Reviewer', maxToolCalls: 20, maxIterations: 12, expectedResultSchema: 'athena-review-v1' }] })
    await f.idle()
    expect(f.runs().map(child => child.toolCalls)).toEqual([1, 1, 1])
    expect(f.requests.map(request => request.options.context?.projectTools?.maxCalls)).toEqual([40, 60, 20])
    expect(f.requests.map(request => request.options.context?.projectTools?.maxRounds)).toEqual([24, 20, 12])
    expect(f.chat.snapshot().messages.at(-1)?.execution?.activities.filter(activity => activity.tool === 'read_file')).toHaveLength(3)
  })

  it.each([20, 22])('handles 3 requested tools with 1 left, then assesses honestly against %i evidence lines', async (total) => {
    const bodies: Array<Record<string, any>> = [], request = vi.fn<typeof fetch>()
    request.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string), round = bodies.length; bodies.push(body)
      const ranges = round === 0 ? Array.from({ length: 19 }, (_, i) => i + 1) : round === 1 ? [20, 21, 22] : []
      const output = ranges.map(line => ({ type: 'function_call', call_id: `r${round}-l${line}`, name: 'read_file', arguments: JSON.stringify({ path: 'spec.md', start_line: line, end_line: line }), status: 'completed' }))
      const events = [...(round === 2 ? [{ type: 'response.output_text.delta', delta: JSON.stringify(result('PASS based on reviewed criteria.')) }] : []), { type: 'response.completed', response: { output, usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } } }]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, maxToolCalls: 20, maxIterations: 12, gateId: 'review' })
      const status = (await call(tools, signal, 'wait_subagents', { ids: [child.id] })).results[0].status
      expect(status).toBe(total === 20 ? 'completed' : 'blocked')
      const reconciliation = await call(tools, signal, 'reconcile_subagent', { id: child.id, accepted: true, summary: 'Checked returned evidence against criteria.' })
      if (total > 20) {
        expect(reconciliation.error).toContain('gate remains incomplete')
        expect((await call(tools, signal, 'resume_subagent', { id: child.id })).error).toContain('already returned its final incomplete assessment')
      }
    }, { settings: { maxToolCalls: 60, maxIterations: 20 }, text: Array.from({ length: total }, (_, i) => `Evidence ${i + 1}`).join('\n'), gates: [{ id: 'review', required: true, mode: 'cold_read', role: 'Reviewer', expectedResultSchema: 'athena-review-v1' }], childProvider: config => new OpenAIProvider('sk-test-fixture', config.model!, request, undefined, true) })
    await f.idle()
    expect(request).toHaveBeenCalledTimes(3)
    const child = f.runs()[0]
    expect(child).toMatchObject({ iterations: 3, toolCalls: 20, reviewAccepted: total === 20 })
    expect(child.executionBudget).toMatchObject({ configuredToolCalls: 60, effectiveToolCalls: 20, remainingToolCalls: 0, effectiveIterations: 12, remainingIterations: 9, lastBatch: { requested: 3, executed: 1, deferred: 2 }, finalization: { reason: 'batch_limit' } })
    expect(child.budget?.remainingTokens).toBe(246700)
    expect(bodies[2].tool_choice).toBe('none'); expect(bodies[2].parallel_tool_calls).toBe(false)
    const returns = bodies[2].input.filter((entry: any) => entry.type === 'function_call_output')
    expect(returns).toHaveLength(22)
    expect(returns.slice(-2).every((entry: any) => entry.output.includes('tool_budget_deferred'))).toBe(true)
    expect(f.chat.snapshot().messages.at(-1)?.execution?.activities.filter(activity => activity.tool === 'read_file')).toHaveLength(20)
    if (total > 20) {
      expect(child.result?.limitations).toContain('spec.md: missing 21-22')
      expect(child.result?.status).toBe('blocked')
      expect(f.chat.snapshot().messages.at(-1)?.status).not.toBe('complete')
    }
    const restored = f.repository.load().sessions[0].messages.at(-1)!.execution!.activities.find(activity => activity.subagent)!.subagent!
    expect(restored.executionBudget).toEqual(child.executionBudget)
    expect(restored.observations).toEqual(child.observations)
  })

  it.each(['iterations', 'no_progress'] as const)('uses a tools-disabled final assessment at the %s boundary', async (boundary) => {
    const bodies: Array<Record<string, any>> = [], request = vi.fn<typeof fetch>()
    request.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string), round = bodies.length; bodies.push(body)
      const output = body.tool_choice === 'none' ? [] : [{ type: 'function_call', call_id: `call${round}`, name: 'read_file', arguments: JSON.stringify({ path: 'spec.md', start_line: 1, end_line: 100 }), status: 'completed' }]
      const events = [...(!output.length ? [{ type: 'response.output_text.delta', delta: JSON.stringify(result()) }] : []), { type: 'response.completed', response: { output, usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } } }]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, ...(boundary === 'iterations' ? { maxIterations: 2 } : {}) })
      expect((await call(tools, signal, 'wait_subagents', { ids: [child.id] })).results[0].status).toBe('completed')
    }, { childProvider: config => new OpenAIProvider('sk-test-fixture', config.model!, request) })
    await f.idle()
    expect(f.runs()[0].executionBudget?.finalization?.reason).toBe(boundary)
    expect(f.runs()[0].toolCalls).toBe(boundary === 'iterations' ? 1 : 5)
    expect(f.runs()[0].iterations).toBe(boundary === 'iterations' ? 2 : 6)
    expect(bodies.at(-1)?.tool_choice).toBe('none')
  })

  it('counts a subscription request retry independently and uses the last slot for an incomplete assessment', async () => {
    const bodies: Array<Record<string, any>> = [], request = vi.fn<typeof fetch>()
    request.mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      if (bodies.length === 1) throw new Error('Temporary fixture network failure before a response stream')
      return new Response([{ type: 'response.output_text.delta', delta: JSON.stringify(result()) }, { type: 'response.completed', response: { output: [], usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, maxIterations: 2 })
      expect((await call(tools, signal, 'wait_subagents', { ids: [child.id] })).results[0].status).toBe('blocked')
    }, { childProvider: config => new OpenAIProvider('sk-test-fixture', config.model!, request, undefined, true) })
    await f.idle()
    expect(bodies).toHaveLength(2); expect(bodies[1].tool_choice).toBe('none')
    expect(f.runs()[0]).toMatchObject({ iterations: 2, toolCalls: 0, reviewAccepted: false })
    expect(f.runs()[0].executionBudget?.finalization?.reason).toBe('iterations')
    expect(f.runs()[0].result?.summary).not.toContain('PASS based')
  })

  it.each([
    { model: 'gpt-6-sol', effort: 'medium', tokenBudget: 12000, rounds: 1, inputs: [2600, 3500], outputs: [200, 500] },
    { model: 'gpt-5.6-luna', effort: 'high', tokenBudget: 60000, rounds: 4, inputs: [2600, 4000, 8000, 13000, 16000], outputs: [200, 300, 400, 500, 600] },
  ] as const)('completes a focused $model cold read with settled usage inside its unchanged $tokenBudget cap', async (scenario) => {
    const request = vi.fn<typeof fetch>(), bodies: Array<Record<string, any>> = []
    let response = 0
    request.mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      const index = response++, count = scenario.rounds === 1 ? 3 : index === 3 ? 1 : 2
      const output = index < scenario.rounds ? Array.from({ length: count }, (_, callIndex) => ({ type: 'function_call', name: scenario.rounds === 1 && callIndex > 0 ? 'get_file_metadata' : 'read_file',
        arguments: JSON.stringify(scenario.rounds === 1 ? (callIndex === 0 ? { path: 'spec.md', start_line: 1, end_line: 100 } : { path: 'spec.md' }) : { path: 'spec.md', start_line: index * 2 + callIndex + 1, end_line: index === 3 ? 100 : index * 2 + callIndex + 1 }), call_id: `r${index}-call${callIndex}`, id: `fc_${index}_${callIndex}`, status: 'completed' })) : []
      const usage = { input_tokens: scenario.inputs[index], output_tokens: scenario.outputs[index], total_tokens: scenario.inputs[index] + scenario.outputs[index], output_tokens_details: { reasoning_tokens: 100 }, input_tokens_details: { cached_tokens: 500 } }
      const events = [...(index === scenario.rounds ? [{ type: 'response.output_text.delta', delta: JSON.stringify(result()) }] : []), { type: 'response.completed', response: { output, usage } }]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, model: scenario.model, effort: scenario.effort, tokenBudget: scenario.tokenBudget, gateId: 'review' })
      expect(child.budget).toMatchObject({ configured: 250000, requested: scenario.tokenBudget, effective: scenario.tokenBudget })
      expect((await call(tools, signal, 'wait_subagents', { ids: [child.id] })).results[0].status).toBe('completed')
      await call(tools, signal, 'reconcile_subagent', { id: child.id, accepted: true, summary: 'Compared independent file evidence with the fixture criteria.' })
    }, { text: Array.from({ length: 7 }, (_, i) => `Criterion ${i + 1}`).join('\n'), gates: [{ id: 'review', required: true, mode: 'cold_read', role: 'Reviewer', expectedResultSchema: 'athena-review-v1' }], childProvider: config => new OpenAIProvider('sk-fixture-not-a-key', config.model!, request, undefined, true) })
    await f.idle()
    const child = f.runs()[0], expected = [...scenario.inputs, ...scenario.outputs].reduce<number>((sum, value) => sum + value, 0)
    expect(child).toMatchObject({ model: scenario.model, effort: scenario.effort, iterations: scenario.rounds + 1, toolCalls: scenario.rounds === 1 ? 3 : 7, reviewAccepted: true })
    expect(child.budget).toMatchObject({ configuredTokens: 250000, effectiveTokens: scenario.tokenBudget, consumedTokens: expected, estimatedInput: 0, estimatedOutput: 0, reservedInput: 0, reservedOutput: 0, remainingTokens: scenario.tokenBudget - expected, reasoningTokens: (scenario.rounds + 1) * 100, outputLimitEnforced: false, modelContext: 1050000 })
    expect(f.chat.snapshot().messages.at(-1)?.status).toBe('complete')
    expect(child.result?.filesReviewed).toEqual(['spec.md'])
    expect(JSON.stringify(bodies)).not.toContain('PARENT_HISTORY_MUST_NOT_LEAK')
    expect(child.observations.length).toBeGreaterThan(0)
    expect(request).toHaveBeenCalledTimes(scenario.rounds + 1)
  })

  it('runs the production OpenAI adapter tool loop in an isolated child and returns actual file evidence to its next model request', async () => {
    const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    const request = vi.fn<typeof fetch>()
    request.mockResolvedValueOnce(sse({ type: 'response.completed', response: { output: [{ type: 'function_call', name: 'read_file', arguments: JSON.stringify({ path: 'spec.md', start_line: 1, end_line: 100 }), call_id: 'child_read_1', id: 'fc_child_read_1', status: 'completed' }] } }))
      .mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: JSON.stringify(result()) }, { type: 'response.completed', response: { output: [] } }))
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', assignment)
      expect((await call(tools, signal, 'wait_subagents', { ids: [child.id] })).results[0].status).toBe('completed')
    }, { childProvider: (config) => new OpenAIProvider('sk-test-not-a-real-key', config.model!, request) })
    await f.idle()
    expect(request).toHaveBeenCalledTimes(2)
    const bodies = request.mock.calls.map(([, init]) => JSON.parse(init!.body as string))
    expect(JSON.stringify(bodies)).not.toContain('PARENT_HISTORY_MUST_NOT_LEAK')
    expect(JSON.stringify(bodies)).not.toContain('PARENT_REPOSITORY_CONTEXT_NOT_FOR_CHILD')
    expect(bodies[0].tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['get_file_metadata', 'read_file'])
    expect(bodies[1].input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'child_read_1', output: expect.stringContaining('Acceptance criteria') }))
    expect(f.runs()[0].iterations).toBe(2)
    expect(f.runs()[0].status).toBe('completed')
  })
  it('cold-reads actual files without parent history, retrieval, attachments, checkpoint or tools outside scope', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', assignment)
      const waited = await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      expect(waited.results[0].status).toBe('completed')
      expect((await call(tools, signal, 'get_subagent', { id: child.id, section: 'filesReviewed' })).items).toEqual(['spec.md'])
      await call(tools, signal, 'reconcile_subagent', { id: child.id, accepted: true, summary: 'Compared criteria with evidence; no blockers.' })
    })
    await f.idle()
    expect(f.chat.snapshot().messages.at(-1)?.status).toBe('complete')
    expect(f.requests).toHaveLength(1)
    const request = f.requests[0]
    expect(request.messages).toHaveLength(1)
    expect(JSON.stringify(request.messages)).not.toContain('PARENT_HISTORY')
    expect(request.options.context?.repositoryText).toBe('')
    expect(request.options.context?.attachments).toEqual([])
    expect(request.options.checkpoint).toBeUndefined()
    expect(request.options.context?.projectTools?.definitions.map((tool) => tool.name).sort()).toEqual(['get_file_metadata', 'read_file'])
    expect(f.runs()[0].reviewAccepted).toBe(true)
    expect(f.runs()[0].iterations).toBe(1)
    expect(f.runs()[0].toolCalls).toBe(1)
    expect(await readFile(join(f.root, 'spec.md'), 'utf8')).toContain('Acceptance criteria')
    expect(f.chat.snapshot().messages.at(-1)?.execution?.activities.find((activity) => activity.tool === 'read_file')?.parentActivityId).toBeTruthy()
  })

  it('accepts only explicitly selected scoped/shared context and rejects cold-read contamination', async () => {
    const errors: string[] = []
    const f = await fixture(async (tools, signal, chat) => {
      errors.push((await call(tools, signal, 'spawn_subagent', { ...assignment, contextSummary: 'parent conclusion' })).error)
      const sharedId = chat.current().messages[0].id
      for (const mode of ['scoped', 'shared']) {
        const child = await call(tools, signal, 'spawn_subagent', { ...assignment, taskKey: mode, mode, contextSummary: 'Only this explicit summary', ...(mode === 'shared' ? { messageIds: [sharedId] } : {}) })
        await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      }
    })
    await f.idle()
    expect(errors[0]).toContain('Parent summaries')
    expect(f.requests[0].messages[0].content).toContain('Only this explicit summary')
    expect(f.requests[0].messages[0].content).not.toContain('PARENT_HISTORY')
    expect(f.requests[1].messages[0].content).toContain('PARENT_HISTORY_MUST_NOT_LEAK')
  })

  it('runs two independent readers concurrently, queues a third, and deduplicates task keys', async () => {
    const release: Array<() => void> = []
    const f = await fixture(async (tools, signal) => {
      const first = await call(tools, signal, 'spawn_subagent', assignment)
      const duplicate = await call(tools, signal, 'spawn_subagent', assignment)
      expect(duplicate.id).toBe(first.id)
      const second = await call(tools, signal, 'spawn_subagent', { ...assignment, taskKey: 'second' })
      const third = await call(tools, signal, 'spawn_subagent', { ...assignment, taskKey: 'third' })
      await call(tools, signal, 'wait_subagents', { ids: [first.id, second.id, third.id] })
    }, { child: async (options) => { await read(options); await new Promise<void>((resolve) => release.push(resolve)); return result() } })
    await vi.waitFor(() => expect(release).toHaveLength(2))
    expect(f.runs().map((run) => run.status)).toEqual(['running', 'running', 'queued'])
    release[0]()
    await vi.waitFor(() => expect(release).toHaveLength(3))
    release[1](); release[2]()
    await f.idle(); expect(f.childCount).toBe(3)
  })

  it('keeps a required workflow incomplete when its model is unavailable, without fallback', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, gateId: 'review', model: 'missing-model' })
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      expect((await call(tools, signal, 'get_subagent', { id: child.id })).error).toContain('model unavailable')
    }, { unavailable: true, gates: [{ id: 'review', required: true, role: 'Independent reviewer', mode: 'cold_read', expectedResultSchema: 'athena-review-v1' }] })
    await f.idle()
    expect(f.chat.snapshot().messages.at(-1)?.error).toContain('Required sub-agent gate')
    expect(f.runs()[0].model).toBe('missing-model')
    expect(f.childCount).toBe(0)
  })

  it('applies explicitly configured model and reasoning without changing the parent', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', assignment)
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
    }, { settings: { coldReadModel: 'gpt-5-mini', coldReadEffort: 'low' } })
    await f.idle()
    expect(f.requests[0].config.model).toBe('gpt-5-mini'); expect(f.requests[0].options.effort).toBe('low')
    expect(f.chat.current().config.model).toBe('gpt-5'); expect(f.chat.current().config.effort).toBe('high')
  })

  it('blocks path escapes, hidden credentials and undelegated mutation tools', async () => {
    const f = await fixture(async (tools, signal) => {
      expect((await call(tools, signal, 'spawn_subagent', { ...assignment, files: ['../outside.md'] })).error).toContain('project-relative')
      expect((await call(tools, signal, 'spawn_subagent', { ...assignment, files: ['.claude/.credentials.json'] })).error).toContain('Credentials')
      const child = await call(tools, signal, 'spawn_subagent', assignment)
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
    }, { child: async (options) => {
      await expect(read(options, 'unrelated.md')).rejects.toThrow('explicit file scope')
      await expect(call(options.context!.projectTools!, options.signal!, 'create_file', { path: 'created.md', content: 'bad' })).resolves.toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
      await read(options); return result()
    } })
    await f.idle()
    expect(f.runs()[0].status).toBe('completed')
    await expect(readFile(join(f.root, 'created.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires explicit write delegation approval even in Advanced Agent and preserves denial', async () => {
    let denied = ''
    const f = await fixture(async (tools, signal) => { denied = (await call(tools, signal, 'spawn_subagent', { ...assignment, mode: 'scoped', toolScopes: ['filesystem-read', 'filesystem-write'] })).error })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toContain('write-capable'))
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: false })
    await f.idle(); expect(denied).toContain('declined'); expect(f.childCount).toBe(0)
  })

  it('serializes a write-capable child with other workers and parent edits', async () => {
    let releaseReader!: () => void, releaseWriter!: () => void
    const order: string[] = []
    const outputs: unknown[] = []
    const f = await fixture(async (tools, signal) => {
      const reader = await call(tools, signal, 'spawn_subagent', assignment)
      const writer = await call(tools, signal, 'spawn_subagent', { ...assignment, taskKey: 'write', mode: 'scoped', files: ['spec.md', 'child.md'], toolScopes: ['filesystem-read', 'filesystem-write'] })
      const parentWrite = call(tools, signal, 'create_file', { path: 'parent.md', content: 'Parent change' }).then((value) => { outputs.push(value); order.push('parent') })
      await call(tools, signal, 'wait_subagents', { ids: [reader.id, writer.id] }); await parentWrite
    }, { settings: { requireWriteApproval: false }, child: async (options, _messages, _config, count) => {
      await read(options)
      if (count === 1) { await new Promise<void>((resolve) => { releaseReader = resolve }); order.push('reader') }
      else {
        await new Promise<void>((resolve) => { releaseWriter = resolve })
        outputs.push(await call(options.context!.projectTools!, options.signal!, 'create_file', { path: 'child.md', content: 'Child change' }))
        order.push('writer')
      }
      return result()
    } })
    await vi.waitFor(() => expect(releaseReader).toBeTypeOf('function'))
    expect(f.runs().map((run) => run.status)).toEqual(['running', 'queued'])
    releaseReader()
    await vi.waitFor(() => expect(releaseWriter).toBeTypeOf('function'))
    await expect(readFile(join(f.root, 'parent.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    releaseWriter(); await f.idle()
    expect(outputs).toEqual([expect.objectContaining({ result: expect.objectContaining({ ok: true }) }), expect.objectContaining({ result: expect.objectContaining({ ok: true }) })])
    expect(order).toEqual(['reader', 'writer', 'parent'])
    expect(await readFile(join(f.root, 'child.md'), 'utf8')).toBe('Child change')
    const applied = f.chat.snapshot().messages.at(-1)?.execution?.activities.flatMap((activity) => activity.changes?.filter((change) => change.status === 'applied') ?? [])
    expect(applied?.map((change) => change.path)).toEqual(['child.md', 'parent.md'])
  })

  it('does not grant a write-capable child permissions above a Read Only parent', async () => {
    let error = ''
    const f = await fixture(async (tools, signal) => { error = (await call(tools, signal, 'spawn_subagent', { ...assignment, mode: 'scoped', toolScopes: ['filesystem-write'] })).error }, { mode: 'read-only' })
    await f.idle(); expect(error).toContain('cannot acquire write'); expect(f.childCount).toBe(0)
  })

  it.each(['tool', 'iteration', 'context', 'tokens'] as const)('enforces the separate %s budget', async (kind) => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, maxToolCalls: 1, maxIterations: 1, ...(kind === 'context' ? { contextTokens: 1000 } : {}), ...(kind === 'tokens' ? { tokenBudget: 1000 } : {}) })
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
    }, { child: async (options) => {
      await read(options)
      if (kind === 'tool') await read(options)
      if (kind === 'iteration') options.beforeModelRequest?.(20, 10)
      return result()
    } })
    await f.idle(); expect(f.runs()[0].status).toBe('failed'); expect(f.runs()[0].error).toMatch(/budget/)
    expect(f.runs()[0].iterations).toBeLessThanOrEqual(1); expect(f.runs()[0].toolCalls).toBeLessThanOrEqual(1)
  })

  it('times out an unresponsive provider without leaving the parent waiting forever', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, timeoutMinutes: 0.01 })
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
    }, { child: async () => new Promise(() => {}) })
    await f.idle(); expect(f.runs()[0].status).toBe('failed'); expect(f.runs()[0].error).toContain('timed out')
  })

  it('preserves actual reads and persisted diagnostics when a later request genuinely exhausts the child cap', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, tokenBudget: 8000, gateId: 'review' })
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      expect((await call(tools, signal, 'reconcile_subagent', { id: child.id, accepted: true, summary: 'Must not pass' })).error).toContain('did not complete')
    }, { gates: [{ id: 'review', role: 'Independent reviewer', required: true, mode: 'cold_read', expectedResultSchema: 'athena-review-v1' }], child: async options => {
      await read(options)
      options.onModelResponse?.({ inputTokens: 4500, outputTokens: 500, reasoningTokens: 300, estimated: false })
      options.beforeModelRequest?.(9000, 4096)
      return result()
    } })
    await f.idle()
    const child = f.runs()[0]
    expect(child.status).toBe('failed'); expect(child.reviewAccepted).toBe(false)
    expect(child.observations).toHaveLength(1); expect(child.fileVersions['spec.md']).toBeTruthy()
    expect(child.budget).toMatchObject({ configuredTokens: 250000, effectiveTokens: 8000, consumedTokens: 5000, remainingTokens: 3000, reservedInput: 0, reservedOutput: 0, termination: { code: 'total_tokens' }, lastRequest: { inputTokens: 3000, outputTokens: 4096, requiredTokens: 7096, remainingBefore: 3000 } })
    expect(f.chat.snapshot().messages.at(-1)?.error).toContain('remains incomplete')
    f.chat.dispose()
    const restored = f.repository.load().sessions[0].messages.at(-1)!.execution!.activities.find(activity => activity.subagent)!.subagent!
    expect(restored.budget).toEqual(child.budget)
    expect(restored.observations).toEqual(child.observations)
    expect(await readFile(join(f.root, 'spec.md'), 'utf8')).toBe('Acceptance criteria\nHandle empty and error states.\n')
  })

  it('cancels one child from Activity without cancelling a sibling', async () => {
    let ids: string[] = []
    const f = await fixture(async (tools, signal) => {
      ids = [(await call(tools, signal, 'spawn_subagent', assignment)).id, (await call(tools, signal, 'spawn_subagent', { ...assignment, taskKey: 'second' })).id]
      await call(tools, signal, 'wait_subagents', { ids })
    }, { child: async (options, _messages, _config, attempt) => { await read(options); if (attempt === 1) await new Promise(() => {}); return result() } })
    await vi.waitFor(() => expect(f.childCount).toBe(2))
    f.chat.command({ action: 'cancel-subagent', id: f.chat.current().id, subagentId: ids[0] })
    await f.idle(); expect(f.runs().map((run) => run.status)).toEqual(['cancelled', 'completed'])
  })

  it('cancels all children with the parent and preserves successful observations', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', assignment)
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
    }, { child: async (options) => { await read(options); await new Promise(() => {}); return result() } })
    await vi.waitFor(() => expect(f.runs()[0]?.observations).toHaveLength(1))
    f.chat.stop()
    await vi.waitFor(() => expect(f.runs()[0].status).toBe('cancelled'))
    expect(f.runs()[0].fileVersions['spec.md']).toBeTruthy()
    expect(f.chat.snapshot().messages.at(-1)?.status).toBe('stopped')
  })

  it('does not accept a partial cold read or malformed final result', async () => {
    for (const malformed of [false, true]) {
      const f = await fixture(async (tools, signal) => {
        const child = await call(tools, signal, 'spawn_subagent', assignment)
        await call(tools, signal, 'wait_subagents', { ids: [child.id] })
        expect((await call(tools, signal, 'reconcile_subagent', { id: child.id, accepted: true, summary: 'Pass' })).error).toContain('did not complete')
      }, { child: async (options) => { await read(options, 'spec.md', 1); return malformed ? 'Everything passed.' : result() } })
      await f.idle(); expect(f.runs()[0].status).toBe('blocked')
      expect(f.runs()[0].result?.assessment).toBe('INCOMPLETE')
      if (malformed) {
        expect(f.runs()[0].rawResponse).toBe('Everything passed.')
        expect(f.runs()[0].resultDiagnostics?.terminationReason).toBe('incomplete_review_malformed_output')
      }
    }
  })

  it('returns conflicting findings independently and requires parent reconciliation', async () => {
    const f = await fixture(async (tools, signal) => {
      const ids = [(await call(tools, signal, 'spawn_subagent', assignment)).id, (await call(tools, signal, 'spawn_subagent', { ...assignment, taskKey: 'opposing', required: true })).id]
      await call(tools, signal, 'wait_subagents', { ids })
      expect((await call(tools, signal, 'get_subagent', { id: ids[0] })).result.summary).not.toBe((await call(tools, signal, 'get_subagent', { id: ids[1] })).result.summary)
      expect((await call(tools, signal, 'reconcile_subagent', { id: ids[1], accepted: true, summary: 'Ignore the blocker.' })).error).toContain('blocking findings')
    }, { child: async (options, _m, _c, count) => { await read(options); return count === 1 ? result('Contract is explicit.') : { ...result('Contract has a contradiction.'), findings: [{ severity: 'error', description: 'Missing fallback', evidence: ['spec.md:2'] }] } } })
    await f.idle(); expect(f.chat.snapshot().messages.at(-1)?.error).toContain('Required reviewer')
  })

  it('resumes a failed child with only its own evidence and preserves its budgets', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', assignment)
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      const resumed = await call(tools, signal, 'resume_subagent', { id: child.id })
      expect(resumed.id).toBe(child.id)
      const waited = await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      expect(waited.results[0].status).toBe('completed')
    }, { child: async (options, _messages, _config, count) => { if (count === 1) { await read(options); throw new ChatError('Temporary provider failure.') }; expect(options.context?.repositoryText).toContain('Acceptance criteria'); expect(options.context?.repositoryText).not.toContain('PARENT_HISTORY'); return result() } })
    await f.idle(); expect(f.runs().at(-1)?.attempts).toBe(2); expect(f.runs().at(-1)?.toolCalls).toBe(1)
    expect(f.runs().at(-1)?.iterations).toBe(2)
  })

  it('rejects stale reviews after a version-checked parent edit', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', assignment)
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      const file = await call(tools, signal, 'read_file', { path: 'spec.md', start_line: 1, end_line: 20 })
      expect(await call(tools, signal, 'edit_file', { path: 'spec.md', expected_version: file.version, old_text: 'Acceptance criteria', new_text: 'Updated acceptance criteria' })).toMatchObject({ result: { ok: true } })
      expect((await call(tools, signal, 'reconcile_subagent', { id: child.id, accepted: true, summary: 'No longer current' })).error).toContain('artifact changed')
    })
    await f.idle(); expect(f.runs()[0].reviewAccepted).toBe(false)
  })

  it('rechecks write delegation approval when continuing a saved failed worker', async () => {
    let parentAttempt = 0, id = ''
    const f = await fixture(async (tools, signal) => {
      if (++parentAttempt === 1) {
        id = (await call(tools, signal, 'spawn_subagent', { ...assignment, mode: 'scoped', toolScopes: ['filesystem-read', 'filesystem-write'] })).id
        await call(tools, signal, 'wait_subagents', { ids: [id] })
        throw new ChatError('Parent interrupted.')
      }
      expect((await call(tools, signal, 'resume_subagent', { id })).error).toContain('write access was declined')
    }, { settings: { requireWriteApproval: false }, child: async (options) => { await read(options); throw new ChatError('Temporary provider failure.') } })
    await f.idle()
    f.settings.requireWriteApproval = true
    expect(f.chat.retry().ok).toBe(true)
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeTruthy())
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: false })
    await f.idle(); expect(f.childCount).toBe(1)
  })

  it('does not reuse a completed review when the declared review criteria change', async () => {
    let parentAttempt = 0, id = ''
    const gates: SubagentRequirement[] = [{ id: 'review', role: 'Reviewer', required: true, mode: 'cold_read', criteria: 'Original criteria', expectedResultSchema: 'athena-review-v1' }]
    const f = await fixture(async (tools, signal) => {
      if (++parentAttempt === 1) {
        id = (await call(tools, signal, 'spawn_subagent', { ...assignment, gateId: 'review' })).id
        await call(tools, signal, 'wait_subagents', { ids: [id] })
        throw new ChatError('Parent interrupted.')
      }
      expect((await call(tools, signal, 'resume_subagent', { id })).error).toContain('requirements changed')
    }, { gates })
    await f.idle(); gates[0].criteria = 'Changed criteria'
    expect(f.chat.retry().ok).toBe(true)
    await f.idle(); expect(f.childCount).toBe(1)
    expect(f.chat.snapshot().messages.at(-1)?.error).toContain('remains incomplete')
  })

  it('does not reset the child dollar limit on continuation', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', { ...assignment, spendLimitUsd: 0.02 })
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      await call(tools, signal, 'resume_subagent', { id: child.id })
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
      expect((await call(tools, signal, 'get_subagent', { id: child.id })).error).toContain('No API budget remains')
    }, { child: async (options) => {
      await read(options)
      options.onUsage?.({ inputTokens: 10, outputTokens: 10, totalTokens: 20, contextTokens: 10, contextWindow: 24000, remainingTokens: 23990, toolTokens: 0, estimated: true, contextEstimated: true, modelLimitsVerified: false, estimatedCostUsd: 0.02, compactions: 0, status: 'ready', show: true })
      throw new ChatError('Provider interrupted after charged request.')
    } })
    await f.idle(); expect(f.childCount).toBe(1)
  })

  it('persists structured results and marks running workers interrupted after restart', async () => {
    const f = await fixture(async (tools, signal) => {
      const child = await call(tools, signal, 'spawn_subagent', assignment)
      await call(tools, signal, 'wait_subagents', { ids: [child.id] })
    })
    await f.idle(); f.chat.dispose()
    const library = f.repository.load()
    const child = library.sessions[0].messages.at(-1)!.execution!.activities.find((activity) => activity.subagent)!
    expect(child.subagent?.result?.summary).toContain('independently')
    child.subagent!.status = 'running'; child.status = 'running'
    f.repository.save(library)
    expect(f.repository.load().sessions[0].messages.at(-1)!.execution!.activities.find((activity) => activity.subagent)?.subagent?.status).toBe('interrupted')
  })

  it('restores a completed review on parent continuation without launching another child', async () => {
    let parentAttempt = 0, id = ''
    const f = await fixture(async (tools, signal) => {
      if (++parentAttempt === 1) {
        id = (await call(tools, signal, 'spawn_subagent', assignment)).id
        await call(tools, signal, 'wait_subagents', { ids: [id] })
        throw new ChatError('Parent provider interrupted after review.')
      }
      const restored = await call(tools, signal, 'resume_subagent', { id })
      expect(restored.status).toBe('completed')
      expect(restored.id).toBe(id)
      await call(tools, signal, 'reconcile_subagent', { id, accepted: true, summary: 'Rechecked the saved result and unchanged artifact.' })
    })
    await f.idle(); expect(f.chat.snapshot().messages.at(-1)?.status).toBe('error')
    expect(f.chat.retry().ok).toBe(true)
    await f.idle()
    expect(f.chat.snapshot().messages.at(-1)?.status).toBe('complete')
    expect(f.childCount).toBe(1); expect(f.runs().at(-1)?.reviewAccepted).toBe(true)
  })
})

describe('generic workflow sub-agent declarations', () => {
  it.each(['/platform-spec', '/platform-review', '/platform-build'])('supports %s cold-read metadata without a hardcoded workflow', (command) => {
    const gates = workflowSubagentRequirements(`${command}\n\`\`\`athena-subagents\n[{"id":"independent-review","role":"Reviewer","files":[".tmp/define.md"],"criteria":"Exit criteria"}]\n\`\`\``)
    expect(gates[0]).toMatchObject({ required: true, mode: 'cold_read', role: 'Reviewer', files: ['.tmp/define.md'] })
  })
  it('recognizes legacy cold-read requirements and refuses malformed declarations', () => {
    expect(workflowSubagentRequirements('The workflow requires a cold-read sub-agent.')[0].required).toBe(true)
    expect(() => workflowSubagentRequirements('```athena-subagents\nnot json\n```')).toThrow()
  })
})
