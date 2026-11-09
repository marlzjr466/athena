import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalActions } from '../src/components/ApprovalActions'
import type { AgentApproval } from '../shared/agent'
const approval: AgentApproval = { id: 'host-id', title: 'Open app', description: 'Open VS Code', rememberScope: { operation: 'open_application', project: 'desktop', resources: ['vscode'] } }
describe('shared approval controls', () => {
  it('shows exact scope and sends three distinct decisions only on user clicks', () => {
    const decide = vi.fn(); render(<ApprovalActions approval={approval} decide={decide} />)
    expect(decide).not.toHaveBeenCalled(); expect(screen.getByText('vscode')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' })); expect(decide).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' })); expect(decide).toHaveBeenLastCalledWith(true, true)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' })); expect(decide).toHaveBeenLastCalledWith(false)
  })
  it('shows Always allow and sandbox restrictions for an eligible npm test prompt', () => {
    const decide = vi.fn()
    render(<ApprovalActions approval={{ ...approval, title: 'Run isolated project command', rememberScope: { operation: 'sandbox_check_command', project: '/project', resources: ['/project'], command: { tool: 'cursor-terminal', manager: 'npm', executable: '/npm', executableIdentity: 'fixture', args: ['test', '--', 'check.test.ts'], packageHash: 'a'.repeat(64), sandbox: 'project-offline-no-source-or-dependency-writes-v1' } } }} decide={decide} />)
    expect(screen.getByText('npm test -- check.test.ts')).toBeVisible()
    expect(screen.getByText(/Network, source writes, and dependency writes remain blocked/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(decide).toHaveBeenCalledWith(true, true)
  })
  it('never offers remembering for mandatory sensitive approvals', () => {
    render(<ApprovalActions approval={{ ...approval, rememberScope: undefined }} decide={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeVisible()
  })
  it('prevents repeated pending decisions', () => {
    const decide = vi.fn(); render(<ApprovalActions approval={approval} pending decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' })); expect(decide).not.toHaveBeenCalled()
  })
})
