import { useEffect, useRef, useState } from 'react'
import type { AgentApproval, ChangePreview } from '../../shared/agent'
import { ApprovalActions, ApprovalRememberScope } from './ApprovalActions'
import { MessageMarkdown } from '../features/chat/MessageMarkdown'

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

export function PermissionPrompt({ approval, pending = false, error, decide, label = 'Approval required' }: {
  approval: AgentApproval
  pending?: boolean
  error?: string
  decide(allow: boolean, remember?: boolean): void
  label?: string
}) {
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => {
    region.current?.focus({ preventScroll: true })
  }, [approval.id])
  return <div id={`approval-${approval.id}`} ref={region} className="agent-approval" role="region" aria-label={label} tabIndex={-1}>
    <div className="agent-approval-body" key={approval.id}>
      <h4>{approval.title}</h4>
      <pre>{approval.description}</pre>
      {approval.changes?.map((change) => <ApprovalChange key={change.id} change={change} />)}
      <ApprovalRememberScope approval={approval} />
      {error && <p className="permission-error" role="alert">{error}</p>}
    </div>
    <ApprovalActions approval={approval} pending={pending} decide={decide} includeScope={false} />
  </div>
}

const approvalFailed = 'This approval could not be completed. You can try again.'

export function HeldPermissionPrompt({
  messages,
  sessionId,
  label = 'Approval required',
  decide,
}: {
  messages: Array<{ execution?: { approval?: AgentApproval } }>
  sessionId?: string
  label?: string
  decide(approvalId: string, allow: boolean, remember?: boolean): boolean | Promise<boolean>
}) {
  const live = latestPendingApproval(messages)
  const sessionRef = useRef(sessionId)
  const resolvedIds = useRef(new Set<string>())
  const submittedRef = useRef<string | undefined>(undefined)
  const heldRef = useRef<AgentApproval | undefined>(live)
  const failureRef = useRef<{ id: string; message: string } | undefined>(undefined)
  const [, setRevision] = useState(0)
  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId
    resolvedIds.current = new Set()
    submittedRef.current = undefined
    heldRef.current = live
    failureRef.current = undefined
  }
  const selected = selectActiveApproval({
    live,
    sessionId,
    previousSessionId: sessionId,
    held: heldRef.current,
    submittedId: submittedRef.current,
    resolvedIds: resolvedIds.current,
  })
  heldRef.current = selected.approval
  const approval = selected.approval
  if (!approval || !sessionId) return null
  const failure = failureRef.current?.id === approval.id ? failureRef.current.message : undefined
  return <PermissionPrompt approval={approval} pending={selected.processing} error={failure} label={label} decide={(allow, remember) => {
    const id = approval.id
    if (submittedRef.current === id || resolvedIds.current.has(id)) return
    submittedRef.current = id
    if (failureRef.current?.id === id) failureRef.current = undefined
    setRevision((value) => value + 1)
    void Promise.resolve(decide(id, allow, remember)).then((ok) => {
      if (sessionRef.current !== sessionId) return
      if (ok) resolvedIds.current.add(id)
      else if (!resolvedIds.current.has(id)) failureRef.current = { id, message: approvalFailed }
      if (submittedRef.current === id) submittedRef.current = undefined
      setRevision((value) => value + 1)
    }, () => {
      if (sessionRef.current !== sessionId) return
      if (!resolvedIds.current.has(id)) failureRef.current = { id, message: approvalFailed }
      if (submittedRef.current === id) submittedRef.current = undefined
      setRevision((value) => value + 1)
    })
  }} />
}
