import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpeechOutput } from '../src/features/voice/useSpeechOutput'
import { emptyChatSnapshot, type ChatSnapshot } from '../shared/chat'
import { defaultSettings } from '../shared/settings'
import type { SpeechStatus } from '../shared/speech'

const mock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), dispose: vi.fn(), onSpeech: vi.fn((_listener: (status: SpeechStatus) => void) => () => {}) }))
vi.mock('../src/services/desktop', () => ({ desktop: { onSpeech: mock.onSpeech } }))
vi.mock('../src/services/speech/speechPlayer', () => ({ SpeechPlayer: class {
  start = mock.start; stop = mock.stop; dispose = mock.dispose
  setVolume() {} setSpeed() {} handleRemote() {} onChatUpdate() {}
} }))
const settings = { ...defaultSettings, voiceEnabled: true }
const initial = (): ChatSnapshot => {
  const sessionId = crypto.randomUUID()
  return { ...emptyChatSnapshot(), sessionId, revision: 1, ownership: { origin: 'athena-local', sessionId, correlationId: crypto.randomUUID() } }
}
const reply = () => ({ id: crypto.randomUUID(), role: 'assistant' as const, status: 'complete' as const, content: 'Chrome is open.', createdAt: Date.now() })
beforeEach(() => vi.clearAllMocks())
describe('speech output conversation coordination', () => {
  it.each(['online-chat', undefined] as const)('does not synthesize or replay %s conversation responses', origin => {
    const chat = initial(), last = reply()
    chat.ownership = origin ? { ...chat.ownership!, origin } : undefined
    const view = renderHook((props: ChatSnapshot) => useSpeechOutput(props, settings), { initialProps: chat })
    view.rerender({ ...chat, revision: 2, phase: 'speaking', messages: [{ ...last, status: 'streaming' }] })
    view.rerender({ ...chat, revision: 3, messages: [last] })
    act(() => view.result.current.speakMessage(chat.sessionId!, last.id))
    expect(mock.start).not.toHaveBeenCalled()
    view.unmount()
  })
  it('ignores online and other-session announcements even while local playback is enabled', () => {
    const chat = initial()
    const view = renderHook(() => useSpeechOutput(chat, settings))
    const listener = mock.onSpeech.mock.calls.at(-1)![0]
    for (const ownership of [undefined, { ...chat.ownership!, origin: 'online-chat' as const }, { ...chat.ownership!, sessionId: crypto.randomUUID() }]) {
      act(() => listener({ ownership, phase: 'generating', announcement: true, offered: true, sessionId: chat.sessionId, messageId: crypto.randomUUID() }))
    }
    expect(mock.start).not.toHaveBeenCalled()
    view.unmount()
  })
  it('plays the acknowledgment once and then the final result, even without another chat update', () => {
    const chat = initial(), last = reply()
    const view = renderHook((props: ChatSnapshot) => useSpeechOutput(props, settings), { initialProps: chat })
    const listener = mock.onSpeech.mock.calls.at(-1)![0], id = crypto.randomUUID()
    act(() => listener({ ownership: chat.ownership, phase: 'generating', announcement: true, offered: true, sessionId: chat.sessionId, messageId: id }))
    expect(mock.start).toHaveBeenCalledWith({ sessionId: chat.sessionId, messageId: id })
    view.rerender({ ...chat, revision: 4, messages: [last] })
    expect(mock.start).toHaveBeenCalledOnce()
    act(() => listener({ ownership: chat.ownership, phase: 'idle', announcement: true, sessionId: chat.sessionId, messageId: id }))
    expect(mock.start).toHaveBeenLastCalledWith({ sessionId: chat.sessionId, messageId: last.id })
    expect(mock.start).toHaveBeenCalledTimes(2)
    view.unmount()
  })
  it('does not let the inactive renderer claim announcement playback', () => {
    const chat = initial()
    const view = renderHook(() => useSpeechOutput(chat, settings, false))
    act(() => mock.onSpeech.mock.calls.at(-1)![0]({ ownership: chat.ownership, phase: 'generating', announcement: true, offered: true, sessionId: chat.sessionId, messageId: crypto.randomUUID() }))
    expect(mock.start).not.toHaveBeenCalled(); view.unmount()
  })
  it('waits for final action results and respects Completion Announcements', () => {
    const chat = initial(), last = { ...reply(), execution: { startedAt: Date.now(), updatedAt: Date.now(), status: 'working' as const, activities: [{ id: 'activity', tool: 'open_application', label: 'Opening', startedAt: Date.now(), status: 'running' as const }] } }
    const view = renderHook((props: ChatSnapshot) => useSpeechOutput(props, settings), { initialProps: chat })
    view.rerender({ ...chat, revision: 2, messages: [{ ...last, status: 'streaming' }] })
    expect(mock.start).not.toHaveBeenCalled()
    view.rerender({ ...chat, revision: 3, messages: [last] })
    expect(mock.start).toHaveBeenCalledOnce(); view.unmount()
    mock.start.mockClear()
    const disabled = renderHook((props: ChatSnapshot) => useSpeechOutput(props, { ...settings, localVoice: { ...settings.localVoice, completionAnnouncements: false } }), { initialProps: chat })
    disabled.rerender({ ...chat, revision: 3, messages: [last] })
    expect(mock.start).not.toHaveBeenCalled(); disabled.unmount()
  })
  it('speaks a fast completed reply even when React never observed the busy phase, once only', () => {
    const chat = initial(), last = reply()
    const view = renderHook((props: ChatSnapshot) => useSpeechOutput(props, settings), { initialProps: chat })
    view.rerender({ ...chat, revision: 4, messages: [last] })
    expect(mock.start).toHaveBeenCalledWith({ sessionId: chat.sessionId, messageId: last.id })
    view.rerender({ ...chat, revision: 5, messages: [last] })
    expect(mock.start).toHaveBeenCalledTimes(1)
    view.unmount(); expect(mock.dispose).toHaveBeenCalledOnce()
  })
  it('never reads restored or switched conversation history aloud', () => {
    const chat = { ...initial(), messages: [reply()] }
    const view = renderHook((props: ChatSnapshot) => useSpeechOutput(props, settings), { initialProps: chat })
    view.rerender({ ...initial(), revision: 2, messages: [reply()] })
    expect(mock.start).not.toHaveBeenCalled(); view.unmount()
  })
  it('starts speaking a finished sentence before the response finishes streaming', () => {
    const chat = initial(), last = { ...reply(), status: 'streaming' as const, content: 'Hello there. More is coming' }
    const view = renderHook((props: ChatSnapshot) => useSpeechOutput(props, settings), { initialProps: chat })
    view.rerender({ ...chat, phase: 'speaking', revision: 2, messages: [last] })
    expect(mock.start).toHaveBeenCalledWith({ sessionId: chat.sessionId, messageId: last.id })
    view.rerender({ ...chat, revision: 3, messages: [{ ...last, status: 'complete' }] })
    expect(mock.start).toHaveBeenCalledTimes(1)
    view.unmount()
  })
  it.each(['stopped', 'error'] as const)('does not speak %s partial tool responses', (status) => {
    const chat = initial(), last = { ...reply(), content: 'Still working on the request' }
    const view = renderHook((props: ChatSnapshot) => useSpeechOutput(props, settings), { initialProps: chat })
    view.rerender({ ...chat, phase: 'thinking', revision: 2, messages: [{ ...last, status: 'streaming' }] })
    expect(mock.start).toHaveBeenCalledOnce()
    view.rerender({ ...chat, revision: 3, messages: [{ ...last, status }] })
    expect(mock.stop).toHaveBeenCalled(); view.unmount()
  })
})
