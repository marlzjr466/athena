import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatChoices, parseChoicePrompt } from '../src/features/chat/ChatChoices'
import { clipboardHtmlToMarkdown } from '../src/features/chat/richPaste'
import { ChatMessage } from '../src/features/chat/ChatMessage'
import type { ChatMessage as Message } from '../shared/chat'

vi.mock('../src/services/desktop', () => ({ desktop: { copyChatText: vi.fn(async () => ({ ok: true })) } }))
const assistant: Message = { id: 'answer', role: 'assistant', status: 'complete', content: 'Choose one:\n- Use React\n- Use Vue', createdAt: 1 }

describe('assistant choice prompts', () => {
  it('recognizes single and multiple choices but leaves ordinary lists alone', () => {
    expect(parseChoicePrompt('Choose one:\n1. React\n2. Vue')).toEqual({ mode: 'single', options: ['React', 'Vue'] })
    expect(parseChoicePrompt('Which features? Select all that apply:\n- Search\n- Export')).toEqual({ mode: 'multiple', options: ['Search', 'Export'] })
    expect(parseChoicePrompt('Implementation steps:\n- Inspect\n- Test')).toBeNull()
    expect(parseChoicePrompt('Choose one:\n- React\n- Other')).toEqual({ mode: 'single', options: ['React'] })
  })
  it('shows radio choices and sends the selected answer', async () => {
    const send = vi.fn(async () => true)
    render(<ChatMessage message={assistant} canRetry={false} retryDisabled={false} onRetry={() => {}} onAnswerChoice={send} />)
    const article = screen.getByRole('article', { name: 'Athena message' })
    expect(within(article).getAllByRole('radio')).toHaveLength(3)
    fireEvent.click(screen.getByRole('radio', { name: 'Use Vue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send choice' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('Use Vue'))
  })
  it('supports multiple selections and requires an explanation for Other', async () => {
    const send = vi.fn(async () => true)
    render(<ChatChoices prompt={{ mode: 'multiple', options: ['Search', 'Export'] }} disabled={false} onAnswer={send} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Search' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }))
    expect(screen.getByRole('button', { name: 'Send choice' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Explain other choice' }), { target: { value: 'Add filters' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send choice' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('My choices:\n- Search\n- Other: Add filters'))
  })
})

describe('safe rich clipboard content', () => {
  it('preserves paragraphs, line breaks, nested lists, emphasis, and links as Markdown', () => {
    const markdown = clipboardHtmlToMarkdown('<p>Hello<br>world <strong>bold</strong></p><ol><li>First</li><li>Second<ul><li>Nested</li></ul></li></ol><p><a href="https://example.com/docs">Docs</a></p>')
    expect(markdown).toContain('Hello  \nworld **bold**')
    expect(markdown).toContain('1. First\n2. Second\n  - Nested')
    expect(markdown).toContain('[Docs](https://example.com/docs)')
  })
  it('drops executable and unsafe HTML while preserving text', () => {
    const markdown = clipboardHtmlToMarkdown('<p>Safe <a href="javascript:alert(1)">label</a></p><script>alert(1)</script><img src="https://example.com/tracker">')
    expect(markdown).toContain('Safe label')
    expect(markdown).not.toMatch(/javascript:|script|tracker|alert/)
  })
  it('renders formatted user messages without executing HTML', () => {
    const { container } = render(<ChatMessage message={{ ...assistant, role: 'user', content: 'Intro\n\n- First\n- **Second**\n\n<script>alert(1)</script>' }} canRetry={false} retryDisabled={false} onRetry={() => {}} />)
    expect(container.querySelectorAll('.chat-message.user li')).toHaveLength(2)
    expect(screen.getByText('Second').tagName).toBe('STRONG')
    expect(container.querySelector('script')).toBeNull()
  })
  it('converts rich clipboard content while editing a user message', () => {
    render(<ChatMessage message={{ ...assistant, role: 'user', content: 'Before after' }} canRetry={false} retryDisabled={false} onRetry={() => {}} onEdit={vi.fn(async () => true)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    const input = screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement
    input.setSelectionRange(7, 7)
    fireEvent.paste(input, { clipboardData: { getData: (type: string) => type === 'text/html' ? '<p><em>formatted</em><br>next line</p>' : 'formatted next line' } })
    expect(input.value).toContain('Before *formatted*  \nnext lineafter')
  })
})
