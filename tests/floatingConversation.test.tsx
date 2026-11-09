import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FloatingConversation } from '../src/features/floating/FloatingConversation'
import { connectChat, useChat } from '../src/store/chatStore'
import { useAthena } from '../src/store/athenaStore'
import { emptyChatSnapshot } from '../shared/chat'
import { defaultConversationConfig } from '../shared/conversations'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'

const mock = vi.hoisted(() => ({
  getChat: vi.fn(), onChat: vi.fn(() => () => {}), chatSession: vi.fn(async () => ({ ok: true })),
  sendChat: vi.fn(async () => ({ ok: true })), stopChat: vi.fn(async () => ({ ok: true })),
  chatContext: vi.fn(async () => ({ ok: true })), stopSpeech: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../src/services/desktop', () => ({ desktop: mock }))

const sessionId = '00000000-0000-4000-a000-000000000088'
const chat = (phase: 'idle' | 'thinking' = 'idle') => ({ ...emptyChatSnapshot(), sessionId, revision: 1, phase, config: { ...defaultConversationConfig(), model: 'gpt-5.2' }, draft: '', attachments: [], workspaces: [] })
let disconnect: (() => void) | undefined
beforeEach(() => {
  vi.clearAllMocks()
  mock.getChat.mockResolvedValue(chat())
  useChat.setState({ snapshot: emptyChatSnapshot(), pending: false, issue: null })
  useAthena.setState({ snapshot: { settings: { ...defaultSettings }, state: 'idle' } as Snapshot })
})
afterEach(() => { disconnect?.(); disconnect = undefined })

describe('floating conversation stays text-only while voice is hands-free', () => {
  it('sends typed messages through the existing session-bound chat pipeline', async () => {
    disconnect = connectChat()
    render(<FloatingConversation />)
    const input = await screen.findByRole('textbox', { name: 'Message Athena' })
    await waitFor(() => expect(useChat.getState().snapshot.sessionId).toBe(sessionId))
    fireEvent.change(input, { target: { value: 'Explain React hooks.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(mock.chatSession).toHaveBeenCalledWith({ action: 'draft', id: sessionId, text: 'Explain React hooks.' }))
    await waitFor(() => expect(mock.sendChat).toHaveBeenCalledWith({ text: 'Explain React hooks.', sessionId, requestId: expect.any(String) }))
  })
  it('does not expose a floating click-to-talk microphone control', async () => {
    disconnect = connectChat()
    render(<FloatingConversation />)
    await screen.findByRole('textbox', { name: 'Message Athena' })
    expect(screen.queryByRole('button', { name: /voice message|microphone|record/i })).not.toBeInTheDocument()
  })
})
