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
  const legacyIds = new Set<string>()
  const legacyActivities = execution.activities.filter((activity) => {
    if (activity.parentActivityId || seenIds.has(activity.id) || legacyIds.has(activity.id)) return false
    legacyIds.add(activity.id); return true
  }).sort((left, right) => left.startedAt - right.startedAt)
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

/** Lexically normalizes activity paths for display aggregation only. Execution paths are untouched. */
export function normalizeActivityFileIdentity(value: string, workspaceRoot?: string): string | null {
  let path = value.trim().replace(/^[`'\"]+|[`'\"]+$/g, '').replaceAll('\\', '/')
  if (!path || path.includes('\0') || /^(?:project files|project structure|files|code)$/i.test(path)) return null

  const normalize = (input: string): { prefix: string; segments: string[]; absolute: boolean; windows: boolean } => {
    const windowsDrive = /^([a-z]):(?:\/|$)/i.exec(input)
    const unc = input.startsWith('//')
    const absolute = input.startsWith('/') || Boolean(windowsDrive) || input === '~' || input.startsWith('~/')
    const windows = Boolean(windowsDrive) || unc
    let prefix = '', remainder = input
    if (windowsDrive) { prefix = `win:${windowsDrive[1].toLowerCase()}:/`; remainder = input.slice(windowsDrive[0].length) }
    else if (unc) {
      const [server = '', share = '', ...rest] = input.slice(2).split('/').filter(Boolean)
      if (!server || !share) return { prefix: 'unc:/', segments: [], absolute: true, windows: true }
      prefix = `unc:/${server.toLowerCase()}/${share.toLowerCase()}/`; remainder = rest.join('/')
    } else if (input.startsWith('/')) { prefix = '/'; remainder = input.replace(/^\/+/, '') }
    else if (input === '~' || input.startsWith('~/')) { prefix = 'home:/'; remainder = input.slice(1).replace(/^\/+/, '') }
    const segments: string[] = []
    for (const segment of remainder.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (segments.length && segments.at(-1) !== '..') segments.pop()
        else if (!absolute) segments.push('..')
      } else segments.push(segment)
    }
    return { prefix, segments, absolute, windows }
  }

  let parsed = normalize(path)
  if (!parsed.absolute && workspaceRoot) {
    const root = normalize(workspaceRoot.trim().replaceAll('\\', '/'))
    if (root.absolute) {
      // Resolve dot segments against the workspace without touching the filesystem.
      const joined = [...root.segments]
      for (const segment of path.split('/')) {
        if (!segment || segment === '.') continue
        if (segment === '..') { if (joined.length) joined.pop() }
        else joined.push(segment)
      }
      parsed = { ...root, segments: joined }
    }
  }
  if (!parsed.prefix && !parsed.segments.length) return null
  const segments = parsed.windows ? parsed.segments.map((segment) => segment.toLowerCase()) : parsed.segments
  return `${parsed.prefix || 'relative:'}${segments.join('/')}`
}

export interface MutationFileSummary { fileCount: number; verb: 'Created' | 'Deleted' | 'Moved' | 'Edited' }

/** Legacy activity can identify a reported target without proving its diff. */
export function reportedFileChanges(activities: AgentActivity[], workspaceRoot?: string): Array<{ path: string; operation: string }> {
  const files = new Map<string, { path: string; operation: string }>()
  for (const activity of activities) {
    if (activity.status !== 'complete' || activity.changes?.length || !/^(?:create_file|write_file|edit_file|apply_patch|delete_file|rename_file|move_file)$/.test(activity.tool)) continue
    const target = activityTarget(activity)
    const quoted = /^`([^`\r\n]+)`$/.exec(target)
    const path = quoted?.[1] ?? target
    // Generic titles ("Edited file") are not file identities.
    if (!path || (!quoted && !/[/.\\]/.test(path))) continue
    const identity = normalizeActivityFileIdentity(path, workspaceRoot)
    if (!identity) continue
    const operation = activity.tool === 'create_file' ? 'Created' : activity.tool === 'delete_file' ? 'Deleted'
      : /^(rename|move)_file$/.test(activity.tool) ? 'Moved' : 'Modified'
    const displayPath = workspaceRoot && path.startsWith(`${workspaceRoot}/`) ? path.slice(workspaceRoot.length + 1) : path
    files.set(identity, { path: displayPath, operation })
  }
  return [...files.values()]
}

/** Counts successful file mutations by normalized identity, not by activity/tool-call count. */
export function mutationFileSummary(activities: AgentActivity[], workspaceRoot?: string): MutationFileSummary {
  const seenActivityIds = new Set<string>()
  const distinct = activities.filter((activity) => {
    if (seenActivityIds.has(activity.id)) return false
    seenActivityIds.add(activity.id)
    return true
  })
  const fileTools = /^(?:create_file|write_file|edit_file|apply_patch|delete_file|rename_file|move_file|revert_change)$/
  const successful = distinct.filter((activity) => activity.status === 'complete' && fileTools.test(activity.tool))
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    const current = parent.get(key)
    if (!current) { parent.set(key, key); return key }
    if (current === key) return key
    const root = find(current); parent.set(key, root); return root
  }
  const union = (left: string, right: string) => { const a = find(left), b = find(right); if (a !== b) parent.set(b, a) }
  const records: Array<{ identity: string; kind: 'create' | 'delete' | 'move' | 'edit'; activity: AgentActivity }> = []
  for (const activity of successful) {
    const isMove = activity.tool === 'rename_file' || activity.tool === 'move_file'
    const isCreateTool = activity.tool === 'create_file'
    const isDeleteTool = activity.tool === 'delete_file'
    let paths: Array<{ path: string; diff?: string }> = []
    if (activity.changes) {
      paths = activity.changes.filter((change) => change.status === 'applied' || activity.tool === 'revert_change' && change.status === 'reverted').map((change) => ({ path: change.path, diff: change.diff }))
    } else {
      let target = activityTarget(activity)
      if (isMove) {
        const parts = target.split(/\s*(?:→|->)\s*/)
        if (parts.length > 1) paths = parts.map((path) => ({ path }))
      }
      if (!paths.length && target) paths = [{ path: target }]
    }
    const normalized = paths.map((entry) => ({ ...entry, identity: normalizeActivityFileIdentity(entry.path, workspaceRoot) })).filter((entry): entry is typeof entry & { identity: string } => Boolean(entry.identity))
    if (isMove && normalized.length > 1) for (const entry of normalized.slice(1)) union(normalized[0].identity, entry.identity)
    for (const entry of normalized) {
      const kind = isMove ? 'move' : isCreateTool || entry.diff?.startsWith('--- /dev/null') ? 'create'
        : isDeleteTool || entry.diff?.split('\n').slice(0, 2).some((line) => line === '+++ /dev/null') ? 'delete' : 'edit'
      records.push({ identity: entry.identity, kind, activity })
    }
  }
  const fileCount = new Set(records.map((record) => find(record.identity))).size
  const kinds = new Set(records.map((record) => record.kind))
  const verb = kinds.size === 1 && kinds.has('create') ? 'Created'
    : kinds.size === 1 && kinds.has('delete') ? 'Deleted'
      : kinds.size === 1 && kinds.has('move') ? 'Moved' : 'Edited'
  return { fileCount, verb }
}

/** Unique completed read targets. Search and project-wide exploration are intentionally excluded. */
export function readFileCount(activities: AgentActivity[], workspaceRoot?: string): number {
  const identities = new Set<string>(), seen = new Set<string>()
  for (const activity of activities) {
    if (seen.has(activity.id) || activity.status !== 'complete' || !['read_file', 'get_file_metadata', 'inspect_imports'].includes(activity.tool)) continue
    seen.add(activity.id)
    const identity = normalizeActivityFileIdentity(activityTarget(activity), workspaceRoot)
    if (identity) identities.add(identity)
  }
  return identities.size
}

export function activityFileSummaryLabels(activities: AgentActivity[], workspaceRoot?: string): string[] {
  const distinct = [...new Map(activities.map((activity) => [activity.id, activity])).values()]
  const mutations = distinct.filter((activity) => /^(?:create_file|write_file|edit_file|apply_patch|delete_file|rename_file|move_file|revert_change)$/.test(activity.tool))
  const reads = distinct.filter((activity) => ['read_file', 'get_file_metadata', 'inspect_imports'].includes(activity.tool))
  const labels: string[] = []
  if (mutations.length) {
    const summary = mutationFileSummary(mutations, workspaceRoot)
    labels.push(summary.fileCount ? `${summary.verb} ${summary.fileCount} ${summary.fileCount === 1 ? 'file' : 'files'}`
      : mutations.some((activity) => activity.status === 'running') ? 'File changes in progress' : 'File operations')
  }
  if (reads.length) {
    const count = readFileCount(reads, workspaceRoot)
    labels.push(count ? `Read ${count} ${count === 1 ? 'file' : 'files'}` : 'Read project files')
  }
  return labels
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
  if(activity.tool==='codex.mcpToolCall' && /^cua_repl · /.test(activity.label))return 'Native computer interaction'
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
