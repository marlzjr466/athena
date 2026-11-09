// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { subagentDefaults, subagentRunSchema } from '../shared/subagents'
import { defaultSettings } from '../shared/settings'
import { SubagentExecutionBudget } from '../electron/main/ai/subagentExecutionBudget'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { ClaudeAPIProvider } from '../electron/main/ai/claudeAPI'
import { OllamaProvider } from '../electron/main/ai/OllamaProvider'
import { OllamaService } from '../electron/main/ai/ollamaService'
import type { ProjectTools } from '../electron/main/ai/AIProvider'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
describe('provider-neutral child final assessment', () => {
  it.each(['openai', 'subscription', 'claude', 'ollama'] as const)('%s returns every batch result and disables tools for final assessment', async kind => {
    const run = subagentRunSchema.parse({ id: randomUUID(), parentExecutionId: randomUUID(), conversationId: randomUUID(), taskId: randomUUID(), projectId: 'fixture', request: { taskKey: 'review', role: 'Reviewer', task: 'Read fixture', criteria: 'Review', files: ['spec.md'], maxToolCalls: 1 }, status: 'running', model: null, effort: 'auto', accountId: null, startedAt: 1, attempts: 1, iterations: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null })
    const budget = new SubagentExecutionBudget(run, { ...subagentDefaults(), maxIterations: 2 }), bodies: Array<Record<string, any>> = []
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const first = bodies.length === 0; bodies.push(JSON.parse(init!.body as string))
      if (kind === 'ollama') return new Response(JSON.stringify({ message: first ? { tool_calls: Array.from({ length: 3 }, () => ({ function: { name: 'read_file', arguments: { path: 'spec.md' } } })) } : { content: 'Final assessment' }, done: true, prompt_eval_count: 500, eval_count: 100 }) + '\n')
      if (kind === 'claude') return sse(first ? [...Array.from({ length: 3 }, (_, index) => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `c${index}`, name: 'read_file', input: { path: 'spec.md' } } }, { type: 'content_block_stop', index }]).flat(), { type: 'message_delta', delta: { stop_reason: 'tool_use' } }] : [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Final assessment' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
      return sse([...(first ? [] : [{ type: 'response.output_text.delta', delta: 'Final assessment' }]), { type: 'response.completed', response: { output: first ? Array.from({ length: 3 }, (_, i) => ({ type: 'function_call', call_id: `c${i}`, name: 'read_file', arguments: '{"path":"spec.md"}', status: 'completed' })) : [], usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 } } }])
    })
    const model = { name: 'qwen2.5-coder:14b', size: 0, capabilities: ['completion', 'tools'], contextLength: 32768 }
    const provider = kind === 'claude' ? new ClaudeAPIProvider('fixture', 'claude-sonnet-test', request) : kind === 'ollama' ? new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), model.name, defaultSettings.localAI, model) : new OpenAIProvider('fixture', 'gpt-6-sol', request, undefined, kind === 'subscription')
    const execute = vi.fn(async () => JSON.stringify({ path: 'spec.md', version: 'v1', content: 'Fixture', start: 1, end: 1, totalLines: 1 }))
    const tools: ProjectTools = { maxCalls: 1, maxRounds: 2, executionBudget: budget, assertAccess: vi.fn(), definitions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], parallelSafe: () => true, execute }
    const chunks = []
    for await (const chunk of provider.streamMessage([{ id: randomUUID(), role: 'user', content: 'Review fixture', status: 'complete', createdAt: 1 }], { context: { attachments: [], repositoryText: '', sources: [], projectTools: tools }, beforeModelRequest: () => { run.iterations++; budget.sync() } })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' }); expect(execute).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({ iterations: 2, toolCalls: 1 })
    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(bodies[1]).match(/tool_budget_deferred/g)).toHaveLength(2)
    if (kind === 'ollama') expect(bodies[1].tools).toBeUndefined()
    else expect(bodies[1].tool_choice).toEqual(kind === 'claude' ? { type: 'none' } : 'none')
  })
})
