import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HandsFreeAssistant } from '../src/features/voice/HandsFreeAssistant'
import { useAthena } from '../src/store/athenaStore'
import { defaultSettings } from '../shared/settings'
import { emptyChatSnapshot } from '../shared/chat'
import type { Snapshot } from '../shared/contracts'
import type { AIOwnership } from '../shared/aiOwnership'

const mock = vi.hoisted(() => ({
  vadOptions: undefined as any,
  vad: {
    listening: false,
    start: vi.fn(async () => { mock.vad.listening = true }),
    pause: vi.fn(async () => { mock.vad.listening = false }),
    setOptions: vi.fn(),
    destroy: vi.fn(async () => { mock.vad.listening = false }),
  },
  onChat: vi.fn((_listener: (snapshot: { sessionId?: string }) => void) => () => {}),
  onVoice: vi.fn(() => () => {}),
  onLocalVoicePlaybackStopped: vi.fn(() => () => {}),
  getChat: vi.fn(),
  enableHandsFree: vi.fn(),
  transcribeHandsFree: vi.fn(),
  cancelHandsFreeTranscription: vi.fn(async () => ({ ok: true })),
  answerHandsFree: vi.fn(),
  onHandsFreeReplyProgress: vi.fn(() => () => {}),
  clearHandsFreeContext: vi.fn(async () => ({ ok: true })),
  disableHandsFree: vi.fn(async () => ({ ok: true })),
  setHandsFreeState: vi.fn(async () => ({ ok: true })),
  stopHandsFreeSpeech: vi.fn(async () => ({ ok: true })),
  handsFreePlayback: vi.fn(async () => ({ ok: true })),
  cancelHandsFreeReply: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../src/services/desktop', () => ({ desktop: mock }))
vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: vi.fn(async (options) => { mock.vadOptions = options; return mock.vad }) } }))
vi.mock('../src/services/speech/handsFreeAudio', () => ({ handsFreeAudio: async function* () { yield { ok: false, message: 'Diagnostic audio stub.', generationMs: 0, bytes: new Uint8Array() } } }))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const owner = (sessionId: string): AIOwnership => ({ origin: 'athena-local', sessionId, correlationId: crypto.randomUUID() })

beforeEach(() => {
  vi.clearAllMocks()
  mock.vadOptions = undefined
  mock.vad.listening = false
  const sessionId = crypto.randomUUID()
  mock.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId })
  useAthena.setState({ snapshot: {
    settings: { ...defaultSettings, voiceInteraction: { ...defaultSettings.voiceInteraction, handsFreeEnabled: true } },
    visible: true,
  } as Snapshot })
})

describe('floating hands-free lease lifecycle', () => {
  it('releases authorization that arrives after the floating renderer unmounts', async () => {
    const pending = deferred<{ ok: boolean; ownership: AIOwnership }>()
    mock.enableHandsFree.mockReturnValue(pending.promise)
    const view = render(<HandsFreeAssistant />)
    await waitFor(() => expect(mock.enableHandsFree).toHaveBeenCalledOnce())
    expect(mock.enableHandsFree).toHaveBeenCalledWith(expect.any(String))
    view.unmount()
    const lease = owner((await mock.getChat.mock.results[0].value).sessionId)
    await act(async () => { pending.resolve({ ok: true, ownership: lease }); await pending.promise })
    await waitFor(() => expect(mock.disableHandsFree).toHaveBeenCalledWith(lease))
    expect(mock.disableHandsFree).toHaveBeenCalledTimes(1)
  })

  it('releases a stale startup with its old lease when the local session switches', async () => {
    const first = deferred<{ ok: boolean; ownership: AIOwnership }>()
    const second = deferred<{ ok: boolean; ownership: AIOwnership }>()
    mock.enableHandsFree.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(<HandsFreeAssistant />)
    await waitFor(() => expect(mock.enableHandsFree).toHaveBeenCalledTimes(1))
    const originalSession = (await mock.getChat.mock.results[0].value).sessionId as string
    const nextSession = crypto.randomUUID()
    act(() => mock.onChat.mock.calls[0][0]({ sessionId: nextSession }))
    await waitFor(() => expect(mock.enableHandsFree).toHaveBeenCalledTimes(2))
    const stale = owner(originalSession)
    await act(async () => { first.resolve({ ok: true, ownership: stale }); await first.promise })
    await waitFor(() => expect(mock.disableHandsFree).toHaveBeenCalledWith(stale))
    expect(mock.disableHandsFree).toHaveBeenCalledTimes(1)
    view.unmount()
    const current = owner(nextSession)
    await act(async () => { second.resolve({ ok: true, ownership: current }); await second.promise })
    await waitFor(() => expect(mock.disableHandsFree).toHaveBeenCalledWith(current))
    expect(mock.disableHandsFree).toHaveBeenCalledTimes(2)
  })

  it('does not restore an obsolete session from a delayed initial snapshot', async () => {
    const initial = deferred<ReturnType<typeof emptyChatSnapshot>>()
    const authorization = deferred<{ ok: boolean; ownership: AIOwnership }>()
    mock.getChat.mockReturnValue(initial.promise)
    mock.enableHandsFree.mockReturnValue(authorization.promise)
    const view = render(<HandsFreeAssistant />)
    const currentSession = crypto.randomUUID()
    act(() => mock.onChat.mock.calls[0][0]({ sessionId: currentSession }))
    await waitFor(() => expect(mock.enableHandsFree).toHaveBeenCalledWith(currentSession))
    await act(async () => { initial.resolve({ ...emptyChatSnapshot(), sessionId: crypto.randomUUID() }); await initial.promise })
    expect(mock.enableHandsFree).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(async () => { authorization.resolve({ ok: true, ownership: owner(currentSession) }); await authorization.promise })
    expect(mock.disableHandsFree).toHaveBeenCalledTimes(1)
  })

  it('uses the direct diagnostic mode selected after the microphone listener starts', async () => {
    vi.stubGlobal('AudioWorkletNode', class {})
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getSupportedConstraints: () => ({}), getUserMedia: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } })
    const sessionId = crypto.randomUUID()
    mock.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId })
    const lease = owner(sessionId)
    mock.enableHandsFree.mockResolvedValue({ ok: true, ownership: lease })
    mock.transcribeHandsFree.mockResolvedValue({ ok: true, transcript: 'Hey Athena, say hello' })
    mock.answerHandsFree.mockResolvedValue({ ok: true, text: 'Hello!' })
    useAthena.setState({ snapshot: {
      settings: { ...defaultSettings, voiceInteraction: { ...defaultSettings.voiceInteraction, handsFreeEnabled: true, autoVoiceResponse: false } },
      visible: true,
    } as Snapshot })

    const view = render(<HandsFreeAssistant />)
    await waitFor(() => expect(mock.vadOptions).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Direct test · OFF/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Direct test · ON/ }).getAttribute('aria-pressed')).toBe('true'))

    await act(async () => { mock.vadOptions.onSpeechRealStart() })
    await act(async () => { await mock.vadOptions.onSpeechEnd(new Float32Array(6000).fill(0.1)) })
    await waitFor(() => expect(mock.answerHandsFree).toHaveBeenCalledWith(expect.objectContaining({ diagnosticDirect: true, text: 'say hello' })))
    view.unmount()
  })
})
