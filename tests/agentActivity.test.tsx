import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentActivity, AgentDuration, AgentTimeline } from '../src/features/chat/AgentActivity'
import type { AgentExecution } from '../shared/agent'
import { subagentRunSchema } from '../shared/subagents'
import { SubagentBudgetLedger } from '../electron/main/ai/subagentBudget'
import { SubagentExecutionBudget } from '../electron/main/ai/subagentExecutionBudget'
import { subagentDefaults } from '../shared/subagents'
import { useChat } from '../src/store/chatStore'
import { mutationFileSummary, normalizeActivityFileIdentity, timelineBlocks } from '../src/features/chat/agentTimelinePresentation'

afterEach(() => vi.useRealTimers())

describe('inline live agent activity', () => {
  it('shows automatic, manual, and rejected permission decisions without adding tool operations', () => {
    const execution: AgentExecution = { startedAt: 1, updatedAt: 4, status: 'complete', activities: [], permissionDecisions: [
      { id: '11111111-1111-4111-8111-111111111111', title: 'Edit file', decision: 'automatic', at: 1 },
      { id: '22222222-2222-4222-8222-222222222222', title: 'Read sensitive file', decision: 'manual', at: 2 },
      { id: '33333333-3333-4333-8333-333333333333', title: 'Capture screen', decision: 'rejected', at: 3 },
    ] }
    render(<AgentTimeline execution={execution} />)
    const history = screen.getByText(/Permissions · 1 automatically approved · 1 manually approved · 1 rejected/)
    fireEvent.click(history)
    fireEvent.click(screen.getByText('Permissions', { selector: '.agent-timeline-kind' }))
    expect(screen.getByText(/Edit file · Automatically approved/)).toBeInTheDocument()
    expect(screen.getByText(/Read sensitive file · Manually approved/)).toBeInTheDocument()
    expect(screen.getByText(/Capture screen · Rejected/)).toBeInTheDocument()
    expect(document.querySelectorAll('.agent-inline-activity-operation')).toHaveLength(0)
  })
  it('shows unique edited files separately from the operation count for the reported 17-edit scenario', () => {
    const paths = ['docs/tickets/MBM-11761/tmp/define.md', 'docs/tickets/MBM-11761/tmp/tds-miniapp-register.md', 'docs/tickets/MBM-11761/events.yaml']
    const activities = Array.from({ length: 17 }, (_, index) => ({ id: `edit-${index}`, tool: 'edit_file', label: `Edit · /workspace/${paths[index < 6 ? 0 : index < 16 ? 1 : 2]}`, startedAt: index + 1, status: 'complete' as const }))
    const execution: AgentExecution = { startedAt: 1, updatedAt: 20, status: 'complete', activities }
    render(<AgentTimeline execution={execution} />)
    const group = document.querySelector('.agent-inline-activity-group')!
    expect(group.querySelector('.agent-inline-activity-summary')).toHaveTextContent('Edited 3 files')
    expect(group.querySelector('.agent-inline-operation-count')).toHaveTextContent('17 operations')
  })

  it('counts repeated operations on one file once and keeps distinct directories separate', () => {
    const repeated = Array.from({ length: 10 }, (_, index) => ({ id: `repeat-${index}`, tool: 'edit_file', label: 'Edit · src/shared.ts', startedAt: index, status: 'complete' as const }))
    expect(mutationFileSummary(repeated, '/workspace').fileCount).toBe(1)
    const separate = [
      { id: 'one', tool: 'edit_file', label: 'Edit · src/one/index.ts', startedAt: 1, status: 'complete' as const },
      { id: 'two', tool: 'edit_file', label: 'Edit · src/two/index.ts', startedAt: 2, status: 'complete' as const },
    ]
    expect(mutationFileSummary(separate, '/workspace').fileCount).toBe(2)
    expect(normalizeActivityFileIdentity('src/one/index.ts', '/workspace')).not.toBe(normalizeActivityFileIdentity('src/two/index.ts', '/workspace'))
  })

  it('resolves relative and absolute references to the same workspace file', () => {
    expect(normalizeActivityFileIdentity('./docs/../src/app.ts', '/workspace/project')).toBe(normalizeActivityFileIdentity('/workspace/project/src/app.ts'))
  })

  it('counts edits from multiple agents to one target as one unique file', () => {
    const activities: AgentExecution['activities'] = [
      { id: 'parent-edit', tool: 'edit_file', label: 'Edit · src/app.ts', startedAt: 1, status: 'complete' },
      { id: 'child-edit', parentActivityId: 'worker', tool: 'apply_patch', label: 'Patch · ./src/app.ts', startedAt: 2, status: 'complete' },
    ]
    expect(mutationFileSummary(activities, '/workspace').fileCount).toBe(1)
  })

  it('includes completed child-agent edits in the activity group without duplicating file identities', () => {
    const execution: AgentExecution = { startedAt: 1, updatedAt: 4, status: 'complete', activities: [
      { id: 'delegate', tool: 'spawn_subagent', label: 'Sub-agent · reviewer', startedAt: 1, status: 'complete' },
      { id: 'child-a', parentActivityId: 'delegate', tool: 'edit_file', label: 'Edit · src/shared.ts', startedAt: 2, status: 'complete' },
      { id: 'child-b', parentActivityId: 'delegate', tool: 'edit_file', label: 'Edit · /workspace/src/shared.ts', startedAt: 3, status: 'complete' },
    ], timeline: [{ id: 'event', kind: 'activity', activityId: 'delegate', createdAt: 1 }] }
    render(<AgentTimeline execution={execution} workspaceRoot="/workspace" />)
    const group = document.querySelector('.agent-inline-activity-group')!
    expect(group.querySelector('.agent-inline-activity-summary')).toHaveTextContent('Edited 1 file')
    expect(group.querySelector('.agent-inline-operation-count')).toHaveTextContent('3 operations')
  })

  it('excludes failed edits from successful file counts', () => {
    const activities: AgentExecution['activities'] = [{ id: 'failed', tool: 'edit_file', label: 'Edit · src/failed.ts', startedAt: 1, status: 'error' }]
    expect(mutationFileSummary(activities, '/workspace').fileCount).toBe(0)
  })

  it('counts creating then editing a file as one unique changed file', () => {
    const activities: AgentExecution['activities'] = [
      { id: 'create', tool: 'create_file', label: 'Create · src/new.ts', startedAt: 1, status: 'complete' },
      { id: 'edit', tool: 'edit_file', label: 'Edit · /workspace/src/new.ts', startedAt: 2, status: 'complete' },
    ]
    expect(mutationFileSummary(activities, '/workspace').fileCount).toBe(1)
  })

  it('treats a successful file move source and destination as the same file identity', () => {
    const activities: AgentExecution['activities'] = [{ id: 'move', tool: 'move_file', label: 'Move · src/old.ts', startedAt: 1, status: 'complete', changes: [
      { id: 'source', path: 'src/old.ts', status: 'applied', diff: '--- src/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old' },
      { id: 'destination', path: 'lib/new.ts', status: 'applied', diff: '--- /dev/null\n+++ lib/new.ts\n@@ -0,0 +1,1 @@\n+new' },
    ] }, { id: 'edit-after-move', tool: 'edit_file', label: 'Edit · /workspace/lib/new.ts', startedAt: 2, status: 'complete' }]
    expect(mutationFileSummary(activities, '/workspace')).toEqual({ fileCount: 1, verb: 'Edited' })
  })

  it('keeps read and mutation file counts in separate categories', () => {
    const execution: AgentExecution = { startedAt: 1, updatedAt: 3, status: 'complete', activities: [
      { id: 'edit', tool: 'edit_file', label: 'Edit · src/app.ts', startedAt: 1, status: 'complete' },
      { id: 'read', tool: 'read_file', label: 'Read · src/app.ts', startedAt: 2, status: 'complete' },
    ] }
    render(<AgentTimeline execution={execution} workspaceRoot="/workspace" />)
    const group = document.querySelector('.agent-inline-activity-group')!
    expect(group.querySelector('.agent-inline-activity-summary')).toHaveTextContent('Edited 1 file · Read 1 file')
    expect(group.querySelector('.agent-inline-operation-count')).toHaveTextContent('2 operations')
  })

  it('preserves accurate counts when rendering restored activity data', () => {
    const restored = Array.from({ length: 17 }, (_, index) => ({ id: `restored-${index}`, tool: 'edit_file', label: `Edit · /workspace/${index < 6 ? 'a.ts' : index < 16 ? 'b.ts' : 'c.ts'}`, startedAt: index + 1, status: 'complete' as const }))
    expect(mutationFileSummary(restored, '/workspace')).toMatchObject({ fileCount: 3 })
  })

  it('deduplicates repeated activity IDs in both file and operation counts', () => {
    const edit: AgentExecution['activities'][number] = { id: 'same', tool: 'edit_file', label: 'Edit · src/app.ts', startedAt: 1, status: 'complete' }
    const execution: AgentExecution = { startedAt: 1, updatedAt: 2, status: 'complete', activities: [edit, edit], timeline: [
      { id: 'event-a', kind: 'activity', activityId: 'same', createdAt: 1 }, { id: 'event-b', kind: 'activity', activityId: 'same', createdAt: 2 },
    ] }
    const group = timelineBlocks(execution).find((block) => block.kind === 'activity-group')
    expect(group?.kind === 'activity-group' ? group.activities : []).toHaveLength(1)
    render(<AgentTimeline execution={execution} />)
    const header = document.querySelector('.agent-inline-activity-group')!
    expect(header.querySelector('.agent-inline-activity-summary')).toHaveTextContent('Edited 1 file')
    expect(header.querySelector('.agent-inline-operation-count')).toHaveTextContent('1 operation')
  })

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
      expect(section).toHaveTextContent('2 operations'); expect(section).toHaveTextContent('1 sub-agent'); expect(section.open).toBe(false)
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
    expect(section).toHaveTextContent('Read 1 file')
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
    expect(section).toHaveTextContent('Created 1 file')
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

  it('shows reported file paths beside verified diffs without inventing missing line counts', () => {
    const execution: AgentExecution = { startedAt: 1, updatedAt: 4, finishedAt: 4, status: 'complete', activities: [
      { id: 'cursor-edit', tool: 'edit_file', label: 'Edit `/workspace/docs/events.yaml`', startedAt: 2, finishedAt: 3, status: 'complete' },
      { id: 'cursor-edit-2', tool: 'edit_file', label: 'Edit `/workspace/docs/tickets/status.json`', startedAt: 3, finishedAt: 3, status: 'complete' },
      { id: 'cursor-edit-3', tool: 'edit_file', label: 'Edit `/workspace/docs/tickets/SNAPSHOT.md`', startedAt: 3, finishedAt: 3, status: 'complete' },
      { id: 'cursor-edit-verified', tool: 'edit_file', label: 'Edit `/workspace/docs/tickets/workflow.yaml`', startedAt: 3, finishedAt: 3, status: 'complete', changes: [{ id: 'verified', path: 'docs/tickets/workflow.yaml', status: 'applied', operation: 'create', diff: '--- /dev/null\n+++ docs/tickets/workflow.yaml\n@@ -0,0 +1,1 @@\n+verified' }] },
    ], timeline: [
      { id: 'activity', kind: 'activity', activityId: 'cursor-edit', createdAt: 2 },
      { id: 'response', kind: 'text', text: 'The file was edited.', createdAt: 4 },
    ] }
    render(<AgentTimeline execution={execution} workspaceRoot="/workspace" />)
    fireEvent.click(screen.getByText('Final combined changes · 4 files'))
    const card = document.querySelector('.agent-timeline-change-summary')!
    expect([...card.querySelectorAll('.agent-timeline-change-row > span > code')].map((code) => code.textContent)).toEqual([
      'docs/tickets/workflow.yaml', 'docs/events.yaml', 'docs/tickets/status.json', 'docs/tickets/SNAPSHOT.md',
    ])
    expect(screen.getByText(/Line totals above include captured diffs only/)).toBeVisible()
    expect(screen.getByText('+1', { selector: '.agent-timeline-change-summary > summary .agent-change-add' })).toBeVisible()
  })

  it('matches the latest activity file total to the execution-wide combined changes card', () => {
    const files = ['.tmp/dump.py', '.tmp/define.md', '.tmp/detail.md', 'events.yaml']
    const activities: AgentExecution['activities'] = files.map((path, index) => ({
      id: `edit-${index}`, tool: 'edit_file', label: `Edit · /workspace/docs/tickets/${path}`, startedAt: index + 1, status: 'complete',
      ...(index === 0 ? { changes: [{ id: 'dump-change', path: `docs/tickets/${path}`, operation: 'create' as const, status: 'applied' as const, diff: `--- /dev/null\n+++ docs/tickets/${path}\n@@ -0,0 +1,1 @@\n+file` }] } : {}),
    }))
    const execution: AgentExecution = { startedAt: 1, updatedAt: 9, finishedAt: 9, status: 'complete', activities, timeline: [
      { id: 'preface', kind: 'text', text: 'First chunk.', createdAt: 1 },
      { id: 'event-0', kind: 'activity', activityId: 'edit-0', createdAt: 2 },
      { id: 'progress', kind: 'text', text: 'Second chunk.', createdAt: 3 },
      ...activities.slice(1).map((activity, index) => ({ id: `event-${index + 1}`, kind: 'activity' as const, activityId: activity.id, createdAt: index + 4 })),
      { id: 'response', kind: 'text', text: 'Done.', createdAt: 9 },
    ] }
    render(<AgentTimeline execution={execution} workspaceRoot="/workspace" />)
    const groups = [...document.querySelectorAll('.agent-inline-activity-group')]
    expect(groups).toHaveLength(2)
    expect(groups[0].querySelector('.agent-inline-activity-summary')).toHaveTextContent('Created 1 file')
    expect(groups[1].querySelector('.agent-inline-activity-summary')).toHaveTextContent('Edited 4 files')
    expect(screen.getByText('Final combined changes · 4 files')).toBeVisible()
  })

  it('keeps saved command logs supplementary and preserves the running timer lifecycle', () => {
    render(<AgentActivity execution={{ startedAt: 1, updatedAt: 4, status: 'complete', activities: [
      { id: 'status', tool: 'git_status', label: 'git --no-pager status --short', startedAt: 1, status: 'complete', fullOutput: 'clean' },
      { id: 'tests', tool: 'run_tests', label: 'npm run test', startedAt: 2, status: 'complete', fullOutput: 'PASS' },
    ] }} />)
    expect(screen.getByText('Saved Command Log · 2 commands')).toBeVisible()
    expect(screen.queryByText('git --no-pager status --short')).not.toBeInTheDocument()
  })

  it('omits the redundant execution phase label above the running duration', () => {
    render(<AgentActivity execution={{ startedAt: 1, updatedAt: 4, status: 'working', streamPhase: 'streaming', activities: [] }} />)
    expect(screen.queryByText('Execution: streaming')).not.toBeInTheDocument()
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
