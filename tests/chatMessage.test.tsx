import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatMessage } from '../src/features/chat/ChatMessage'
import type { ChatMessage as Message } from '../shared/chat'
vi.mock('../src/services/desktop', () => ({ desktop: { copyChatText: vi.fn(async () => ({ ok: true })) } }))
const message: Message = { id: 'one', role: 'user', content: 'Hello\nWorld', status: 'complete', createdAt: 1 }
describe('conversation message presentation', () => {
  it('keeps accessible role labels without visible author headings', () => {
    const { container } = render(<ChatMessage message={message} canRetry={false} retryDisabled={false} onRetry={() => {}} />)
    expect(screen.getByRole('article', { name: 'Your message' })).toHaveClass('user')
    expect(container.querySelector('header')).toBeNull()
    expect(screen.queryByText('YOU')).toBeNull()
    expect(screen.queryByText('ATHENA')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeVisible()
    expect(screen.getByRole('article', { name: 'Your message' })).not.toContainElement(screen.getByRole('button', { name: 'Copy message' }))
    expect(container.querySelector('footer')).toBeNull()
  })
  it('highlights only persisted, resolved slash commands and leaves ordinary slash text plain', () => {
    const recognized: Message = { ...message, content: '/platform-spec MBM-11559', command: { id: 'project:one', name: '/platform-spec', source: 'Claude Project', arguments: 'MBM-11559' } }
    const { container, rerender } = render(<ChatMessage message={recognized} canRetry={false} retryDisabled={false} onRetry={() => {}} />)
    expect(container.querySelector('.chat-sent-command')).toHaveTextContent('/platform-spec')
    expect(screen.getByRole('article', { name: 'Your message' })).toHaveClass('user')
    expect(container.querySelector('.chat-sent-command svg')).toBeTruthy()
    expect(screen.getByText(/MBM-11559/)).toBeVisible()
    rerender(<ChatMessage message={{ ...recognized, command: undefined }} canRetry={false} retryDisabled={false} onRetry={() => {}} />)
    expect(container.querySelector('.chat-sent-command')).toBeNull()
  })
  it('places editing outside the user bubble and still resends', async () => {
    const edit = vi.fn(async () => true)
    render(<ChatMessage message={message} canRetry={false} retryDisabled={false} onRetry={() => {}} onEdit={edit} />)
    const button = screen.getByRole('button', { name: 'Edit message' })
    expect(screen.getByRole('article', { name: 'Your message' })).not.toContainElement(button)
    fireEvent.click(button)
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Updated' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save & resend' }).closest('form')!)
    expect(edit).toHaveBeenCalledWith('Updated')
    await screen.findByRole('button', { name: 'Edit message' })
  })
  it('renders assistant Markdown and preserves retry', () => {
    const retry = vi.fn()
    render(<ChatMessage message={{ ...message, role: 'assistant', content: '**Hello**' }} canRetry retryDisabled={false} onRetry={retry} />)
    expect(screen.getByRole('article', { name: 'Athena message' })).toHaveClass('assistant')
    expect(screen.getByText('Hello').tagName).toBe('STRONG')
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry response' }))
    expect(retry).toHaveBeenCalledOnce()
  })
  it('shows an early streaming indicator and no premature copy or retry', () => {
    render(<ChatMessage message={{ ...message, role: 'assistant', content: '', status: 'streaming' }} canRetry retryDisabled onRetry={() => {}} />)
    expect(screen.getByLabelText('Preparing response')).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('places duration after source evidence, keeps source evidence, hides usage panels, and puts time beside AI actions', () => {
    const execution: NonNullable<Message['execution']> = {
      startedAt: 1_000, updatedAt: 9_000, finishedAt: 9_000, status: 'complete', activities: [],
      contextUsage: {
        inputTokens: 100, outputTokens: 20, totalTokens: 120, contextTokens: 120, contextWindow: 10_000,
        remainingTokens: 9_880, toolTokens: 0, estimated: true, contextEstimated: true,
        modelLimitsVerified: false, estimatedCostUsd: null, compactions: 0, status: 'ready', show: true,
        lastResponse: { inputTokens: 100, outputTokens: 20, reasoningTokens: null, toolArgumentChars: 0, outputBudget: 500 },
      },
    }
    const aiMessage: Message = {
      ...message, role: 'assistant', content: 'Answer text', execution,
      sources: [{ workspace: 'Project', path: 'src/main.ts', start: 3, end: 8 }],
    }
    const { container } = render(<ChatMessage message={aiMessage} canRetry={false} retryDisabled={false} onRetry={() => {}} />)
    const article = screen.getByRole('article', { name: 'Athena message' })
    expect(screen.getByText('Source Evidence · 1 files')).toBeVisible()
    expect(article.querySelector('.chat-sources code')?.textContent).toBe('Project/src/main.ts:3–8')
    const sources = article.querySelector('.chat-sources')!
    const duration = article.querySelector('.agent-duration')!
    expect(sources.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(duration.compareDocumentPosition(article.querySelector('footer')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(/Latest response usage/i)).toBeNull()
    expect(screen.queryByText(/Context:/i)).toBeNull()
    const footer = article.querySelector('footer')!
    expect(footer).toContainElement(footer.querySelector('time'))
    expect(within(footer).getByRole('button', { name: 'Copy message' })).toBeVisible()
    expect(container.querySelectorAll('time')).toHaveLength(1)
  })
  it('shows a saved assistant warning in the conversation after source evidence', () => {
    const aiMessage: Message = {
      ...message, role: 'assistant', status: 'error', content: 'The task could not finish.',
      error: 'Review completed operations before resuming.',
      sources: [{ workspace: 'Project', path: 'src/main.ts', start: 3, end: 8 }],
    }
    const { container } = render(<ChatMessage message={aiMessage} canRetry retryDisabled={false} onRetry={() => {}} />)
    const sources = container.querySelector('.chat-sources')!
    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent(aiMessage.error!)
    expect(sources.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('shows themed tooltips on pointer hover and keyboard focus, and omits user timestamps', async () => {
    render(<ChatMessage message={message} canRetry={false} retryDisabled={false} onRetry={() => {}} onEdit={vi.fn(async () => true)} />)
    const copy = screen.getByRole('button', { name: 'Copy message' })
    fireEvent.mouseEnter(copy.parentElement!)
    expect(await screen.findByRole('tooltip', { name: 'Copy message' })).toBeVisible()
    fireEvent.mouseLeave(copy.parentElement!)
    expect(screen.queryByRole('tooltip')).toBeNull()

    const edit = screen.getByRole('button', { name: 'Edit message' })
    fireEvent.focus(edit)
    expect(await screen.findByRole('tooltip', { name: 'Edit and resend' })).toBeVisible()
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).toBeNull()
    expect(copy).toHaveClass('chat-icon-action')
    expect(edit).toHaveClass('chat-icon-action')
    expect(copy.querySelector('svg')).toHaveAttribute('width', '16')
    expect(edit.querySelector('svg')).toHaveAttribute('width', '16')
    expect(screen.getByLabelText('Message actions')).toHaveClass('chat-user-actions')
  })
})
