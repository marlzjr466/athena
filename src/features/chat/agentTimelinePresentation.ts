import type { AgentActivity, AgentExecution } from '../../../shared/agent'

export type ActivityFamily = 'explore' | 'search' | 'terminal' | 'edit' | 'other'
export type TimelineBlock =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'note'; id: string; text: string }
  | { kind: 'activity-group'; id: string; progressId?: string; activities: AgentActivity[]; legacy?: boolean }

export function activitySectionId(execution: AgentExecution, executionId?: string): string {
  return `agent-activity-${executionId ?? execution.startedAt}`
}

export function activityFamily(activity: AgentActivity): ActivityFamily {
  if (/^(run_|execute_command|git_)/.test(activity.tool)) return 'terminal'
  if (/^(create_|write_|edit_|apply_patch|delete_|rename_|move_|revert_)/.test(activity.tool)) return 'edit'
  if (/^(search_|find_|retrieve_|web_search|search_web)/.test(activity.tool)) return 'search'
  if (/^(read_|list_|get_project_structure|get_file_metadata|analyze_project|inspect_dependencies|inspect_imports)/.test(activity.tool)) return 'explore'
  return 'other'
}

/**
 * A presentation view over the persisted event stream. Consecutive operations remain grouped
 * in event order immediately after the progress update that preceded them. Activities without
 * a persisted event link are kept in a separate legacy group rather than guessed from time.
 */
export function timelineBlocks(execution: AgentExecution, executionId?: string): TimelineBlock[] {
  const activities = new Map(execution.activities.map((activity) => [activity.id, activity]))
  const blocks: TimelineBlock[] = []
  const seenIds = new Set<string>()
  let currentProgressId: string | undefined
  let currentActivityGroup: Extract<TimelineBlock, { kind: 'activity-group' }> | undefined
  const flushActivityGroup = () => {
    if (currentActivityGroup) blocks.push(currentActivityGroup)
    currentActivityGroup = undefined
  }
  for (const event of execution.timeline ?? []) {
    if (event.kind !== 'activity') {
      flushActivityGroup()
      if (event.text?.trim()) {
        const kind = event.kind === 'text' ? 'text' : 'note'
        const previous = blocks.at(-1)
        if (kind === 'text' && previous?.kind === 'text') {
          previous.text += event.text
          currentProgressId = previous.id
        }
        else blocks.push({ kind, id: event.id, text: event.text })
        if (!(kind === 'text' && previous?.kind === 'text')) currentProgressId = event.id
      } else if (event.kind === 'status' || event.kind === 'started') {
        currentProgressId = undefined
      }
      continue
    }
    const id = event.activityId ?? ''
    if (!activities.has(id) || seenIds.has(id)) continue
    seenIds.add(id)
    if (!currentActivityGroup) currentActivityGroup = { kind: 'activity-group', id: event.id, progressId: currentProgressId, activities: [] }
    currentActivityGroup.activities.push(activities.get(id)!)
  }
  flushActivityGroup()
  const legacyActivities = execution.activities.filter((activity) => !activity.parentActivityId && !seenIds.has(activity.id)).sort((left, right) => left.startedAt - right.startedAt)
  if (legacyActivities.length) blocks.push({ kind: 'activity-group', id: activitySectionId(execution, executionId), activities: legacyActivities, legacy: true })
  return blocks
}

export function activityTarget(activity: AgentActivity): string {
  const separator = activity.label.indexOf(' · ')
  if (separator >= 0) return activity.label.slice(separator + 3).trim()
  if (activity.tool === 'get_project_structure' || activity.tool === 'analyze_project') return 'Project structure'
  if (activity.tool === 'inspect_dependencies') return 'Dependencies'
  if (activity.tool === 'inspect_imports') return 'Imports'
  if (activity.tool === 'list_directory') return 'Project root'
  if (activity.tool === 'search_files') return 'Files'
  if (activity.tool === 'search_code') return 'Code'
  if (activity.tool === 'retrieve_relevant_context') return 'Relevant project context'
  const toolLabel = activity.tool.replaceAll('_', ' ')
  let cleaned = activity.label.trim().replace(/^(?:explore|read(?:ing)?|search(?:ing)?|edit(?:ing)?|create(?:d|ing)?|delete(?:d|ing)?|terminal|sub-?agent|operation)(?:\s+file)?\s*(?::|·|—|-)?\s*/i, '')
  if (cleaned.toLowerCase().startsWith(`${toolLabel.toLowerCase()} `)) cleaned = cleaned.slice(toolLabel.length).trim()
  return cleaned && cleaned !== activity.tool && cleaned.toLowerCase() !== toolLabel.toLowerCase() ? cleaned : ''
}

export function groupLabel(family: 'explore' | 'search', activities: AgentActivity[]): string {
  if (family === 'search') {
    const queries = new Set(activities.map(activityTarget).filter((target) => target && target !== 'Files' && target !== 'Code'))
    if (queries.size === 1) return [...queries][0]
    const count = queries.size || activities.length
    return `${count} ${count === 1 ? 'query' : 'queries'}`
  }
  const files = new Set(activities.filter((activity) => activity.tool === 'read_file' || activity.tool === 'get_file_metadata' || activity.tool === 'inspect_imports').map(activityTarget).filter(Boolean))
  const searches = activities.filter((activity) => activityFamily(activity) === 'search')
  const queries = new Set(searches.map(activityTarget).filter((target) => target && target !== 'Files' && target !== 'Code'))
  const searchCount = queries.size || searches.length
  if (files.size) return `${files.size} ${files.size === 1 ? 'file' : 'files'}${searchCount ? ` · ${searchCount} ${searchCount === 1 ? 'search' : 'searches'}` : ''}`
  const locations = new Set(activities.map(activityTarget).filter(Boolean))
  if (locations.size === 1 && !searchCount) return [...locations][0]
  if (searchCount) return `Project structure · ${searchCount} ${searchCount === 1 ? 'search' : 'searches'}`
  return `${locations.size || activities.length} locations`
}

export function operationLabel(activity: AgentActivity): string {
  if (activity.subagent) return activity.subagent.request.role
  const family = activityFamily(activity)
  if (family === 'terminal') {
    const gitLabels: Record<string, string> = { git_status: 'git status', git_diff: 'git diff', git_log: 'git log', git_branch: 'git branch', git_add: 'git add', git_commit: 'git commit' }
    if (gitLabels[activity.tool]) return gitLabels[activity.tool]
    const label = activity.label.replace(/^(?:terminal|command|run)(?:\s*[·:—-]\s*|\s+)/i, '').trim()
    const toolLabel = activity.tool.replaceAll('_', ' ')
    if (![activity.tool, toolLabel].includes(label) && activity.label !== activity.tool && activity.label !== toolLabel) {
      const parts = label.split(' ')
      const executable = parts[0]?.split('/').at(-1) ?? ''
      return [executable, ...parts.slice(1)].join(' ')
    }
    return ({ run_tests: 'Tests', run_linter: 'Lint', run_typecheck: 'Typecheck', run_build: 'Build' } as Record<string, string>)[activity.tool] ?? 'Preparing command'
  }
  if (family === 'edit') {
    const paths = [...new Set(activity.changes?.filter((change) => change.status === 'applied').map((change) => change.path) ?? [])]
    return paths.length > 1 ? `${paths.length} files` : paths[0] || activityTarget(activity) || 'Project files'
  }
  if (family === 'explore' || family === 'search') return activityTarget(activity) || 'Project files'
  return activity.label && activity.label !== activity.tool.replaceAll('_', ' ') ? activity.label : 'Project operation'
}

export function activityState(activities: AgentActivity[]): AgentActivity['status'] {
  if (activities.some((activity) => activity.status === 'error')) return 'error'
  if (activities.some((activity) => activity.status === 'running')) return 'running'
  if (activities.some((activity) => activity.status === 'cancelled')) return 'cancelled'
  return 'complete'
}
