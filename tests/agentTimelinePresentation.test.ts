import { describe, expect, it } from 'vitest'
import type { AgentActivity, AgentExecution } from '../shared/agent'
import { activitySectionId, operationLabel, timelineBlocks } from '../src/features/chat/agentTimelinePresentation'

const activity = (id: string, tool: string, label: string, status: AgentActivity['status'] = 'complete'): AgentActivity => ({ id, tool, label, status, startedAt: 1 })
const execution = (activities: AgentActivity[], sequence: Array<string | { text: string }>): AgentExecution => ({ startedAt: 1, updatedAt: 2, status: 'working', activities, timeline: sequence.map((item, index) => typeof item === 'string'
  ? { id: `event-${index}`, kind: 'activity', activityId: item, createdAt: index }
  : { id: `event-${index}`, kind: 'text', text: item.text, createdAt: index }) })

describe('unified agent activity presentation', () => {
  it('joins adjacent streamed text chunks so a split Sources appendix can be omitted as one suffix', () => {
    const blocks = timelineBlocks(execution([], [{ text: 'Answer.\n\nSour' }, { text: 'ces:\n- [React](https://react.dev/)' }]))
    expect(blocks).toEqual([{ kind: 'text', id: 'event-0', text: 'Answer.\n\nSources:\n- [React](https://react.dev/)' }])
  })

  it('creates a stable inline group for consecutive events and retains repeated reads in event order', () => {
    const run = execution([
      activity('a', 'read_file', 'read file · docs/define.md'),
      activity('b', 'read_file', 'read file · docs/define.md'),
      activity('c', 'read_file', 'read file · docs/plan.md'),
      activity('d', 'get_project_structure', 'get project structure'),
    ], ['a', 'b', 'c', 'd'])
    const blocks = timelineBlocks(run)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('activity-group')
    if (blocks[0].kind !== 'activity-group') return
    expect(blocks[0].activities.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(blocks[0].id).toBe('event-0')
    expect(run.activities).toHaveLength(4)
  })

  it('keeps progress updates and operation intervals in their original chronological order', () => {
    const run = execution([
      activity('a', 'search_files', 'search files · versions'),
      activity('b', 'search_code', 'search code · VersionListPanel'),
      activity('c', 'edit_file', 'edit file · src/api/versions.ts'),
      activity('d', 'run_tests', 'npm run test'),
      activity('e', 'run_typecheck', 'npm run typecheck'),
      activity('f', 'read_file', 'read file · src/api/versions.ts'),
    ], [{ text: 'I will inspect the implementation.' }, 'a', 'b', { text: 'The query layer needs an update.' }, 'c', 'd', 'e', 'f'])
    const blocks = timelineBlocks(run)
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'activity-group', 'text', 'activity-group'])
    if (blocks[1].kind !== 'activity-group' || blocks[3].kind !== 'activity-group') return
    expect(blocks[1].activities.map((item) => item.id)).toEqual(['a', 'b'])
    expect(blocks[1].progressId).toBe('event-0')
    expect(blocks[3].activities.map((item) => item.id)).toEqual(['c', 'd', 'e', 'f'])
    expect(blocks[3].progressId).toBe('event-3')
    expect(operationLabel(run.activities[3])).toBe('npm run test')
    expect(operationLabel(run.activities[4])).toBe('npm run typecheck')
  })

  it('retains mixed operation chronology and humanizes tool labels', () => {
    const run = execution([
      activity('a', 'get_project_structure', 'Explore analyze_project'),
      activity('b', 'search_files', 'Search search_files'),
      activity('c', 'read_file', 'Read · src/api/versions.ts'),
      activity('d', 'git_status', 'git --no-pager -c core.hooksPath=/dev/null status --short'),
    ], ['a', 'b', 'c', 'd'])
    const blocks = timelineBlocks(run)
    expect(blocks).toHaveLength(1)
    if (blocks[0].kind !== 'activity-group') return
    expect(blocks[0].activities.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(operationLabel(run.activities[0])).toBe('Project structure')
    expect(operationLabel(run.activities[1])).toBe('Files')
    expect(operationLabel(run.activities[2])).toBe('src/api/versions.ts')
    expect(operationLabel(run.activities[3])).toBe('git status')
  })

  it('retains failures and commentary without duplicating sections', () => {
    const run = execution([
      activity('a', 'read_file', 'read file · src/a.ts'),
      activity('b', 'read_file', 'read file · src/b.ts', 'error'),
      activity('c', 'read_file', 'read file · src/c.ts'),
    ], ['a', 'b', { text: 'That file was unavailable.' }, 'c'])
    const blocks = timelineBlocks(run)
    expect(blocks.map((block) => block.kind)).toEqual(['activity-group', 'text', 'activity-group'])
    if (blocks[0].kind !== 'activity-group') return
    expect(run.activities[1].status).toBe('error')
  })

  it('keeps large operation intervals and leaves unreferenced legacy records explicitly unassociated', () => {
    const activities = Array.from({ length: 35 }, (_, index) => activity(`r${index}`, 'read_file', `read file · src/file${index}.ts`))
    const blocks = timelineBlocks(execution(activities, activities.map((item) => item.id)))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind === 'activity-group' && blocks[0].activities).toHaveLength(35)

    const legacy: AgentExecution = { startedAt: 4, updatedAt: 8, status: 'complete', activities: [activity('seen', 'read_file', 'Read a.ts'), activity('unseen', 'edit_file', 'Edit b.ts')], timeline: [{ id: 'same-1', kind: 'activity', activityId: 'seen', createdAt: 1 }, { id: 'same-2', kind: 'activity', activityId: 'seen', createdAt: 2 }] }
    const legacyBlocks = timelineBlocks(legacy)
    expect(legacyBlocks).toHaveLength(2)
    expect(legacyBlocks[0].kind === 'activity-group' && legacyBlocks[0].activities.map((item) => item.id)).toEqual(['seen'])
    expect(legacyBlocks[1]).toMatchObject({ kind: 'activity-group', legacy: true, activities: [{ id: 'unseen' }] })
    expect(legacyBlocks[1].kind === 'activity-group' && legacyBlocks[1].progressId).toBeUndefined()
    expect(legacyBlocks[1].kind === 'activity-group' && legacyBlocks[1].id).toBe(activitySectionId(legacy))
  })
})
