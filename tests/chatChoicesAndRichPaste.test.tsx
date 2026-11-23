import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatChoices, parseChoiceInteraction, parseChoicePrompt } from '../src/features/chat/ChatChoices'
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
  it('recognizes the Figma clarification despite an example in the question and preserves option order', () => {
    const result = parseChoiceInteraction('Trace: verified.\n\nIs there a Figma screen or BA mockup (for example an HTML file) for this Checker view?\n\nChoose one:\n\n- Yes — I’ll point to the file or link\n\n- No — design the UI from the written spec (`ui_source: generated`)', { conversationId: 'session-1', messageId: 'answer-1' })
    expect(result?.interaction.question).toContain('Is there a Figma screen')
    expect(result?.interaction.options).toEqual(['Yes — I’ll point to the file or link', 'No — design the UI from the written spec (ui_source: generated)'])
    expect(result?.bodyContent).toBe('Trace: verified.')
  })
  it('recognizes explicit status choices but leaves rhetorical questions and prose lists alone', () => {
    expect(parseChoiceInteraction('Which status should I follow?\n\nChoose one:\n- Treat `events.yaml` as current\n- Treat `workflow.yaml` as current\n- Something else (say what)', { conversationId: 's', messageId: 'm' })?.interaction.options).toEqual(['Treat events.yaml as current', 'Treat workflow.yaml as current', 'Something else (say what)'])
    expect(parseChoiceInteraction('Have you considered this?\n- First step\n- Second step', { conversationId: 's', messageId: 'm' })).toBeNull()
    expect(parseChoiceInteraction('Implementation steps:\n- Inspect\n- Test', { conversationId: 's', messageId: 'm' })).toBeNull()
  })
  it('shows radio choices and sends the selected answer', async () => {
    const send = vi.fn(async () => true)
    render(<ChatMessage message={assistant} canRetry={false} retryDisabled={false} onRetry={() => {}} onAnswerChoice={send} />)
    const article = screen.getByRole('article', { name: 'Athena message' })
    expect(within(article).getAllByRole('radio')).toHaveLength(2)
    fireEvent.click(screen.getByRole('radio', { name: 'Use Vue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send choice' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('Use Vue'))
  })
  it('renders one answer card for the reported Figma question without duplicating the markdown options', () => {
    const message: Message = { ...assistant, id: 'figma-question', content: 'Is there a Figma screen or BA mockup (for example an HTML file) for this Checker view?\n\nChoose one:\n- Yes — I’ll point to the file or link\n- No — design the UI from the written spec (`ui_source: generated`)' }
    render(<ChatMessage message={message} canRetry={false} retryDisabled={false} onRetry={() => {}} onAnswerChoice={vi.fn(async () => true)} />)
    expect(screen.getByRole('group', { name: /Is there a Figma screen/ })).toBeVisible()
    expect(screen.getAllByText(/Yes — I’ll point to the file or link/)).toHaveLength(1)
    expect(screen.getAllByText(/No — design the UI from the written spec/)).toHaveLength(1)
  })
  it('supports multiple selections and requires an explanation for Other', async () => {
    const send = vi.fn(async () => true)
    render(<ChatChoices interaction={{ id: 'choice', conversationId: 's', messageId: 'm', type: 'choice', question: 'Select all that apply', mode: 'multiple', options: ['Search', 'Export'], freeTextOptions: [], allowOther: true, status: 'pending' }} disabled={false} onAnswer={send} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Search' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }))
    expect(screen.getByRole('button', { name: 'Send choice' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Explain your choice' }), { target: { value: 'Add filters' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send choice' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('My choices:\n- Search\n- Other: Add filters'))
  })
  it('renders the stored interaction as answered after restoration', () => {
    render(<ChatChoices interaction={{ id: 'choice', conversationId: 's', messageId: 'm', type: 'choice', question: 'Which?', mode: 'single', options: ['A', 'B'], freeTextOptions: [], allowOther: false, status: 'answered', answerMessageId: 'answer', answer: 'B' }} disabled onAnswer={vi.fn(async () => true)} />)
    expect(screen.getByRole('radio', { name: 'B' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Choice sent' })).toBeDisabled()
    expect(screen.getByText('Answer sent: B')).toBeVisible()
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
