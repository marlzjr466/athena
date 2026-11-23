// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { subagentContextAllocation } from '../shared/subagentContext'
import { subagentDefaults, subagentSettingsSchema, subagentRunSchema } from '../shared/subagents'
import { SubagentBudgetLedger } from '../electron/main/ai/subagentBudget'
import { fitProtocolContext, protocolTokens, type ContextProtocol } from '../electron/main/ai/protocolContext'
import { contextDefaults } from '../shared/context'
const limits = { contextWindow: 1_050_000, maxOutputTokens: 128000, source: 'reported' as const }
const child = () => subagentRunSchema.parse({ id: randomUUID(), parentExecutionId: randomUUID(), conversationId: randomUUID(), taskId: randomUUID(), projectId: 'fixture', request: { taskKey: 'review', role: 'Reviewer', task: 'Review', criteria: 'Evidence', files: ['spec.md'] }, status: 'running', model: 'fixture', effort: 'max', accountId: null, startedAt: 1, attempts: 1, iterations: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null })
describe('model-aware child context allocation', () => {
  it.each([32000, 64000, 128000, 256000, 512000, 721234])('accepts %i within reported capacity independently of total consumption', contextTokens => {
    expect(subagentSettingsSchema.parse({ contextTokens, tokenBudget: 8000 }).contextTokens).toBe(contextTokens)
    expect(subagentContextAllocation(contextTokens, limits).effective).toBe(contextTokens)
  })
  it('enforces the tightest capacity, safety, payload, task and saved ceilings', () => {
    expect(subagentContextAllocation(512000, { ...limits, runtimeContextWindow: 128000 }).effective).toBe(108800)
    expect(subagentContextAllocation(512000, { ...limits, maxRequestBytes: 500000 }).effective).toBe(106250)
    expect(subagentContextAllocation(512000, limits, .15, 64000, 32000).effective).toBe(32000)
    expect(subagentContextAllocation(512000)).toMatchObject({ effective: 13926, modelContext: null, verified: false })
    expect(subagentSettingsSchema.safeParse({ contextTokens: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
  })
  it('retains cumulative receipts and frozen capacity after serialization and resume', () => {
    const run = child(), settings = { ...subagentDefaults(), contextTokens: 128000 }
    const ledger = new SubagentBudgetLedger(run, settings); ledger.configureContext(limits, .15)
    ledger.reserve(3000, 4096); ledger.settle({ inputTokens: 900, outputTokens: 100, estimated: false })
    const restored = subagentRunSchema.parse(JSON.parse(JSON.stringify(run)))
    const resumed = new SubagentBudgetLedger(restored, { ...settings, contextTokens: 512000, tokenBudget: 500000 }); resumed.configureContext(limits, .05)
    expect(resumed.state).toMatchObject({ configuredContext: 128000, effectiveContext: 128000, contextSafetyMargin: .15, consumedTokens: 1000, effectiveTokens: 250000 })
    expect(() => resumed.reserve(127000 * 3, 4096)).toThrow(/per-request limit/)
  })
  it('keeps context exhaustion distinct from lifetime consumption', () => {
    const ledger = new SubagentBudgetLedger(child(), { ...subagentDefaults(), contextTokens: 512000, tokenBudget: 8000 }); ledger.configureContext(limits, .15)
    ledger.reserve(9000, 4096); ledger.settle({ inputTokens: 3000, outputTokens: 1000, estimated: false })
    expect(() => ledger.reserve(9000, 4096)).toThrow(/token budget reached/)
    expect(ledger.state.effectiveContext).toBe(512000)
  })
})
describe('local child compaction before budget admission', () => {
  it.each(['responses', 'chat', 'anthropic', 'gemini', 'bedrock', 'ollama'] satisfies ContextProtocol[])('%s compacts old evidence preserving IDs, instructions and recent results', protocol => {
    const text = 'Source evidence. '.repeat(12000)
    const old = protocol === 'responses' ? { type: 'function_call_output', call_id: 'call-1', output: text }
      : protocol === 'anthropic' ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: text }] }
      : protocol === 'gemini' ? { role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'read_file', response: { output: text } } }] }
      : protocol === 'bedrock' ? { role: 'user', content: [{ toolResult: { toolUseId: 'call-1', content: [{ text }] } }] }
      : { role: 'tool', tool_call_id: 'call-1', content: text }
    const entries = [old, { role: 'user', content: 'Required ticket instructions' }, { role: 'tool', content: 'Recent verified result' }]
    const original = structuredClone(entries)
    expect(protocolTokens(entries) + 4096).toBeGreaterThan(64000)
    fitProtocolContext(entries, protocol, { system: 'Respect scope', tools: ['read_file'] }, { requestContextBudget: 64000, contextSettings: contextDefaults() }, 1050000, 4096)
    expect(protocolTokens(entries) + 4096).toBeLessThan(64000)
    expect(JSON.stringify(entries)).toContain('call-1'); expect(entries.slice(-2)).toEqual(original.slice(-2))
    expect(JSON.stringify(original)).toContain(text)
  })
  it('returns an actionable failure when pinned context cannot fit; no request is admitted', () => {
    expect(() => fitProtocolContext([{ role: 'user', content: 'Explicit attachment'.repeat(50000) }], 'chat', {}, { requestContextBudget: 64000 }, 1050000, 4096)).toThrow(/Essential instructions, attachments and recent tool batches were retained/)
  })
})
