import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeldPermissionPrompt, PermissionPrompt, latestPendingApproval, selectActiveApproval } from '../src/components/PermissionPrompt'
import type { AgentApproval } from '../shared/agent'

const approval = (id: string, title = `Prompt ${id}`): AgentApproval => ({
  id,
  title,
  description: `${title} details`,
  rememberScope: { operation: 'sandbox_check_command', project: '/project', resources: ['/project'] },
})

const first = approval('11111111-1111-4111-8111-111111111111', 'Run isolated project command')
first.description = `${'npm test -- project.test.ts\nWorking directory: authorized project\n'.repeat(20)}`
first.changes = [{ id: 'change', path: 'src/add.ts', diff: '+export const add = 1', status: 'proposed' }]

const messages = (item?: AgentApproval) => item ? [{ execution: { approval: item } }] : [{ execution: {} }]

describe('composer permission prompt', () => {
  it('keeps approval details in the scrollable body and sends the existing decisions', () => {
    const decide = vi.fn()
    render(<PermissionPrompt approval={first} decide={decide} />)
    const region = screen.getByRole('region', { name: 'Approval required' })
    expect(region).toHaveAttribute('id', `approval-${first.id}`)
    expect(region.querySelector('.agent-approval-body')).toContainElement(screen.getByText('Run isolated project command'))
    expect(region.querySelector('.agent-approval-body')).toContainElement(screen.getByText(/npm test -- project.test.ts/))
    expect(screen.getByText('+export const add = 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(decide).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(decide).toHaveBeenLastCalledWith(true, true)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(decide).toHaveBeenLastCalledWith(false)
  })

  it('uses only the latest pending approval from the active conversation messages', () => {
    expect(latestPendingApproval([])).toBeUndefined()
    expect(latestPendingApproval([
      { execution: { approval: { id: 'old', title: 'Older', description: 'first' } } },
      { execution: { approval: { id: 'new', title: 'Newer', description: 'second' } } },
    ])).toMatchObject({ id: 'new' })
  })
})

describe('active approval selection', () => {
  const session = 'session-a'
  const resolved = (id: string) => new Set([id])

  it('hides a resolved approval when nothing else is pending', () => {
    expect(selectActiveApproval({ live: undefined, sessionId: session, previousSessionId: session, held: approval('a'), submittedId: 'a', resolvedIds: resolved('a') })).toEqual({ approval: undefined, processing: false })
    expect(selectActiveApproval({ live: approval('a'), sessionId: session, previousSessionId: session, held: approval('a'), submittedId: 'a', resolvedIds: resolved('a') })).toEqual({ approval: undefined, processing: false })
  })

  it('shows the next unresolved approval directly', () => {
    const next = approval('b')
    expect(selectActiveApproval({ live: next, sessionId: session, previousSessionId: session, held: approval('a'), submittedId: 'a', resolvedIds: resolved('a') })).toEqual({ approval: next, processing: false })
  })

  it('keeps the newer prompt when a resolved approval is published again', () => {
    const current = approval('b')
    expect(selectActiveApproval({ live: approval('a'), sessionId: session, previousSessionId: session, held: current, submittedId: undefined, resolvedIds: resolved('a') })).toEqual({ approval: current, processing: false })
  })

  it('marks only the approval that is waiting on a response as processing', () => {
    const current = approval('a')
    expect(selectActiveApproval({ live: current, sessionId: session, previousSessionId: session, held: current, submittedId: 'a', resolvedIds: new Set() })).toEqual({ approval: current, processing: true })
  })

  it('shows only the active conversation prompt after a session switch', () => {
    const next = approval('c')
    expect(selectActiveApproval({ live: next, sessionId: 'session-b', previousSessionId: session, held: approval('a'), submittedId: 'a', resolvedIds: new Set() })).toEqual({ approval: next, processing: false })
    expect(selectActiveApproval({ live: approval('a'), sessionId: 'session-b', previousSessionId: session, held: approval('a'), submittedId: 'a', resolvedIds: resolved('a') })).toEqual({ approval: undefined, processing: false })
  })
})

describe('permission prompt lifecycle', () => {
  const sessionId = '00000000-0000-4000-a000-000000000002'
  const firstPrompt = approval('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'First command')
  const secondPrompt = approval('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Second command')
  const thirdPrompt = approval('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Third command')
  const prompt = () => screen.queryByRole('region', { name: 'Approval required' })

  it('renders nothing when the queue is empty', () => {
    render(<HeldPermissionPrompt messages={messages()} sessionId={sessionId} decide={vi.fn()} />)
    expect(prompt()).not.toBeInTheDocument()
  })

  it.each([
    ['Allow once', true, undefined],
    ['Always allow', true, true],
    ['Deny', false, undefined],
  ] as const)('removes the only pending prompt after %s succeeds', async (label, allow, remember) => {
    const decide = vi.fn().mockResolvedValue(true)
    render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    expect(decide.mock.calls[0][0]).toBe(firstPrompt.id)
    expect(decide.mock.calls[0][1]).toBe(allow)
    expect(decide.mock.calls[0][2]).toBe(remember)
  })

  it('keeps the same prompt shell when the next approval replaces the current one', async () => {
    const decide = vi.fn().mockResolvedValue(true)
    const view = render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    const region = screen.getByRole('region', { name: 'Approval required' })
    view.rerender(<HeldPermissionPrompt messages={messages(secondPrompt)} sessionId={sessionId} decide={decide} />)
    expect(screen.getByRole('region', { name: 'Approval required' })).toBe(region)
    expect(screen.getByText('Second command')).toBeVisible()
    expect(screen.queryByText('First command')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
  })

  it('shows each later approval after the previous decision succeeds', async () => {
    const decide = vi.fn().mockResolvedValue(true)
    const view = render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    view.rerender(<HeldPermissionPrompt messages={messages(secondPrompt)} sessionId={sessionId} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    view.rerender(<HeldPermissionPrompt messages={messages(thirdPrompt)} sessionId={sessionId} decide={decide} />)
    expect(screen.getByText('Third command')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    expect(decide.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
      [firstPrompt.id, true, undefined],
      [secondPrompt.id, false, undefined],
      [thirdPrompt.id, true, true],
    ])
  })

  it('keeps a failed approval visible, explains the failure, and allows a retry', async () => {
    const decide = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This approval could not be completed. You can try again.')
    expect(screen.getByText('First command')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    expect(decide).toHaveBeenCalledTimes(2)
    expect(decide.mock.calls[1][1]).toBe(false)
  })

  it('does not submit the same approval twice while its response is outstanding', async () => {
    let finish: (ok: boolean) => void = () => {}
    const decide = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(decide).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled()
    finish(true)
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
  })

  it('does not restore a resolved prompt from a duplicate or late approval event', async () => {
    const decide = vi.fn().mockResolvedValue(true)
    const view = render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    view.rerender(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    expect(prompt()).not.toBeInTheDocument()
    view.rerender(<HeldPermissionPrompt messages={messages(secondPrompt)} sessionId={sessionId} decide={decide} />)
    const region = screen.getByRole('region', { name: 'Approval required' })
    view.rerender(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    expect(screen.getByRole('region', { name: 'Approval required' })).toBe(region)
    expect(screen.getByText('Second command')).toBeVisible()
    view.rerender(<HeldPermissionPrompt messages={messages()} sessionId={sessionId} decide={decide} />)
    expect(prompt()).not.toBeInTheDocument()
  })

  it('accepts the next approval while an earlier response is still outstanding and does not let that response replace it', async () => {
    let finish: (ok: boolean) => void = () => {}
    const decide = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve }))
      .mockResolvedValue(true)
    const view = render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    view.rerender(<HeldPermissionPrompt messages={messages(secondPrompt)} sessionId={sessionId} decide={decide} />)
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    finish(true)
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    expect(decide.mock.calls.map((call) => call[0])).toEqual([firstPrompt.id, secondPrompt.id])
    view.rerender(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    expect(prompt()).not.toBeInTheDocument()
  })
})
