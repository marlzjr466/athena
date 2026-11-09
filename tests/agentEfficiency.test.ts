// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AgentEfficiencyTracker } from '../electron/main/ai/agentEfficiency'

describe('agent execution efficiency', () => {
  it('classifies actual rounds and calls without treating repeated reads as discovery', () => {
    const tracker = new AgentEfficiencyTracker(6)
    const read = JSON.stringify({ path: 'src/app.ts', version: 'unchanged', content: 'source' })
    tracker.observe('read_file', '{"path":"src/app.ts"}', read)
    tracker.round(['read_file'], 10)
    for (let index = 0; index < 4; index++) tracker.observe('read_file', '{"path":"src/app.ts"}', read)
    expect(tracker.warning).toContain('no new evidence')
    expect(tracker.shouldStop).toBe(false)
    tracker.observe('read_file', '{"path":"src/app.ts"}', read)
    tracker.observe('read_file', '{"path":"src/app.ts"}', read)
    expect(tracker.shouldStop).toBe(true)
    const summary = tracker.finish(2)
    expect(summary).toMatchObject({ iterations: 1, toolCalls: 7, repeatedReads: 6, compactionAttempts: 2 })
    expect(summary.phases.exploration).toMatchObject({ iterations: 1, toolCalls: 7, durationMs: 10 })
  })
  it('resets a stalled run after a verified mutation and distinguishes failures', () => {
    const tracker = new AgentEfficiencyTracker(6)
    for (let index = 0; index < 5; index++) tracker.observe('search_code', '{"query":"same"}', '{"matches":[]}')
    expect(tracker.warning).toBeDefined()
    tracker.observe('edit_file', '{"path":"app.ts"}', '{"result":{"ok":true,"changes":[{"status":"applied"}]}}')
    expect(tracker.warning).toBeUndefined()
    tracker.observe('run_tests', '{}', '{"result":{"exitCode":1}}')
    tracker.round(['edit_file', 'run_tests'], 20)
    expect(tracker.finish()).toMatchObject({ successfulModifications: 1, failedOperations: 1, repeatedSearches: 4,
      phases: { implementation: { iterations: 1, toolCalls: 1 }, verification: { toolCalls: 1 } } })
  })
  it('allows fresh verification evidence after safe context compaction', () => {
    const tracker = new AgentEfficiencyTracker(6)
    tracker.observe('read_file', '{"path":"app.ts"}', '{"content":"before"}')
    for (let index = 0; index < 4; index++) tracker.observe('read_file', '{"path":"app.ts"}', '{"content":"before"}')
    expect(tracker.warning).toBeDefined()
    tracker.contextReset()
    expect(tracker.warning).toBeUndefined()
    tracker.observe('read_file', '{"path":"app.ts"}', '{"content":"before"}')
    expect(tracker.shouldStop).toBe(false)
  })
})
