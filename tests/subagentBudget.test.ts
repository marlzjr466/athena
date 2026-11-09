// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { subagentDefaults, subagentRunSchema } from '../shared/subagents'
import { SubagentBudgetLedger } from '../electron/main/ai/subagentBudget'
import { modelLimits } from '../shared/modelLimits'

const run = (tokenBudget?: number) => subagentRunSchema.parse({ id: randomUUID(), parentExecutionId: randomUUID(), conversationId: randomUUID(), taskId: randomUUID(), projectId: 'fixture',
  request: { taskKey: 'review', role: 'Cold-read reviewer', task: 'Review only fixture.md', criteria: 'Independent criteria', files: ['fixture.md'], tokenBudget },
  status: 'running', model: 'gpt-6-sol', effort: 'medium', accountId: null, startedAt: 1, attempts: 1, iterations: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null })
const metadata = (inputTokens: number, model = 'gpt-6-sol') => ({ inputTokens, inputEstimated: true, contextWindow: modelLimits(model).context, maxOutputTokens: modelLimits(model).output, limitsVerified: modelLimits(model).verified, outputLimitEnforced: false })

describe('child request reservation and consumption accounting', () => {
  it('inherits Settings by default but exposes and respects a lower child allocation', () => {
    expect(new SubagentBudgetLedger(run(), subagentDefaults()).state).toMatchObject({ configuredTokens: 250000, requestedTokens: null, effectiveTokens: 250000, remainingTokens: 250000 })
    expect(new SubagentBudgetLedger(run(12000), subagentDefaults()).state).toMatchObject({ configuredTokens: 250000, requestedTokens: 12000, effectiveTokens: 12000, remainingTokens: 12000 })
  })
  it('releases unused output reserve in the 8018/12000 reproduction without raising its cap', () => {
    const child = run(12000), budget = new SubagentBudgetLedger(child, subagentDefaults())
    budget.reserve(11766, 4096, metadata(3922))
    expect(budget.state).toMatchObject({ consumedTokens: 0, reservedInput: 3922, reservedOutput: 4096, availableTokens: 3982 })
    budget.settle({ inputTokens: 2600, outputTokens: 500, reasoningTokens: 300, estimated: false })
    expect(budget.state).toMatchObject({ consumedTokens: 3100, remainingTokens: 8900, reservedOutput: 0, reasoningTokens: 300 })
    // Previously: 8018 + 4500 + 4096 > 12000. Actual settlement now fits.
    expect(() => budget.reserve(13500, 4096, metadata(4500))).not.toThrow()
    budget.settle({ inputTokens: 4500, outputTokens: 1000, estimated: false })
    expect(child.inputTokens + child.outputTokens).toBe(8600)
    expect(budget.state.effectiveTokens).toBe(12000)
  })
  it('settles four Luna responses instead of permanently charging 54803 reserved tokens', () => {
    const budget = new SubagentBudgetLedger(run(60000), subagentDefaults())
    const estimated = [4000, 8500, 12000, 13919], measured = [3500, 7000, 8500, 9500]
    expect(estimated.reduce((sum, input) => sum + input + 4096, 0)).toBe(54803)
    for (let i = 0; i < 4; i++) {
      budget.reserve(estimated[i] * 3, 4096, metadata(estimated[i], 'gpt-5.6-luna'))
      budget.settle({ inputTokens: measured[i], outputTokens: 250, reasoningTokens: 150, estimated: false })
    }
    expect(budget.state.consumedTokens).toBe(29500)
    expect(() => budget.reserve(48000, 4096, metadata(16000, 'gpt-5.6-luna'))).not.toThrow()
    expect(budget.state.effectiveTokens).toBe(60000)
  })
  it('counts input/tool evidence on each request and reasoning only once within output', () => {
    const budget = new SubagentBudgetLedger(run(), subagentDefaults())
    for (let i = 0; i < 2; i++) {
      budget.reserve(3000, 4096, metadata(1000))
      budget.settle({ inputTokens: 1000, outputTokens: 600, reasoningTokens: 500, estimated: false })
      budget.settle({ inputTokens: 1000, outputTokens: 600, reasoningTokens: 500, estimated: false }) // Duplicate ignored.
    }
    expect(budget.state).toMatchObject({ consumedTokens: 3200, measuredInput: 2000, measuredOutput: 1200, reasoningTokens: 1000, settledRequests: 2 })
  })
  it('keeps bounded conservative estimates when usage is missing or a request is interrupted', () => {
    const child = run(), budget = new SubagentBudgetLedger(child, subagentDefaults())
    budget.reserve(3000, 4096)
    budget.settle({ inputTokens: 1000, outputTokens: 20, estimated: true })
    budget.reserve(4500, 4096)
    budget.interrupted(); budget.interrupted()
    expect(budget.state).toMatchObject({ consumedTokens: 10692, unknownRequests: 2, reservedOutput: 0, measuredOutput: 0 })
    expect(new SubagentBudgetLedger(child, subagentDefaults()).state.consumedTokens).toBe(10692)
  })
  it('preserves consumption and the original effective cap across resume and Settings changes', () => {
    const child = run(), budget = new SubagentBudgetLedger(child, { ...subagentDefaults(), tokenBudget: 60000 })
    budget.reserve(3000, 4096); budget.settle({ inputTokens: 1000, outputTokens: 500, estimated: false })
    const resumed = new SubagentBudgetLedger(child, subagentDefaults())
    expect(resumed.state).toMatchObject({ configuredTokens: 250000, effectiveTokens: 60000, consumedTokens: 1500 })
  })
  it('preserves unreconstructable legacy counters and does not claim they were measured', () => {
    const child = run(60000); child.inputTokens = 38419; child.outputTokens = 16384
    const budget = new SubagentBudgetLedger(child, subagentDefaults())
    expect(budget.state).toMatchObject({ consumedTokens: 54803, estimatedInput: 38419, legacyEstimate: true, remainingTokens: 5197 })
    expect(() => budget.reserve(30000, 4096)).toThrow('child allocation 60000')
    expect(budget.state.termination?.code).toBe('total_tokens')
  })
  it('distinguishes context limits, model fallback limits and total lifetime exhaustion', () => {
    const budget = new SubagentBudgetLedger(run(), subagentDefaults())
    expect(() => budget.reserve(65000, 4096, metadata(22000))).toThrow('context limit')
    expect(budget.state).toMatchObject({ effectiveContext: 24000, consumedTokens: 0 })
    const unknown = new SubagentBudgetLedger(run(), subagentDefaults())
    expect(() => unknown.reserve(45000, 4096, metadata(15000, 'unknown-provider-model'))).toThrow('16384')
    expect(unknown.state.modelLimitsVerified).toBe(false)
    const limited = new SubagentBudgetLedger(run(12000), subagentDefaults())
    expect(() => limited.reserve(27000, 4096, metadata(9000))).toThrow('Next request needs 9000 input + 4096 output reserve')
    expect(limited.state).toMatchObject({ consumedTokens: 0, termination: { code: 'total_tokens' } })
  })
  it('stops honestly if provider-managed output exceeds a reservation and the total cap', () => {
    const budget = new SubagentBudgetLedger(run(12000), subagentDefaults())
    budget.reserve(9000, 4096, metadata(3000))
    expect(() => budget.settle({ inputTokens: 3000, outputTokens: 10000, reasoningTokens: 9000, estimated: false })).toThrow('provider-reported usage')
    expect(budget.state).toMatchObject({ consumedTokens: 13000, reservedOutput: 0, remainingTokens: 0, reasoningTokens: 9000 })
  })
})
