import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler } from 'react'
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

const messages = (item?: AgentApproval, status: 'streaming' | 'complete' = 'streaming') => item
  ? [{ id: 'task-1', status, execution: { approval: item } }]
  : [{ id: 'task-1', status, execution: {} }]

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
  const prompt = () => screen.queryByRole('region', { name: 'Approval required' })

  it('renders nothing when the queue is empty', () => {
    render(<HeldPermissionPrompt messages={messages()} sessionId={sessionId} decide={vi.fn()} />)
    expect(prompt()).not.toBeInTheDocument()
    expect(document.querySelector('.agent-approval-host')).toHaveAttribute('hidden')
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

  it.each([2, 3, 5])('hides the prompt between %i consecutive approvals without changing its shell or composer', async (count) => {
    const requests = Array.from({ length: count }, (_, index) => approval(`request-${index + 1}`, `Command ${index + 1}`))
    const decide = vi.fn().mockResolvedValue(true)
    const profilerPhases: string[] = []
    const rect = { x: 0, y: 0, top: 0, right: 600, bottom: 112, left: 0, width: 600, height: 112, toJSON: () => ({}) }
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    function Harness({ item, status = 'streaming', phase = 'thinking' }: { item?: AgentApproval; status?: 'streaming' | 'complete'; phase?: 'idle' | 'thinking' | 'speaking' }) {
      return <><Profiler id="approval-prompt" onRender={(_id, profilerPhase) => profilerPhases.push(profilerPhase)}><HeldPermissionPrompt messages={messages(item, status)} sessionId={sessionId} phase={phase} decide={decide} /></Profiler><textarea aria-label="Composer draft" defaultValue="keep my draft" /></>
    }
    const view = render(<Harness item={requests[0]} />)
    const shell = screen.getByTestId('permission-prompt-shell')
    const host = shell.parentElement as HTMLElement
    const composer = screen.getByRole('textbox', { name: 'Composer draft' })
    expect(host.style.height).toBe('112px')
    fireEvent.change(composer, { target: { value: 'unsent text stays here' } })
    expect(shell).toContainElement(screen.getByText('Command 1'))

    for (let index = 0; index < count; index++) {
      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
      await waitFor(() => expect(host).toHaveAttribute('hidden'))
      expect(screen.queryByText('Decision recorded. Athena is continuing the task.')).not.toBeInTheDocument()
      expect(host.style.height).toBe('')
      expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Approval required' })).not.toBeInTheDocument()
      expect(screen.getByTestId('permission-prompt-shell')).toBe(shell)
      if (index + 1 < count) {
        view.rerender(<Harness item={requests[index + 1]} />)
        expect(host).not.toHaveAttribute('hidden')
        expect(screen.getByTestId('permission-prompt-shell')).toBe(shell)
        expect(screen.getByText(`Command ${index + 2}`)).toBeVisible()
        expect(screen.getByRole('textbox', { name: 'Composer draft' })).toBe(composer)
        expect(composer).toHaveValue('unsent text stays here')
        expect(host.style.height).toBe('112px')
      }
    }

    view.rerender(<Harness status="complete" phase="idle" />)
    expect(host).toHaveAttribute('hidden')
    expect(host.style.height).toBe('')
    expect(screen.getByRole('textbox', { name: 'Composer draft' })).toBe(composer)
    expect(profilerPhases.filter(phase => phase === 'mount')).toHaveLength(1)
    measure.mockRestore()
    expect(decide).toHaveBeenCalledTimes(count)
  })

  it('keeps a failed approval visible, explains the failure, and allows a retry', async () => {
    const decide = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} decide={decide} />)
    const shell = screen.getByTestId('permission-prompt-shell')
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This approval could not be completed. You can try again.')
    expect(screen.getByTestId('permission-prompt-shell')).toBe(shell)
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
    const view = render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} phase="thinking" decide={decide} />)
    const host = document.querySelector('.agent-approval-host')
    const region = screen.getByTestId('permission-prompt-shell')
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(host).toHaveAttribute('hidden'))
    expect(screen.queryByText('Decision recorded. Athena is continuing the task.')).not.toBeInTheDocument()
    view.rerender(<HeldPermissionPrompt messages={messages(secondPrompt)} sessionId={sessionId} phase="thinking" decide={decide} />)
    expect(host).not.toHaveAttribute('hidden')
    expect(screen.getByText('Second command')).toBeVisible()
    view.rerender(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} phase="thinking" decide={decide} />)
    expect(screen.getByTestId('permission-prompt-shell')).toBe(region)
    expect(screen.getByText('Second command')).toBeVisible()
    view.rerender(<HeldPermissionPrompt messages={messages()} sessionId={sessionId} phase="idle" decide={decide} />)
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

  it('keeps a newer pending request active when an older resolution arrives late', async () => {
    let finishFirst: (ok: boolean) => void = () => {}
    const decide = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishFirst = resolve }))
      .mockResolvedValueOnce(true)
    const view = render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} phase="thinking" decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    view.rerender(<HeldPermissionPrompt messages={messages(secondPrompt)} sessionId={sessionId} phase="thinking" decide={decide} />)
    const shell = screen.getByTestId('permission-prompt-shell')
    expect(screen.getByText('Second command')).toBeVisible()
    finishFirst(true)
    await waitFor(() => expect(screen.getByText('Second command')).toBeVisible())
    expect(screen.getByTestId('permission-prompt-shell')).toBe(shell)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(document.querySelector('.agent-approval-host')).toHaveAttribute('hidden'))
    expect(screen.getByTestId('permission-prompt-shell')).toBe(shell)
  })

  it('keeps the prompt visible only while a decision is unresolved, then releases its reserved height', async () => {
    let finish: (ok: boolean) => void = () => {}
    const decide = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const view = render(<HeldPermissionPrompt messages={messages(firstPrompt)} sessionId={sessionId} phase="thinking" decide={decide} />)
    const host = document.querySelector('.agent-approval-host') as HTMLElement
    const shell = screen.getByTestId('permission-prompt-shell')

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(screen.getByRole('status')).toHaveTextContent('Recording your decision…')
    expect(host).not.toHaveAttribute('hidden')

    view.rerender(<HeldPermissionPrompt messages={messages()} sessionId={sessionId} phase="thinking" decide={decide} />)
    expect(screen.getByTestId('permission-prompt-shell')).toBe(shell)
    expect(screen.getByText('First command')).toBeVisible()

    finish(true)
    await waitFor(() => expect(host).toHaveAttribute('hidden'))
    expect(host.style.height).toBe('')
    expect(prompt()).not.toBeInTheDocument()
  })
})
