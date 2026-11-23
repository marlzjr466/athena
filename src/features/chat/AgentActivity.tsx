import { scrollWithinTranscript } from './scrollTranscript'
import { Fragment, memo, useEffect, useState } from 'react'
import { elapsedLabel, type AgentExecution, type ChangePreview } from '../../../shared/agent'
import { useChat } from '../../store/chatStore'
import { desktop } from '../../services/desktop'
import { MessageMarkdown } from './MessageMarkdown'
import { Activity as ActivityIcon, Bot, BookOpen, CircleAlert, ChevronRight, FilePenLine, FilePlus, FolderTree, Globe, Layers, LoaderCircle, Monitor, Search, ShieldCheck, Terminal, Trash2, Wrench } from 'lucide-react'
import type { AgentActivity as Operation } from '../../../shared/agent'
import { useAthena } from '../../store/athenaStore'
import { activityFamily, activityFileSummaryLabels, activitySectionId, normalizeActivityFileIdentity, operationLabel, reportedFileChanges, timelineBlocks } from './agentTimelinePresentation'
import type { StreamDiagnostic } from '../../../shared/streamDiagnostics'

function StreamDiagnostics({ items }: { items?: StreamDiagnostic[] }) {
  if (!items?.length) return null
  const report = JSON.stringify({ format: 'Athena sanitized stream diagnostics v1', failures: items }, null, 2)
  return <details className="agent-stream-diagnostics"><summary>Connection diagnostics · {items.length} {items.length === 1 ? 'event' : 'events'}</summary>
    <p>Request identifiers and counters only; no message contents or credentials are included.</p>
    <button className="chat-action" onClick={() => void desktop.copyChatText({ text: report })}>Copy sanitized report</button>
    <pre>{report}</pre>
  </details>
}

function operationKind(activity: Operation): { label: string; icon: typeof Wrench } {
  if (activity.subagent || /sub.?agent|spawn_agent|delegate/i.test(activity.tool)) return { label: 'Sub-agent', icon: Bot }
  if (/browser|open_url|navigate|verify_local_app/i.test(activity.tool)) return { label: 'Browser', icon: Globe }
  if (/computer_use|desktop|screenshot|mouse|keyboard/i.test(activity.tool)) return { label: 'Desktop', icon: Monitor }
  if (/compact|context/i.test(activity.tool)) return { label: 'Context', icon: Layers }
  if (/load_tool|load_skill|discover_tool/i.test(activity.tool)) return { label: 'Tools', icon: Wrench }
  const family = activityFamily(activity)
  if (family === 'terminal') return { label: 'Terminal', icon: Terminal }
  if (family === 'edit' && activity.tool.startsWith('create_')) return { label: 'Create', icon: FilePlus }
  if (family === 'edit' && activity.tool.startsWith('delete_')) return { label: 'Delete', icon: Trash2 }
  if (family === 'edit') return { label: 'Edit', icon: FilePenLine }
  if (family === 'search') return { label: 'Search', icon: Search }
  if (family === 'explore' && activity.tool === 'read_file') return { label: 'Read', icon: BookOpen }
  if (family === 'explore') return { label: 'Explore', icon: FolderTree }
  return { label: 'Other', icon: Wrench }
}
function changeKind(change: ChangePreview): string {
  if (change.diff.startsWith('--- /dev/null')) return 'Created'
  if (change.diff.split('\n').slice(0, 2).some((line) => line === '+++ /dev/null')) return 'Deleted'
  return 'Modified'
}
function changeCounts(changes: ChangePreview[]): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const change of changes) for (const line of change.diff.split('\n').slice(2)) {
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

function StatusMark({ status }: { status: Operation['status'] }) {
  if (status === 'complete') return null
  return <span className={`agent-timeline-state ${status}`} title={status}>
    {status === 'running' ? <LoaderCircle size={13} aria-hidden="true" /> : status === 'error' ? <><CircleAlert size={13} aria-hidden="true" /> Failed</> : status === 'cancelled' ? 'Cancelled' : null}
    <span className="chat-sr-only">{status}</span>
  </span>
}

function terminalResult(activity: Operation): { output: string; exitCode?: number | null } {
  if (!activity.fullOutput) return { output: '' }
  if (activity.status === 'running') return { output: activity.fullOutput.slice(-2400) }
  try {
    const parsed: unknown = JSON.parse(activity.fullOutput)
    if (parsed && typeof parsed === 'object' && 'output' in parsed && typeof parsed.output === 'string') {
      const exitCode = 'exitCode' in parsed && (typeof parsed.exitCode === 'number' || parsed.exitCode === null) ? parsed.exitCode : undefined
      return { output: parsed.output, exitCode }
    }
  } catch { /* Older saved activities may contain plain output. */ }
  return { output: activity.fullOutput }
}

function OperationDetails({ activity, sessionId, canRevert }: { activity: Operation; sessionId?: string; canRevert: boolean }) {
  const terminal = activityFamily(activity) === 'terminal'
  const result = terminal ? terminalResult(activity) : undefined
  const output = result?.output ?? activity.fullOutput ?? ''
  return <div className="agent-timeline-details">
    <p><span className="chat-sr-only">Tool:</span><code>{activity.tool}</code> · {activity.status} · Started {new Date(activity.startedAt).toLocaleTimeString()}{activity.finishedAt ? ` · Finished ${new Date(activity.finishedAt).toLocaleTimeString()} · ${Math.max(0, Math.round((activity.finishedAt - activity.startedAt) / 1000))}s` : ''}{result?.exitCode !== undefined ? ` · Exit ${result.exitCode ?? 'unknown'}` : ''}</p>
    {activity.label !== operationLabel(activity) && <p>{activity.label}</p>}
    {activity.summary && <p className={activity.status === 'error' ? 'agent-operation-error' : undefined}>{activity.summary}</p>}
    {output && <details className="agent-operation-output"><summary>Output · {output.length.toLocaleString('en-US')} characters</summary><pre>{output}</pre></details>}
    {activity.changes?.map((change) => <ChangeReview key={change.id} change={change} sessionId={sessionId} canRevert={canRevert} />)}
  </div>
}

function SubagentDetails({ activity, children, detailsPrefix, sessionId, canRevert }: { activity: Operation; children: Operation[]; detailsPrefix: string; sessionId?: string; canRevert: boolean }) {
  const { command, pending } = useChat()
  const run = activity.subagent!
  const result = run.result
  const budget = run.budget
  const executionBudget = run.executionBudget
  const tokens = (value: number) => value.toLocaleString('en-US')
  return <div className="agent-timeline-details agent-subagent-details">
    <p>{run.request.task}</p>
    <p>{run.request.mode.replaceAll('_', ' ')} · {run.status} · {run.model ?? 'Provider default'} · {run.effort} effort</p>
    <p>{run.iterations} iterations · {run.toolCalls} tool calls{run.attempts > 1 ? ` · attempt ${run.attempts}` : ''}</p>
    {executionBudget ? <div aria-label="Sub-agent execution limits">
      <p>Tool calls: Settings {executionBudget.configuredToolCalls} · {executionBudget.requestedToolCalls === null ? 'Inherited allocation' : `Task / workflow cap ${executionBudget.requestedToolCalls}`} · Effective {executionBudget.effectiveToolCalls} · Consumed {run.toolCalls} · Remaining {executionBudget.remainingToolCalls}</p>
      <p>Iterations: Settings {executionBudget.configuredIterations} · {executionBudget.requestedIterations === null ? 'Inherited allocation' : `Task / workflow cap ${executionBudget.requestedIterations}`} · Effective {executionBudget.effectiveIterations} · Consumed {run.iterations} · Remaining {executionBudget.remainingIterations}</p>
      <p>Each attempted tool counts once, including failed/invalid calls. Deferred calls do not count. Iterations include model-request retries and the reserved final assessment.</p>
      {!!executionBudget.repeatedResults && <p>Repeated results {executionBudget.repeatedResults} · Consecutive calls without new evidence {executionBudget.noProgressCalls}</p>}
      {executionBudget.lastBatch && <p>Limited batch: {executionBudget.lastBatch.requested} requested · {executionBudget.lastBatch.executed} admitted · {executionBudget.lastBatch.deferred} not executed</p>}
      {executionBudget.finalization && <p>Final assessment reason: {executionBudget.finalization.reason.replaceAll('_', ' ')} — {executionBudget.finalization.message}</p>}
    </div> : <p>Legacy execution limits: {run.request.maxToolCalls === undefined ? 'inherited tool allowance (not recorded)' : `Task tool cap ${run.request.maxToolCalls}`} · {run.request.maxIterations === undefined ? 'inherited iteration allowance (not recorded)' : `Task iteration cap ${run.request.maxIterations}`}. Current Settings do not change historical allocations.</p>}
    {budget ? <div aria-label="Sub-agent token budget">
      <p>Configured {tokens(budget.configuredTokens)} · {budget.requestedTokens === null ? 'Inherited allocation' : `Child allocation ${tokens(budget.requestedTokens)}`} · Effective {tokens(budget.effectiveTokens)} tokens</p>
      <p>Consumed {tokens(budget.consumedTokens)} · Remaining {tokens(budget.remainingTokens)} · Reserved for active request {tokens(budget.reservedInput + budget.reservedOutput)} · Available {tokens(budget.availableTokens)}</p>
      <p>Provider-reported {tokens(budget.measuredInput + budget.measuredOutput)} · Estimated / unreported {tokens(budget.estimatedInput + budget.estimatedOutput)}{budget.legacyEstimate ? ' (includes preserved legacy estimates)' : ''}</p>
      <p>Input {tokens(run.inputTokens)} · Output {tokens(run.outputTokens)} · Reported reasoning {tokens(budget.reasoningTokens)} (already included in output). Tool results count as input when sent; they are not added again.</p>
      <p>Configured per-request context {tokens(budget.configuredContext)} · {budget.requestedContext === null ? 'Inherited allocation' : `Task allocation ${tokens(budget.requestedContext)}`} · Effective context cap {tokens(budget.effectiveContext)} · Model context {budget.modelContext === null ? 'not reported' : tokens(budget.modelContext)}{budget.modelContext !== null && !budget.modelLimitsVerified ? ' (conservative fallback)' : ''} · Model output limit {budget.modelMaxOutput === null ? 'not reported' : tokens(budget.modelMaxOutput)}{!budget.outputLimitEnforced && ' · Output length is provider-managed; reservations are estimates, not a provider quota.'}</p>
      {budget.contextLimitReason && <p>{budget.contextLimitReason}</p>}
      {budget.lastRequest && <p>Last request check: {tokens(budget.lastRequest.inputTokens)} {budget.lastRequest.inputEstimated ? 'estimated' : 'measured'} input + {tokens(budget.lastRequest.outputTokens)} output reserve; {tokens(budget.lastRequest.remainingBefore)} remaining before request.</p>}
      {budget.termination && <p>Termination reason: {budget.termination.code.replaceAll('_', ' ')}</p>}
    </div> : <p>Legacy budgeted estimate: {tokens(run.inputTokens + run.outputTokens)} tokens (not measured usage). {run.request.tokenBudget !== undefined ? `Child-requested total cap: ${tokens(run.request.tokenBudget)}.` : 'Child inherited Settings.'} Effective settings and per-request diagnostics were not recorded by this app version.</p>}
    {run.progress && <p>{run.progress}</p>}
    <StreamDiagnostics items={run.streamDiagnostics} />
    {run.error && <p className="chat-error" role="alert">{run.error}</p>}
    {result && <><p>{result.assessment && <strong>{result.assessment} · </strong>}{result.summary}</p>{result.findings.length > 0 && <ul aria-label="Review findings">{result.findings.map((finding, index) => <li key={index}><strong>{finding.severity}</strong> · {finding.description}{finding.evidence.length > 0 && <p>{finding.evidence.join(' · ')}</p>}</li>)}</ul>}
      {(['blockers', 'evidence', 'filesReviewed', 'checksPerformed', 'limitations', 'nextActions'] as const).map((key) => result[key].length > 0 && <details key={key}><summary>{{ blockers: 'Blockers', evidence: 'Evidence', filesReviewed: 'Files reviewed', checksPerformed: 'Checks performed', limitations: 'Limitations', nextActions: 'Next actions' }[key]}</summary><ul>{result[key].map((entry, index) => <li key={index}>{entry}</li>)}</ul></details>)}
    </>}
    {run.resultDiagnostics && <details><summary>Result diagnostics</summary><p>Termination: {run.resultDiagnostics.terminationReason}</p><p>JSON candidates: {run.resultDiagnostics.candidateCount}</p>{run.resultDiagnostics.missingFields.length > 0 && <p>Missing fields: {run.resultDiagnostics.missingFields.join(' · ')}</p>}{run.resultDiagnostics.validationErrors.length > 0 && <ul aria-label="Result schema validation errors">{run.resultDiagnostics.validationErrors.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}</details>}
    {result && <details><summary>Parsed result</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}
    {run.rawResponse && <details><summary>Raw child response</summary><pre>{run.rawResponse}</pre></details>}
    {run.reconciliation && <p>Parent review · {run.reviewAccepted ? 'Accepted' : 'Not accepted'}: {run.reconciliation}</p>}
    {sessionId && ['queued', 'running'].includes(run.status) && <button className="chat-action" disabled={pending} onClick={() => void command({ action: 'cancel-subagent', id: sessionId, subagentId: run.id })}>Cancel this sub-agent</button>}
    {!!children.length && <details><summary>Child operations · {children.length}</summary>{children.map((child) => <ActivityRow key={child.id} activity={child} detailsPrefix={detailsPrefix} sessionId={sessionId} canRevert={canRevert} />)}</details>}
  </div>
}

function ActivityRow({ activity, detailsPrefix, sessionId, canRevert, children = [], initialExpanded = false }: { activity: Operation; detailsPrefix: string; sessionId?: string; canRevert: boolean; children?: Operation[]; initialExpanded?: boolean }) {
  const kind = operationKind(activity), Icon = kind.icon
  const [expanded, setExpanded] = useState(initialExpanded)
  const detailsId = `${detailsPrefix}-operation-${activity.id}`
  return <details className={`agent-timeline-operation ${activity.status}`} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary onClick={(event) => { event.preventDefault(); setExpanded((value) => !value) }} aria-controls={detailsId} aria-expanded={expanded} aria-label={`${kind.label}: ${operationLabel(activity)} (${activity.status})`}><Icon size={15} strokeWidth={1.7} aria-hidden="true" /><span className="agent-timeline-kind">{kind.label}</span><span className="agent-timeline-separator">·</span><span className="agent-timeline-label">{operationLabel(activity)}</span><StatusMark status={activity.status} /><ChevronRight className="agent-timeline-chevron" size={13} aria-hidden="true" /></summary>
    <div id={detailsId}>{expanded && (activity.subagent ? <SubagentDetails activity={activity} children={children} detailsPrefix={detailsPrefix} sessionId={sessionId} canRevert={canRevert} /> : <OperationDetails activity={activity} sessionId={sessionId} canRevert={canRevert} />)}</div>
  </details>
}

function PermissionDecisionRow({ decisions, id }: { decisions: NonNullable<AgentExecution['permissionDecisions']>; id: string }) {
  const [expanded, setExpanded] = useState(false)
  const counts = {
    automatic: decisions.filter((entry) => entry.decision === 'automatic').length,
    manual: decisions.filter((entry) => entry.decision === 'manual').length,
    rejected: decisions.filter((entry) => entry.decision === 'rejected').length,
  }
  const countLabel = [
    counts.automatic ? `${counts.automatic} automatically approved` : '',
    counts.manual ? `${counts.manual} manually approved` : '',
    counts.rejected ? `${counts.rejected} rejected` : '',
  ].filter(Boolean).join(' · ')
  const detailsId = `${id}-permission-details`
  return <details className="agent-timeline-operation" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary onClick={(event) => { event.preventDefault(); setExpanded((value) => !value) }} aria-controls={detailsId} aria-expanded={expanded} aria-label={`Permissions: ${countLabel}`}>
      <ShieldCheck size={15} strokeWidth={1.7} aria-hidden="true" />
      <span className="agent-timeline-kind">Permissions</span><span className="agent-timeline-separator">·</span>
      <span className="agent-timeline-label">{countLabel}</span>
      <ChevronRight className="agent-timeline-chevron" size={13} aria-hidden="true" />
    </summary>
    {expanded && <div id={detailsId} className="agent-timeline-details"><ol>{decisions.map((entry) => <li key={entry.id}>{entry.title} · {entry.decision === 'automatic' ? 'Automatically approved' : entry.decision === 'manual' ? 'Manually approved' : 'Rejected'} · {new Date(entry.at).toLocaleTimeString()}</li>)}</ol></div>}
  </details>
}

function groupSummary(activities: Operation[], workspaceRoot?: string, fileSummaryActivities: Operation[] = activities): string {
  const uniqueActivities = [...new Map(activities.map((activity) => [activity.id, activity])).values()]
  const uniqueFileSummaryActivities = [...new Map(fileSummaryActivities.map((activity) => [activity.id, activity])).values()]
  const fileTools = /^(?:create_file|write_file|edit_file|apply_patch|delete_file|rename_file|move_file|revert_change|read_file|get_file_metadata|inspect_imports)$/
  const parts = activityFileSummaryLabels(uniqueFileSummaryActivities, workspaceRoot)
  const groups = new Map<string, { label: string; count: number }>()
  for (const activity of uniqueActivities.filter((entry) => !fileTools.test(entry.tool))) {
    const family = activityFamily(activity)
    const label = activity.subagent ? 'started sub-agent'
      : /browser|open_url|navigate|verify_local_app/i.test(activity.tool) ? 'opened browser'
      : /computer_use|desktop|screenshot|mouse|keyboard/i.test(activity.tool) ? 'used desktop automation'
      : /compact|context/i.test(activity.tool) ? 'compacted context'
      : /load_tool|load_skill|discover_tool/i.test(activity.tool) ? 'loaded tool'
      : family === 'terminal' ? 'ran command' : family === 'search' ? 'searched' : family === 'explore'
        ? activity.tool === 'read_file' ? 'read file' : 'explored project'
        : family === 'edit' ? activity.tool.startsWith('create_') ? 'created file' : activity.tool.startsWith('delete_') ? 'deleted file' : 'edited file'
        : 'used tool'
    const current = groups.get(label)
    if (current) current.count++
    else groups.set(label, { label, count: 1 })
  }
  parts.push(...[...groups.values()].map(({ label, count }) => {
    const countedNoun = /^(.*) (file|command|sub-agent|tool)$/.exec(label)
    if (countedNoun) return `${countedNoun[1][0].toUpperCase()}${countedNoun[1].slice(1)}${count > 1 ? ` ${count}` : ''} ${countedNoun[2]}${count > 1 ? 's' : ''}`
    return `${label[0].toUpperCase()}${label.slice(1)}${count > 1 ? ` ×${count}` : ''}`
  }))
  return parts.join(' · ')
}

function groupFailures(activities: Operation[]): Operation[] {
  return activities.filter((activity) => activity.status === 'error' || ['failed', 'incomplete', 'error'].includes(activity.subagent?.status ?? ''))
}

function ActivityGroup({ id, progressId, activities, execution, permissionDecisions, sessionId, workspaceRoot, summaryActivities, executionInProgress = false, legacy = false }: { id: string; progressId?: string; activities: Operation[]; execution: AgentExecution; permissionDecisions?: AgentExecution['permissionDecisions']; sessionId?: string; workspaceRoot?: string; summaryActivities?: Operation[]; executionInProgress?: boolean; legacy?: boolean }) {
  const { command, pending } = useChat()
  const [expanded, setExpanded] = useState(false)
  const [visibleCount, setVisibleCount] = useState(100)
  const topLevel = [...new Map(activities.filter((activity) => !activity.parentActivityId).map((activity) => [activity.id, activity])).values()]
  const childrenByParent = new Map<string, Operation[]>()
  for (const activity of new Map(execution.activities.map((activity) => [activity.id, activity])).values()) if (activity.parentActivityId) childrenByParent.set(activity.parentActivityId, [...(childrenByParent.get(activity.parentActivityId) ?? []), activity])
  const allActivities = [...topLevel]
  const includedIds = new Set(allActivities.map((activity) => activity.id))
  for (let index = 0; index < allActivities.length; index++) {
    for (const child of childrenByParent.get(allActivities[index].id) ?? []) if (!includedIds.has(child.id)) { includedIds.add(child.id); allActivities.push(child) }
  }
  const childCount = topLevel.filter((activity) => activity.subagent).length
  const failedActivities = groupFailures(allActivities)
  const cancelled = allActivities.filter((activity) => activity.status === 'cancelled' || activity.subagent?.status === 'cancelled').length
  const running = executionInProgress || allActivities.some((activity) => activity.status === 'running' || ['queued', 'running'].includes(activity.subagent?.status ?? ''))
  const summaryStatus = running ? 'running' : failedActivities.length ? 'error' : cancelled ? 'cancelled' : 'complete'
  const canRevert = execution.status !== 'working'
  const changesByIdentity = new Map<string, ChangePreview>()
  for (const activity of allActivities) for (const change of activity.changes ?? []) {
    if (activity.status === 'running') continue
    const key = normalizeActivityFileIdentity(change.path, workspaceRoot) ?? change.path
    changesByIdentity.set(change.id, { ...change, path: key })
  }
  const changes = [...changesByIdentity.values()].filter((change) => change.status === 'applied')
  const changedPaths = new Set(changes.map((change) => normalizeActivityFileIdentity(change.path, workspaceRoot) ?? change.path))
  const changeTotal = changeCounts(changes)
  const detailsId = `${id}-operations`
  const groupId = `agent-inline-group-${id}`
  const pendingSubagents = topLevel.filter((activity) => activity.subagent && ['queued', 'running'].includes(activity.subagent.status))
  const permissionCounts = permissionDecisions?.length ? {
    automatic: permissionDecisions.filter((entry) => entry.decision === 'automatic').length,
    manual: permissionDecisions.filter((entry) => entry.decision === 'manual').length,
    rejected: permissionDecisions.filter((entry) => entry.decision === 'rejected').length,
  } : undefined
  const permissionCountLabel = permissionCounts ? [
    permissionCounts.automatic ? `${permissionCounts.automatic} automatically approved` : '',
    permissionCounts.manual ? `${permissionCounts.manual} manually approved` : '',
    permissionCounts.rejected ? `${permissionCounts.rejected} rejected` : '',
  ].filter(Boolean).join(' · ') : ''
  return <>
    <details id={groupId} className={`agent-inline-activity-group ${summaryStatus}${legacy ? ' legacy' : ''}`} data-progress-id={progressId} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary onClick={(event) => { event.preventDefault(); setExpanded((value) => !value) }} aria-controls={detailsId} aria-expanded={expanded} aria-live="polite">
      <ActivityIcon size={14} strokeWidth={1.7} aria-hidden="true" />
      {legacy && <span className="agent-activity-title">Earlier activity</span>}
      <span className="agent-inline-activity-summary">{groupSummary(allActivities, workspaceRoot, summaryActivities)}</span>
      <span className="agent-inline-operation-count">{allActivities.length} {allActivities.length === 1 ? 'operation' : 'operations'}{childCount ? ` · ${childCount} ${childCount === 1 ? 'sub-agent' : 'sub-agents'}` : ''}</span>
      {permissionCounts && <span className="agent-inline-permission-count">Permissions · {permissionCountLabel}</span>}
      {changedPaths.size > 0 && <span className="agent-inline-change-count" title={`${changedPaths.size} unique changed ${changedPaths.size === 1 ? 'file' : 'files'}`}><span className="agent-change-add">+{changeTotal.added}</span> <span className="agent-change-remove">−{changeTotal.removed}</span></span>}
      {failedActivities.length > 0 && <span className="agent-activity-failure"><CircleAlert size={13} aria-hidden="true" />{failedActivities.length} failed</span>}
      {!failedActivities.length && cancelled > 0 && <span className="agent-activity-cancelled">{cancelled} cancelled</span>}
      {running && <span className="agent-activity-running" aria-label="Execution in progress"><LoaderCircle size={14} aria-hidden="true" /></span>}
      <ChevronRight className="agent-timeline-chevron" size={13} aria-hidden="true" />
    </summary>
    {expanded && sessionId && pendingSubagents.length > 0 && <button className="chat-action" disabled={pending} onClick={() => void command({ action: 'cancel-subagent', id: sessionId })}>Cancel sub-agents</button>}
    {expanded && <ol id={detailsId} className="agent-inline-activity-operations" aria-label="Operations in chronological order">
      {topLevel.slice(0, visibleCount).map((activity) => <li key={activity.id}><ActivityRow activity={activity} children={childrenByParent.get(activity.id)} detailsPrefix={id} sessionId={sessionId} canRevert={canRevert} /></li>)}
      {permissionDecisions?.length ? <li><PermissionDecisionRow decisions={permissionDecisions} id={id} /></li> : null}
      {topLevel.length > visibleCount && <li><button className="chat-action" onClick={() => setVisibleCount((value) => value + 100)}>Show more operations ({topLevel.length - visibleCount} remaining)</button></li>}
    </ol>}
    </details>
  </>
}

/** Ordered, provider-neutral presentation over the unchanged persisted event stream. */
export function AgentTimeline({ execution, executionId, sessionId, fallbackText, choiceBodyContent, workspaceRoot }: { execution: AgentExecution; executionId?: string; sessionId?: string; fallbackText?: string; choiceBodyContent?: string; workspaceRoot?: string }) {
  const changesByPath = new Map<string, { path: string; changes: ChangePreview[] }>()
  for (const activity of execution.activities) for (const change of activity.changes ?? []) {
    if (activity.status === 'running') continue
    const key = normalizeActivityFileIdentity(change.path, workspaceRoot) ?? change.path
    const existing = changesByPath.get(key)
    if (existing) {
      const index = existing.changes.findIndex((entry) => entry.id === change.id)
      if (index >= 0) existing.changes[index] = change
      else existing.changes.push(change)
    } else changesByPath.set(key, { path: change.path, changes: [change] })
  }
  for (const [key, entry] of changesByPath) {
    const active = entry.changes.filter((change) => change.status === 'applied')
    if (active.length) changesByPath.set(key, { ...entry, changes: active })
    else changesByPath.delete(key)
  }
  const changed = [...changesByPath.values()].flatMap((entry) => entry.changes)
  const changedFileCount = changesByPath.size
  const counts = changeCounts(changed)
  const uncapturedFileOperations = execution.status !== 'working'
    ? execution.activities.filter((activity) => activity.status === 'complete'
      && /^(?:create_file|write_file|edit_file|apply_patch|delete_file|rename_file|move_file)$/.test(activity.tool)
      && !activity.changes?.some((change) => change.status === 'applied')).length
    : 0
  const verifiedPaths = new Set(changesByPath.keys())
  const reportedFiles = uncapturedFileOperations
    ? reportedFileChanges(execution.activities, workspaceRoot).filter((file) => {
      const identity = normalizeActivityFileIdentity(file.path, workspaceRoot)
      return !identity || !verifiedPaths.has(identity)
    })
    : []
  const blocks = timelineBlocks(execution, executionId)
  if (execution.permissionDecisions?.length && !blocks.some((block) => block.kind === 'activity-group')) {
    blocks.push({ kind: 'activity-group', id: `permissions-${executionId ?? execution.startedAt}`, activities: [] })
  }
  if (choiceBodyContent !== undefined) {
    let finalText = -1
    for (let index = blocks.length - 1; index >= 0; index--) if (blocks[index].kind === 'text') { finalText = index; break }
    if (finalText >= 0) {
      const block = blocks[finalText]
      if (choiceBodyContent.trim() && block.kind === 'text') block.text = choiceBodyContent
      else blocks.splice(finalText, 1)
    }
  }
  const timelineHasText = blocks.some((block) => block.kind === 'text' && block.text.trim())
  const fallback = choiceBodyContent ?? fallbackText
  if (fallback?.trim() && !timelineHasText) blocks.push({ kind: 'text', id: `fallback-${activitySectionId(execution, executionId)}`, text: fallback })
  let lastActivityIndex = -1
  blocks.forEach((block, index) => { if (block.kind === 'activity-group') lastActivityIndex = index })
  const executionInProgress = execution.status === 'working' && !execution.finishedAt
  const finalTextIndex = lastActivityIndex >= 0 ? blocks.findIndex((block, index) => index > lastActivityIndex && block.kind === 'text') : -1
  const combinedChangesIndex = changed.length || uncapturedFileOperations ? finalTextIndex >= 0 ? finalTextIndex : blocks.length : -1
  const renderCombinedChanges = () => changed.length || reportedFiles.length
    ? <FinalChangeSummary key="final-combined-changes" changesByPath={changesByPath} changedFileCount={changedFileCount} reportedFiles={reportedFiles} counts={counts} sessionId={sessionId} canRevert={execution.status !== 'working'} />
    : <details key="final-combined-changes" className="agent-timeline-change-summary"><summary><span>Final combined changes · diffs unavailable</span><ChevronRight size={13} aria-hidden="true" /></summary><div><div className="agent-timeline-change-row"><span>{uncapturedFileOperations} completed file {uncapturedFileOperations === 1 ? 'operation has' : 'operations have'} no identifiable file path or captured diff.</span></div></div></details>
  return <div id={activitySectionId(execution, executionId)} className="agent-timeline" aria-label="Live agent progress">{blocks.map((block, index) => <Fragment key={block.id}>
    {index === combinedChangesIndex && renderCombinedChanges()}
    {block.kind === 'text' && <ProgressMessage content={block.text} />}
    {block.kind === 'note' && <p className="agent-timeline-note">{block.text}</p>}
    {block.kind === 'activity-group' && <ActivityGroup id={`${executionId ?? execution.startedAt}-${block.id}`} progressId={block.progressId} activities={block.activities} execution={execution} permissionDecisions={index === lastActivityIndex ? execution.permissionDecisions : undefined} sessionId={sessionId} workspaceRoot={workspaceRoot} summaryActivities={index === lastActivityIndex ? execution.activities : undefined} executionInProgress={executionInProgress && index === lastActivityIndex} legacy={block.legacy} />}
  </Fragment>)}{combinedChangesIndex === blocks.length && renderCombinedChanges()}</div>
}

function ChangeReview({ change, sessionId, canRevert }: { change: ChangePreview; sessionId?: string; canRevert: boolean }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const counts = changeCounts([change])
  const revert = async () => {
    if (!sessionId) return
    setBusy(true); setError('')
    try { const result = await desktop.chatContext({ action: 'revert-change', sessionId, id: change.id, confirmed: true }); if (!result.ok) setError(result.message ?? 'Could not revert this change.'); else setConfirm(false) }
    catch { setError('Could not reach Athena.') } finally { setBusy(false) }
  }
  return <details className="agent-change" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary onClick={(event) => { event.preventDefault(); setExpanded((value) => !value) }}><code>{change.path}</code>{change.reviewChunk ? ` · Review chunk ${change.reviewChunk.index}/${change.reviewChunk.total} · ${change.reviewChunk.status}` : ''} · <span className="agent-change-add">+{counts.added}</span> <span className="agent-change-remove">−{counts.removed}</span> · {change.status}</summary>
    {expanded && <><div className="agent-change-diff"><MessageMarkdown content={`\`\`\`diff\n${change.diff}\n\`\`\``} /></div>
      {canRevert && change.revertible !== false && (change.status === 'applied' || change.status === 'proposed' || change.status === 'conflict') && (confirm ? <div className="agent-actions"><span>Restore the previous version if this change was applied? Newer edits will not be overwritten.</span><button disabled={busy} onClick={() => void revert()}>Revert change</button><button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></div> : <button className="chat-action" onClick={() => setConfirm(true)}>{change.status === 'applied' ? 'Revert this file' : 'Recover interrupted change'}</button>)}
      {error && <p className="chat-error" role="alert">{error}</p>}</>}
  </details>
}

const ProgressMessage = memo(function ProgressMessage({ content }: { content: string }) {
  return <div className="chat-message-content"><MessageMarkdown content={content} /></div>
})

function FinalChangeSummary({ changesByPath, changedFileCount, reportedFiles, counts, sessionId, canRevert }: { changesByPath: Map<string, { path: string; changes: ChangePreview[] }>; changedFileCount: number; reportedFiles: Array<{ path: string; operation: string }>; counts: { added: number; removed: number }; sessionId?: string; canRevert: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const totalFiles = changedFileCount + reportedFiles.length
  return <details className="agent-timeline-change-summary" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary onClick={(event) => { event.preventDefault(); setExpanded((value) => !value) }} title="Line totals count only captured, verified diffs."><span>Final combined changes · {totalFiles} {totalFiles === 1 ? 'file' : 'files'}</span>{changedFileCount > 0 && <><span className="agent-change-add">+{counts.added}</span><span className="agent-change-remove">−{counts.removed}</span></>}<ChevronRight size={13} aria-hidden="true" /></summary>{expanded && <div>{[...changesByPath].map(([key, entry]) => <div key={key} className="agent-timeline-change-row"><span>{changeKind(entry.changes[0])} <code>{entry.path}</code>{entry.changes.length > 1 ? ` · ${entry.changes.length} edits` : ''}</span>{entry.changes.map((change) => <ChangeReview key={change.id} change={change} sessionId={sessionId} canRevert={canRevert} />)}</div>)}{reportedFiles.map(file => <div key={`reported-${file.path}`} className="agent-timeline-change-row"><span>{file.operation} <code>{file.path}</code> · reported complete · diff unavailable</span></div>)}{reportedFiles.length > 0 && <div className="agent-timeline-change-row"><span>Exact diffs weren’t captured for the reported entries. Line totals above include captured diffs only.</span></div>}</div>}</details>
}

export function AgentActivity({ execution, executionId }: { execution: AgentExecution; executionId?: string; sessionId?: string }) {
  const setPage = useAthena((state) => state.setPage)
  const working = execution.status === 'working' && !execution.finishedAt
  const savedLogs = execution.activities.filter((activity) => activity.fullOutput)
  const reviewChanges = () => {
    const timeline = document.getElementById(activitySectionId(execution, executionId))
    const target = timeline?.querySelector('.agent-timeline-change-summary, .agent-inline-activity-group')
    const details = target instanceof HTMLDetailsElement ? target : null
    const summary = details?.querySelector(':scope > summary')
    if (details && !details.open && summary instanceof HTMLElement) summary.click()
    scrollWithinTranscript(target ?? null)
    summary instanceof HTMLElement && summary.focus({ preventScroll: true })
  }
  return <section className="agent-execution" aria-label="Agent activity">
    {execution.status === 'waiting-auth' && <div className="agent-auth-recovery" role="alert"><strong>Execution paused — ChatGPT connection expired</strong><p>Completed changes are preserved. Reconnect the same account in Settings → AI, review Activity, then use Continue unfinished task.</p><button className="chat-action" onClick={() => setPage('ai')}>Reconnect account</button>{!!execution.activities.length && <button className="chat-action" onClick={reviewChanges}>Review completed work</button>}</div>}
    {execution.budgetNotice && <p className="chat-context-notice" role="status">{execution.budgetNotice}</p>}
    {execution.recovery && <p className="chat-context-notice" role="status">{working && execution.recovery.continuing ? 'Continuing task…' : `${execution.recovery.attempts} automatic ${execution.recovery.reason === 'stream_interrupted' ? 'connection recovery' : 'output continuation'}${execution.recovery.attempts === 1 ? '' : 's'}`}{working && execution.recovery.continuing ? ` · attempt ${execution.recovery.attempts}` : ''}</p>}
    {working && execution.streamPhase === 'recovering' && <p className="chat-context-notice" role="status">Reconnecting to ChatGPT from the last checkpoint…</p>}
    <StreamDiagnostics items={execution.streamDiagnostics} />
    {!!savedLogs.length && <details><summary>Saved Command Log · {savedLogs.length} {savedLogs.length === 1 ? 'command' : 'commands'}</summary>{savedLogs.map((activity) => <details key={activity.id}><summary>{operationLabel(activity)}</summary><pre>{activity.fullOutput}</pre></details>)}</details>}
  </section>
}

/** Kept separate from operation details so the duration can sit above response text. */
export function AgentDuration({ execution }: { execution: AgentExecution }) {
  const [now, setNow] = useState(Date.now())
  const working = execution.status === 'working' && !execution.finishedAt
  useEffect(() => {
    if (!working) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [working, execution.startedAt])
  return <p className="agent-duration" role="timer">{elapsedLabel(execution.startedAt, execution.finishedAt ?? now, working)}</p>
}
