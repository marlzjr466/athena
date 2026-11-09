import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentActivity, AgentDuration, AgentTimeline } from '../src/features/chat/AgentActivity'
import type { AgentExecution } from '../shared/agent'
import { subagentRunSchema } from '../shared/subagents'
import { SubagentBudgetLedger } from '../electron/main/ai/subagentBudget'
import { SubagentExecutionBudget } from '../electron/main/ai/subagentExecutionBudget'
import { subagentDefaults } from '../shared/subagents'
import { useChat } from '../src/store/chatStore'

afterEach(() => vi.useRealTimers())

describe('inline live agent activity', () => {
  it('nests real child operations and exposes structured findings and individual cancellation', async () => {
    const child = subagentRunSchema.parse({ id: '11111111-1111-4111-8111-111111111111', parentExecutionId: '22222222-2222-4222-8222-222222222222', conversationId: '33333333-3333-4333-8333-333333333333', projectId: 'project', taskId: '44444444-4444-4444-8444-444444444444', request: { taskKey: 'review', role: 'Cold-read reviewer', task: 'Review the specification', criteria: 'Exit criteria', files: ['spec.md'] }, status: 'running', model: 'gpt-5-mini', effort: 'high', accountId: null, startedAt: 1, attempts: 1, iterations: 1, toolCalls: 1, inputTokens: 1000, outputTokens: 200, estimatedCostUsd: null })
    const command = vi.fn(async () => true), previous = useChat.getState().command
    useChat.setState({ command, pending: false })
    try {
      const execution: AgentExecution = { startedAt: 1, updatedAt: 3, status: 'working', activities: [
        { id: 'worker', tool: 'spawn_subagent', label: 'Sub-agent · Cold-read reviewer', startedAt: 1, status: 'running', subagent: child },
        { id: 'child-read', parentActivityId: 'worker', tool: 'read_file', label: 'Read · spec.md', startedAt: 2, status: 'complete', summary: 'Actual artifact read' },
      ] }
      const view = render(<AgentTimeline execution={execution} sessionId={child.conversationId} fallbackText="Sending the artifact for independent review." />)
      expect(screen.getByText('Sending the artifact for independent review.')).toBeVisible()
      const section = document.querySelector('.agent-inline-activity-group') as HTMLDetailsElement
      expect(section).toHaveTextContent('1 operation'); expect(section).toHaveTextContent('1 sub-agent'); expect(section.open).toBe(false)
      fireEvent.click(section.querySelector('summary')!)
      await waitFor(() => expect(section.querySelectorAll('.agent-inline-activity-operations > li')).toHaveLength(1))
      expect(screen.getByLabelText('Sub-agent: Cold-read reviewer (running)')).toBeVisible()
      fireEvent.click(screen.getByLabelText('Sub-agent: Cold-read reviewer (running)'))
      expect(await screen.findByText(/Legacy budgeted estimate: 1,200/)).toBeVisible()
      const budget = new SubagentBudgetLedger(child, subagentDefaults())
      budget.reserve(3000, 4096)
      child.request.maxToolCalls = 20; child.request.maxIterations = 12
      const limits = new SubagentExecutionBudget(child, { ...subagentDefaults(), maxToolCalls: 60, maxIterations: 20 })
      limits.batchLimited(3, 1)
      view.rerender(<AgentTimeline execution={{ ...execution }} sessionId={child.conversationId} fallbackText="Sending the artifact for independent review." />)
      expect(screen.getByLabelText('Sub-agent token budget')).toHaveTextContent('Configured 250,000')
      expect(screen.getByLabelText('Sub-agent token budget')).toHaveTextContent('Consumed 1,200 · Remaining 248,800 · Reserved for active request 5,096')
      expect(screen.getByLabelText('Sub-agent token budget')).toHaveTextContent('includes preserved legacy estimates')
      expect(screen.getByLabelText('Sub-agent execution limits')).toHaveTextContent('Tool calls: Settings 60 · Task / workflow cap 20 · Effective 20 · Consumed 1 · Remaining 19')
      expect(screen.getByLabelText('Sub-agent execution limits')).toHaveTextContent('Iterations: Settings 20 · Task / workflow cap 12 · Effective 12 · Consumed 1 · Remaining 11')
      expect(screen.getByLabelText('Sub-agent execution limits')).toHaveTextContent('Limited batch: 3 requested · 1 admitted · 2 not executed')
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel this sub-agent' }))
      expect(command).toHaveBeenCalledWith({ action: 'cancel-subagent', id: child.conversationId, subagentId: child.id })
      fireEvent.click(screen.getByText('Child operations · 1'))
      expect(await screen.findByLabelText('Read: spec.md (complete)')).toBeVisible()
      view.rerender(<AgentTimeline execution={{ ...execution, status: 'complete', activities: [{ ...execution.activities[0], status: 'complete', subagent: { ...child, status: 'completed', result: { status: 'completed', assessment: 'FAIL', summary: 'One ambiguity found.', findings: [{ severity: 'warning', description: 'Missing empty-state wording', evidence: ['spec.md:2'] }], blockers: [], evidence: [], filesReviewed: ['spec.md'], checksPerformed: ['Read artifact'], limitations: ['No backend contract'], nextActions: ['Clarify the state'] }, rawResponse: '{"status":"blocked","assessment":"FAIL"}', resultDiagnostics: { candidateCount: 1, validationErrors: [], missingFields: [], terminationReason: 'parsed_incomplete' } } }, execution.activities[1]] }} sessionId={child.conversationId} />)
      expect(screen.getByText('One ambiguity found.')).toBeVisible()
      expect(screen.getAllByText(/Missing empty-state wording/).length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('Result diagnostics')).toBeVisible()
      expect(screen.getByText('Raw child response')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Cancel this sub-agent' })).toBeNull()
      expect(document.querySelectorAll('.agent-inline-activity-group')).toHaveLength(1)
    } finally { useChat.setState({ command: previous }) }
  })
  it('shows a reconnect state and opens the execution Activity section for review', async () => {
    const execution: AgentExecution = { startedAt: 1, updatedAt: 2, finishedAt: 2, status: 'waiting-auth', activities: [{ id: 'read', tool: 'read_file', label: 'Read · app.ts', startedAt: 1, status: 'complete' }], timeline: [{ id: 'event', kind: 'activity', activityId: 'read', createdAt: 1 }] }
    render(<><AgentTimeline execution={execution} /><AgentActivity execution={execution} /></>)
    expect(screen.getByText('Execution paused — ChatGPT connection expired')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Reconnect account' })).toBeVisible()
    const section = document.querySelector('.agent-inline-activity-group') as HTMLDetailsElement
    expect(section.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Review completed work' }))
    await waitFor(() => expect(section.open).toBe(true))
  })

  it('renders progress, its operation interval, and later progress in order with output collapsed', async () => {
    const execution: AgentExecution = { startedAt: 1, updatedAt: 3, status: 'working', activities: [{ id: 'command', tool: 'run_tests', label: 'npm test', startedAt: 2, status: 'running', fullOutput: 'PASS src/App.test.tsx\n' }], timeline: [
      { id: 'first', kind: 'text', createdAt: 1, text: 'I am checking the tests.' },
      { id: 'second', kind: 'activity', createdAt: 2, activityId: 'command' },
      { id: 'third', kind: 'text', createdAt: 3, text: 'I will review the result.' },
    ] }
    const view = render(<AgentTimeline execution={execution} />)
    const timeline = screen.getByLabelText('Live agent progress')
    expect(timeline.querySelectorAll('.agent-inline-activity-group')).toHaveLength(1)
    expect(timeline.textContent?.indexOf('I am checking')).toBeLessThan(timeline.textContent?.indexOf('Ran command') ?? 0)
    expect(timeline.textContent?.indexOf('Ran command')).toBeLessThan(timeline.textContent?.indexOf('I will review') ?? 0)
    const activityGroup = timeline.querySelector('.agent-inline-activity-group') as HTMLDetailsElement
    expect(activityGroup.open).toBe(false)
    fireEvent.click(activityGroup.querySelector(':scope > summary')!)
    await waitFor(() => expect(activityGroup.open).toBe(true))
    const operation = screen.getByLabelText('Terminal: npm test (running)')
    expect(operation).toBeVisible()
    expect(operation.closest('details')?.open).toBe(false)
    fireEvent.click(operation)
    const outputSummary = screen.getByText(/Output ·/)
    expect(outputSummary.closest('details')?.open).toBe(false)
    fireEvent.click(outputSummary)
    await waitFor(() => expect(screen.getByText('PASS src/App.test.tsx')).toBeVisible())

    view.rerender(<AgentTimeline execution={{ ...execution, status: 'complete', activities: [{ ...execution.activities[0], status: 'complete', finishedAt: 4, summary: 'Exit 0' }] }} />)
    expect(timeline.querySelectorAll('.agent-inline-activity-group')).toHaveLength(1)
    expect(activityGroup.open).toBe(true)
    expect(timeline.querySelector('.agent-timeline-state.complete')).toBeNull()
  })

  it('updates the same inline group as events stream, preserves expansion, and keeps errors inside the collapsed activity details', async () => {
    const first: AgentExecution = { startedAt: 50, updatedAt: 60, status: 'working', activities: [
      { id: 'read', tool: 'read_file', label: 'Read · src/a.ts', startedAt: 51, status: 'complete' },
      { id: 'terminal', tool: 'run_tests', label: 'Terminal · npm test', startedAt: 52, status: 'running', fullOutput: 'running' },
    ], timeline: [{ id: 'e1', kind: 'activity', activityId: 'read', createdAt: 51 }, { id: 'e2', kind: 'activity', activityId: 'terminal', createdAt: 52 }] }
    const view = render(<AgentTimeline execution={first} />)
    const section = document.querySelector('.agent-inline-activity-group') as HTMLDetailsElement
    expect(section.open).toBe(false)
    expect(section).toHaveTextContent('2 operations')
    expect(section).toHaveTextContent('Read file')
    expect(section).toHaveTextContent('Ran command')

    const second: AgentExecution = { ...first, updatedAt: 70, activities: [...first.activities, { id: 'edit', tool: 'edit_file', label: 'Edit · src/a.ts', startedAt: 53, status: 'error', summary: 'Write was rejected' }], timeline: [...first.timeline!, { id: 'e3', kind: 'activity', activityId: 'edit', createdAt: 53 }] }
    view.rerender(<AgentTimeline execution={second} />)
    expect(document.querySelectorAll('.agent-inline-activity-group')).toHaveLength(1)
    expect(section).toHaveTextContent('3 operations')
    expect(section).toHaveTextContent('1 failed')
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(section.querySelector(':scope > summary')!)
    await waitFor(() => expect(section.open).toBe(true))
    expect(section.querySelectorAll('.agent-inline-activity-operations > li')).toHaveLength(3)
    const failedOperation = screen.getByLabelText('Edit: src/a.ts (error)')
    expect(failedOperation).toBeVisible()
    expect(screen.queryByText('Write was rejected')).toBeNull()
    fireEvent.click(failedOperation)
    expect(screen.getByText('Write was rejected')).toBeVisible()
    const third: AgentExecution = { ...second, updatedAt: 80, activities: [...second.activities, { id: 'explore', tool: 'get_project_structure', label: 'Explore · project structure', startedAt: 54, status: 'complete' }], timeline: [...second.timeline!, { id: 'e4', kind: 'activity', activityId: 'explore', createdAt: 54 }] }
    view.rerender(<AgentTimeline execution={third} />)
    expect(section.open).toBe(true)
    expect(section).toHaveTextContent('4 operations')
    expect(section.querySelectorAll('.agent-inline-activity-operations > li')).toHaveLength(4)
  })

  it('shows only successful file mutations in the inline change summary', async () => {
    const execution: AgentExecution = { startedAt: 1, updatedAt: 3, status: 'complete', activities: [{ id: 'edit', tool: 'create_file', label: 'src/App.tsx', startedAt: 2, status: 'complete', changes: [
      { id: 'applied', path: 'src/App.tsx', status: 'applied', diff: '--- /dev/null\n+++ src/App.tsx\n@@ -1,0 +1,1 @@\n+export {}' },
      { id: 'proposed', path: 'src/Other.tsx', status: 'proposed', diff: '--- /dev/null\n+++ src/Other.tsx\n@@ -1,0 +1,1 @@\n+proposed' },
    ] }], timeline: [{ id: 'event', kind: 'activity', createdAt: 2, activityId: 'edit' }] }
    render(<AgentTimeline execution={execution} />)
    expect(screen.getByText(/Final combined changes · 1 file/)).toBeVisible()
    expect(screen.getByText(/Final combined changes · 1 file/).closest('details')?.open).toBe(false)
    const section = document.querySelector('.agent-inline-activity-group') as HTMLDetailsElement
    expect(section).toHaveTextContent('Created file')
    expect(section.querySelector(':scope > summary')).toHaveTextContent('+1')
    expect(section.querySelector(':scope > summary')).toHaveTextContent('−0')
    fireEvent.click(section.querySelector(':scope > summary')!)
    await waitFor(() => expect(section.querySelectorAll('.agent-inline-activity-operations > li')).toHaveLength(1))
    const operationSummary = section.querySelector('.agent-timeline-operation > summary')!
    expect(operationSummary.closest('details')?.open).toBe(false)
    fireEvent.click(operationSummary)
    expect(section).toHaveTextContent('src/App.tsx')
    expect(section).toHaveTextContent('src/Other.tsx')
    expect(section).toHaveTextContent('+1')
    expect(section).toHaveTextContent('−0')
    fireEvent.click(section.querySelector('.agent-change > summary')!)
    expect(await screen.findByLabelText('diff code')).toHaveTextContent('+export {}')
    expect(screen.getByRole('button', { name: 'Revert this file' })).toBeVisible()
  })

  it('keeps saved command logs supplementary and preserves the running timer lifecycle', () => {
    render(<AgentActivity execution={{ startedAt: 1, updatedAt: 4, status: 'complete', activities: [
      { id: 'status', tool: 'git_status', label: 'git --no-pager status --short', startedAt: 1, status: 'complete', fullOutput: 'clean' },
      { id: 'tests', tool: 'run_tests', label: 'npm run test', startedAt: 2, status: 'complete', fullOutput: 'PASS' },
    ] }} />)
    expect(screen.getByText('Saved Command Log · 2 commands')).toBeVisible()
    expect(screen.queryByText('git --no-pager status --short')).not.toBeInTheDocument()
  })
  it('shows recovery state and an exportable sanitized connection report without response content', () => {
    const execution: AgentExecution = { startedAt: 1, updatedAt: 2, status: 'working', streamPhase: 'recovering', activities: [],
      streamDiagnostics: [{ provider: 'chatgpt-subscription', model: 'gpt-6-sol', executionId: 'task-1', correlationId: '11111111-1111-4111-8111-111111111111',
        round: 3, stage: 'response_stream', kind: 'unexpected_eof', durationMs: 1500, completedTools: 105, fileChanges: 20, recoveryAttempt: 1, willRetry: true, abortReason: 'none' }],
    }
    render(<AgentActivity execution={execution} />)
    expect(screen.getByText('Reconnecting to ChatGPT from the last checkpoint…')).toBeVisible()
    fireEvent.click(screen.getByText('Connection diagnostics · 1 event'))
    expect(screen.getByRole('button', { name: 'Copy sanitized report' })).toBeVisible()
    expect(document.querySelector('.agent-stream-diagnostics')).toHaveTextContent('"completedTools": 105')
    expect(document.querySelector('.agent-stream-diagnostics')).toHaveTextContent('"fileChanges": 20')
  })

  it('uses real elapsed timestamps, preserves timers across operations and freezes on completion', () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000)
    const execution: AgentExecution = { startedAt: 100_000, updatedAt: 100_000, status: 'working', activities: [] }
    const view = render(<><AgentDuration execution={execution} /><AgentActivity execution={execution} /></>)
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByRole('timer')).toHaveTextContent('Working for 5s')
    view.rerender(<><AgentDuration execution={execution} /><AgentActivity execution={{ ...execution, recovery: { attempts: 1, continuing: true, reason: 'max_output_tokens', outputBudget: 65536, effort: 'low', pendingTools: [] } }} /></>)
    expect(screen.getByText(/Continuing task/)).toBeInTheDocument()
    expect(screen.getByRole('timer')).toHaveTextContent('Working for 5s')
    expect(vi.getTimerCount()).toBe(1)
    view.rerender(<><AgentDuration execution={execution} /><AgentActivity execution={{ ...execution, activities: [{ id: 'read', tool: 'read_file', label: 'Read app.ts', startedAt: 105_000, status: 'complete' }] }} /></>)
    act(() => { vi.setSystemTime(189_000); vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('timer')).toHaveTextContent('Working for 1m 30s')
    view.rerender(<><AgentDuration execution={{ ...execution, status: 'complete', finishedAt: 190_000 }} /><AgentActivity execution={{ ...execution, status: 'complete', finishedAt: 190_000 }} /></>)
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole('timer')).toHaveTextContent('Worked for 1m and 30s')
    expect(vi.getTimerCount()).toBe(0)
  })
})
