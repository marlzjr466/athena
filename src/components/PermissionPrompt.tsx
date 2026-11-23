import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { AgentApproval, ChangePreview } from '../../shared/agent'
import type { ChatPhase, ChatMessage } from '../../shared/chat'
import { ApprovalActions, ApprovalRememberScope } from './ApprovalActions'
import { MessageMarkdown } from '../features/chat/MessageMarkdown'

type ApprovalMessage = { id: string; status: ChatMessage['status']; execution?: { approval?: AgentApproval } }
type ApprovalRecord = { approval: AgentApproval; taskId: string }

function latestApprovalRecord(messages: ApprovalMessage[]): ApprovalRecord | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const approval = message.execution?.approval
    if (approval) return { approval, taskId: message.id }
  }
}

export function latestPendingApproval<T extends { execution?: { approval?: AgentApproval } }>(messages: T[]): AgentApproval | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const approval = messages[index]?.execution?.approval
    if (approval) return approval
  }
}

export function selectActiveApproval({
  live,
  sessionId,
  previousSessionId,
  held,
  submittedId,
  resolvedIds,
}: {
  live?: AgentApproval
  sessionId?: string
  previousSessionId?: string
  held?: AgentApproval
  submittedId?: string
  resolvedIds: ReadonlySet<string>
}): { approval?: AgentApproval; processing: boolean } {
  if (sessionId !== previousSessionId) return { approval: live && !resolvedIds.has(live.id) ? live : undefined, processing: false }
  if (live && !resolvedIds.has(live.id)) return { approval: live, processing: submittedId === live.id }
  if (live && resolvedIds.has(live.id) && held && held.id !== live.id && !resolvedIds.has(held.id)) return { approval: held, processing: submittedId === held.id }
  return { approval: undefined, processing: false }
}

function ApprovalChange({ change }: { change: ChangePreview }) {
  return <details className="agent-approval-change">
    <summary><code>{change.path}</code>{change.reviewChunk ? ` · Review chunk ${change.reviewChunk.index}/${change.reviewChunk.total}` : ''} · {change.status}</summary>
    <MessageMarkdown content={`\`\`\`diff\n${change.diff}\n\`\`\``} />
  </details>
}

function ApprovalShell({ approval, pending = false, error, decide, label = 'Approval required' }: {
  approval?: AgentApproval
  pending?: boolean
  error?: string
  decide?(allow: boolean, remember?: boolean): void
  label?: string
}) {
  const region = useRef<HTMLDivElement>(null)
  const activeId = approval?.id
  useLayoutEffect(() => {
    if (activeId) region.current?.focus({ preventScroll: true })
  }, [activeId])

  return <div id={activeId ? `approval-${activeId}` : undefined} ref={region} className="agent-approval" data-testid="permission-prompt-shell" role="region" aria-label={label} tabIndex={-1}>
    <div className="agent-approval-body">
      {approval ? <>
        <h4>{approval.title}</h4>
        <pre>{approval.description}</pre>
        {approval.changes?.map((change) => <ApprovalChange key={change.id} change={change} />)}
        <ApprovalRememberScope approval={approval} />
        {error && <p className="permission-error" role="alert">{error}</p>}
        {pending && <p className="permission-continuation" role="status">Recording your decision…</p>}
      </> : null}
    </div>
    {approval && decide && <ApprovalActions approval={approval} pending={pending} decide={decide} includeScope={false} />}
  </div>
}

export function PermissionPrompt({ approval, pending = false, error, decide, label = 'Approval required' }: {
  approval: AgentApproval
  pending?: boolean
  error?: string
  decide(allow: boolean, remember?: boolean): void
  label?: string
}) {
  return <ApprovalShell approval={approval} pending={pending} error={error} decide={decide} label={label} />
}

const approvalFailed = 'This approval could not be completed. You can try again.'

interface PromptState {
  sessionId?: string
  processing: Map<string, ApprovalRecord>
  resolved: Set<string>
  failed: Map<string, { record: ApprovalRecord; message: string }>
}

type PromptAction =
  | { type: 'reset'; sessionId?: string }
  | { type: 'submit'; sessionId?: string; record: ApprovalRecord }
  | { type: 'resolved'; sessionId?: string; id: string }
  | { type: 'failed'; sessionId?: string; id: string; record: ApprovalRecord }

function createPromptState(sessionId?: string): PromptState {
  return { sessionId, processing: new Map(), resolved: new Set(), failed: new Map() }
}

function promptReducer(state: PromptState, action: PromptAction): PromptState {
  if (action.type === 'reset') return createPromptState(action.sessionId)
  if (state.sessionId !== action.sessionId) return state
  if (action.type === 'submit') {
    if (state.resolved.has(action.record.approval.id) || state.processing.has(action.record.approval.id)) return state
    const processing = new Map(state.processing); processing.set(action.record.approval.id, action.record)
    const failed = new Map(state.failed); failed.delete(action.record.approval.id)
    return { ...state, processing, failed }
  }
  if (action.type === 'resolved') {
    if (state.resolved.has(action.id)) return state
    const processing = new Map(state.processing); processing.delete(action.id)
    const failed = new Map(state.failed); failed.delete(action.id)
    const resolved = new Set(state.resolved); resolved.add(action.id)
    return { ...state, processing, failed, resolved }
  }
  if (state.resolved.has(action.id)) return state
  const processing = new Map(state.processing); processing.delete(action.id)
  const failed = new Map(state.failed); failed.set(action.id, { record: action.record, message: approvalFailed })
  return { ...state, processing, failed }
}

export function HeldPermissionPrompt({
  messages,
  sessionId,
  phase = 'idle',
  label = 'Approval required',
  decide,
}: {
  messages: ApprovalMessage[]
  sessionId?: string
  phase?: ChatPhase
  label?: string
  decide(approvalId: string, allow: boolean, remember?: boolean): boolean | Promise<boolean>
}) {
  const liveRecord = latestApprovalRecord(messages)
  const [stored, dispatch] = useReducer(promptReducer, sessionId, createPromptState)
  const state = stored.sessionId === sessionId ? stored : createPromptState(sessionId)
  const sessionRef = useRef(sessionId)
  const latestUnresolvedRef = useRef<ApprovalRecord | undefined>(undefined)
  const inFlightRef = useRef(new Set<string>())
  const [shellHeight, setShellHeight] = useState<number>()
  const region = useRef<HTMLDivElement>(null)
  const sessionChanged = sessionRef.current !== sessionId

  useLayoutEffect(() => {
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId
      latestUnresolvedRef.current = undefined
      inFlightRef.current = new Set()
    }
    if (liveRecord && !state.resolved.has(liveRecord.approval.id)) latestUnresolvedRef.current = liveRecord
    if (latestUnresolvedRef.current && state.resolved.has(latestUnresolvedRef.current.approval.id)) latestUnresolvedRef.current = undefined
  }, [sessionId, liveRecord?.approval.id, state])

  useEffect(() => {
    if (stored.sessionId !== sessionId) dispatch({ type: 'reset', sessionId })
  }, [stored.sessionId, sessionId])

  const taskIsActive = (record: ApprovalRecord | undefined) => !!record && phase !== 'idle' && messages.some(message => message.id === record.taskId && message.status === 'streaming')
  const currentRecord = liveRecord && !state.resolved.has(liveRecord.approval.id)
    ? liveRecord
    : !sessionChanged && latestUnresolvedRef.current && !state.resolved.has(latestUnresolvedRef.current.approval.id) && taskIsActive(latestUnresolvedRef.current) ? latestUnresolvedRef.current : undefined
  const failedEntry = [...state.failed.values()].reverse().find(entry => taskIsActive(entry.record))
  const approval = currentRecord?.approval ?? failedEntry?.record.approval
  const failedMessage = approval ? state.failed.get(approval.id)?.message : undefined
  const processing = !!(approval && state.processing.has(approval.id))
  const present = !!approval

  useLayoutEffect(() => {
    if (!present) {
      if (shellHeight !== undefined) setShellHeight(undefined)
      return
    }
    if (shellHeight === undefined && approval) {
      const height = region.current?.getBoundingClientRect().height ?? 0
      if (height > 0) setShellHeight(Math.min(170, Math.ceil(height)))
    }
  }, [present, approval?.id, shellHeight])

  if (!sessionId) return null

  return <div ref={region} hidden={!present} aria-hidden={!present} className={`agent-approval-host${present && shellHeight ? ' locked' : ''}`} style={present && shellHeight ? { height: shellHeight } : undefined}>
    <ApprovalShell approval={approval} pending={processing} error={failedMessage} label={label} decide={approval ? (allow, remember) => {
      const record = currentRecord ?? failedEntry?.record
      if (!record || state.resolved.has(record.approval.id) || state.processing.has(record.approval.id) || inFlightRef.current.has(record.approval.id)) return
      inFlightRef.current.add(record.approval.id)
      dispatch({ type: 'submit', sessionId, record })
      void Promise.resolve(decide(record.approval.id, allow, remember)).then((ok) => {
        if (sessionRef.current !== sessionId) return
        inFlightRef.current.delete(record.approval.id)
        if (ok) dispatch({ type: 'resolved', sessionId, id: record.approval.id })
        else dispatch({ type: 'failed', sessionId, id: record.approval.id, record })
      }, () => {
        if (sessionRef.current === sessionId) {
          inFlightRef.current.delete(record.approval.id)
          dispatch({ type: 'failed', sessionId, id: record.approval.id, record })
        }
      })
    } : undefined} />
  </div>
}
