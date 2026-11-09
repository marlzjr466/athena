import type { AgentApproval } from '../../shared/agent'

export function ApprovalRememberScope({ approval }: { approval: AgentApproval }) {
  if (!approval.rememberScope) return null
  return <p className="permission-detail">Always allow remembers only <strong>{approval.rememberScope.operation.replaceAll('_', ' ')}</strong> for these exact resources in {approval.rememberScope.project}:<br />{approval.rememberScope.resources.map(resource => <code key={resource} style={{ display: 'block', overflowWrap: 'anywhere' }}>{resource}</code>)}{approval.rememberScope.command && <><code style={{ display: 'block', overflowWrap: 'anywhere' }}>{approval.rememberScope.command.manager} {approval.rememberScope.command.args.join(' ')}</code>Only this exact offline command and project configuration. Network, source writes, and dependency writes remain blocked.<br /></>}Revoke anytime in Settings → Privacy → Remembered permissions. Other permissions still apply.</p>
}

export function ApprovalActions({ approval, pending = false, decide, includeScope = true }: {
  approval: AgentApproval
  pending?: boolean
  decide(allow: boolean, remember?: boolean): void
  includeScope?: boolean
}) {
  return <>
    {includeScope && <ApprovalRememberScope approval={approval} />}
    <div className="agent-actions">
      <button disabled={pending} onClick={() => decide(false)}>Deny</button>
      <button disabled={pending} onClick={() => decide(true)}>Allow once</button>
      {approval.rememberScope && <button disabled={pending} onClick={() => decide(true, true)}>Always allow</button>}
    </div>
  </>
}
