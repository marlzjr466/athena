import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { ChatView } from '../src/features/chat/ChatView'
import { useChat } from '../src/store/chatStore'
import { emptyChatSnapshot } from '../shared/chat'
import type { VoiceSnapshot } from '../shared/voice'
import { defaultConversationConfig } from '../shared/conversations'
import { useAthena } from '../src/store/athenaStore'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'

const mock = vi.hoisted(() => ({
  beginVoice: vi.fn(async () => ({ ok: true })), voiceRecording: vi.fn(async () => ({ ok: true })),
  transcribeVoice: vi.fn(async () => ({ ok: true, transcript: 'Explain authentication.' })), cancelVoice: vi.fn(async () => ({ ok: true })),
  sendChat: vi.fn(async () => ({ ok: true })), chatSession: vi.fn(async () => ({ ok: true })),
  getChat: vi.fn(), getAIStatus: vi.fn(), onVoice: vi.fn((_callback: (snapshot: VoiceSnapshot) => void) => () => {}),
  onChat: vi.fn(() => () => {}), onSpeech: vi.fn(() => () => {}), stopSpeech: vi.fn(async () => ({ ok: true })),
  reportSpeechLevel: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../src/services/desktop', () => ({ desktop: mock, isDesktop: true }))
vi.mock('../src/features/chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('../src/features/chat/ConversationControls', () => ({ ConversationControls: () => null }))
vi.mock('../src/features/chat/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
class Recorder {
  static isTypeSupported = () => true
  state = 'inactive'
  onstop: (() => void) | null = null
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['fake audio']) }); this.onstop?.() }
}
const sessionId = '00000000-0000-4000-a000-000000000002'
beforeEach(() => {
  vi.clearAllMocks()
  useChat.setState({ snapshot: emptyChatSnapshot(), pending: false, issue: null })
  useAthena.setState({ snapshot: null })
  mock.sendChat.mockResolvedValue({ ok: true })
  mock.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId, revision: 1, config: { ...defaultConversationConfig(), model: 'gpt-5.2' }, draft: 'Existing draft.', attachments: [], workspaces: [] })
  mock.getAIStatus.mockResolvedValue({ ok: true, status: { active: true, models: ['gpt-5.2'] } })
})
describe('voice into the existing conversation', () => {
  it.each(['empty', 'draft', 'attachment', 'failed'] as const)('auto-send respects opt-in and protects %s composer state', async (scenario) => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, voiceAutoSend: true } } as Snapshot })
    mock.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId, revision: 1, config: { ...defaultConversationConfig(), model: 'gpt-5.2' }, draft: scenario === 'draft' ? 'Keep my draft.' : '', attachments: scenario === 'attachment' ? [{ id: crypto.randomUUID(), name: 'notes.txt', kind: 'text', mime: 'text/plain', size: 20, characters: 20 }] : [], workspaces: [] })
    if (scenario === 'failed') mock.sendChat.mockResolvedValue({ ok: false })
    vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }] }) } })
    const view = render(<ChatView />)
    try {
      const mic = await screen.findByRole('button', { name: 'Start voice message' }); await waitFor(() => expect(mic).not.toBeDisabled())
      fireEvent.keyDown(mic, { key: ' ' }); await waitFor(() => expect(mic).toHaveAttribute('aria-pressed', 'true'))
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 500)
      fireEvent.keyDown(mic, { key: ' ' }); clock.mockRestore()
      const input = screen.getByRole('textbox', { name: 'Message Athena' })
      if (scenario === 'draft' || scenario === 'attachment') {
        await waitFor(() => expect(input).toHaveValue(scenario === 'draft' ? 'Keep my draft.\nExplain authentication.' : 'Explain authentication.'))
        expect(mock.sendChat).not.toHaveBeenCalled()
      } else {
        await waitFor(() => expect(mock.sendChat).toHaveBeenCalledTimes(1))
        expect(mock.sendChat).toHaveBeenCalledWith({ text: 'Explain authentication.', sessionId, requestId: expect.any(String) })
        await waitFor(() => expect(input).toHaveValue(scenario === 'failed' ? 'Explain authentication.' : ''))
      }
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
  it('appends a reviewed transcript without losing the draft, then sends through the normal session-bound chat path', async () => {
    const trackStop = vi.fn()
    vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('Blob', NodeBlob)
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop, addEventListener: vi.fn() }] }))
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia } })
    const view = render(<ChatView />)
    try {
      const mic = await screen.findByRole('button', { name: 'Start voice message' })
      await waitFor(() => expect(mic).not.toBeDisabled())
      fireEvent.keyDown(mic, { key: ' ' })
      await waitFor(() => expect(mic).toHaveAttribute('aria-pressed', 'true'))
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 500)
      fireEvent.keyDown(mic, { key: ' ' }); clock.mockRestore()
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message Athena' })).toHaveValue('Existing draft.\nExplain authentication.'))
      expect(trackStop).toHaveBeenCalled()
      expect(mock.sendChat).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => expect(mock.sendChat).toHaveBeenCalledWith({ text: 'Existing draft.\nExplain authentication.', sessionId, requestId: expect.any(String) }))
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
  it('cancels recording and releases the device when the selected session changes', async () => {
    const stop = vi.fn()
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop, addEventListener: vi.fn() }] }) } })
    const view = render(<ChatView />)
    try {
      const mic = await screen.findByRole('button', { name: 'Start voice message' }); await waitFor(() => expect(mic).not.toBeDisabled())
      fireEvent.keyDown(mic, { key: ' ' }); await waitFor(() => expect(mic).toHaveAttribute('aria-pressed', 'true'))
      act(() => useChat.setState({ snapshot: { ...useChat.getState().snapshot, revision: 2, sessionId: crypto.randomUUID(), draft: '' } }))
      await waitFor(() => expect(stop).toHaveBeenCalled())
      expect(mock.transcribeVoice).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox', { name: 'Message Athena' })).toHaveValue('')
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
  it('requires an explicit online choice for legacy local profiles without silently sending a request', async () => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'local', strictOffline: true, localAI: { ...defaultSettings.localAI, model: 'gpt-oss:20b' } } } as Snapshot })
    mock.getAIStatus.mockResolvedValue({ ok: true, status: { active: false, models: [] } })
    mock.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId, revision: 1, config: { ...defaultConversationConfig(), model: null }, draft: '', attachments: [], workspaces: [] })
    vi.stubGlobal('navigator', { onLine: false })
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' })
      await screen.findByText(/Choose an online provider in Settings/)
      expect(input).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      expect(mock.sendChat).not.toHaveBeenCalled()
      expect(screen.queryByText(/Add your OpenAI API key/)).not.toBeInTheDocument()
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
})
