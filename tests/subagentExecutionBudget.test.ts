// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { subagentDefaults, subagentRunSchema } from '../shared/subagents'
import { SubagentExecutionBudget } from '../electron/main/ai/subagentExecutionBudget'
const run = () => subagentRunSchema.parse({ id: randomUUID(), parentExecutionId: randomUUID(), conversationId: randomUUID(), taskId: randomUUID(), projectId: 'fixture', request: { taskKey: 'review', role: 'Reviewer', task: 'Read fixture', criteria: 'Review', files: ['spec.md'] }, status: 'running', model: 'gpt-6-sol', effort: 'medium', accountId: null, startedAt: 1, attempts: 1, iterations: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null })
const settings = { ...subagentDefaults(), maxIterations: 20, maxToolCalls: 60 }
const evidence = (start: number, end: number, version = 'v1') => JSON.stringify({ path: 'spec.md', version, content: 'Actual bounded fixture evidence', start, end, totalLines: 20 })
describe('child execution budget and evidence boundary', () => {
  it('inherits the configured 60/20 without hidden defaults, but preserves explicit 20/12 caps', () => {
    expect(new SubagentExecutionBudget(run(), settings).state).toMatchObject({ effectiveToolCalls: 60, effectiveIterations: 20, requestedToolCalls: null })
    const child = run(); child.request.maxToolCalls = 20; child.request.maxIterations = 12; child.toolCalls = 19
    const budget = new SubagentExecutionBudget(child, settings)
    expect(budget.state).toMatchObject({ configuredToolCalls: 60, requestedToolCalls: 20, effectiveToolCalls: 20, remainingToolCalls: 1, configuredIterations: 20, requestedIterations: 12, effectiveIterations: 12 })
    expect(budget.prepareRequest().finalize).toBe(false)
    budget.batchLimited(3, 1); budget.toolAttempt()
    expect(budget.prepareRequest().finalize).toBe(true)
    expect(child.toolCalls).toBe(20)
    expect(() => budget.toolAttempt()).toThrow('No tool was executed')
  })
  it('reserves the last iteration, never secretly adds one, and never resets on resume', () => {
    const child = run(), budget = new SubagentExecutionBudget(child, { ...settings, maxIterations: 2, maxToolCalls: 3 })
    child.iterations = 1
    expect(budget.prepareRequest()).toMatchObject({ finalize: true })
    expect(budget.state.finalization?.reason).toBe('iterations')
    child.iterations++; child.attempts++
    const resumed = new SubagentExecutionBudget(child, settings)
    expect(resumed.state).toMatchObject({ effectiveIterations: 2, effectiveToolCalls: 3, remainingIterations: 0 })
    expect(() => resumed.prepareRequest()).toThrow('No additional model request')
  })
  it('detects repeated/failed results, retains observations, and cannot run more exploration during finalization', () => {
    const child = run(), budget = new SubagentExecutionBudget(child, settings)
    budget.toolResult('read_file', '{}', evidence(1, 10))
    for (let i = 0; i < 4; i++) { budget.toolAttempt(); budget.toolResult('read_file', '{}', evidence(1, 10)) }
    expect(budget.state).toMatchObject({ repeatedResults: 4, noProgressCalls: 4, finalization: { reason: 'no_progress' } })
    expect(budget.prepareRequest().instruction).toContain('11-20')
    expect(child.observations).toHaveLength(5)
    expect(() => budget.toolAttempt()).toThrow('No tool was executed')
  })
  it('merges actual ranges, detects gaps and invalidates coverage on changed files', () => {
    const child = run(), budget = new SubagentExecutionBudget(child, settings)
    budget.toolResult('read_file', '{}', evidence(1, 5)); budget.toolResult('read_file', '{}', evidence(10, 20))
    expect(budget.coverageSummary()).toEqual([{ path: 'spec.md', missing: '6-9' }])
    budget.toolResult('read_file', '{}', evidence(6, 9))
    expect(budget.coverageSummary()[0].missing).toBe('none')
    budget.toolResult('read_file', '{}', evidence(1, 5, 'v2'))
    expect(budget.coverageSummary()[0].missing).toBe('6-20')
  })
  it('never certifies evicted evidence on resume or malformed/truncated serialized results', () => {
    const child = run(), budget = new SubagentExecutionBudget(child, settings)
    budget.toolResult('read_file', '{}', evidence(1, 20))
    child.observations = []; child.attempts++
    const resumed = new SubagentExecutionBudget(child, settings)
    resumed.toolResult('read_file', '{}', evidence(1, 20).slice(0, 30))
    expect(resumed.coverageSummary()[0].missing).toBe('not read')
    expect(child.fileVersions['spec.md']).toBe('v1')
  })
})
