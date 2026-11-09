import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechController } from '../electron/main/voice/speechController'
import { defaultSettings } from '../shared/settings'
import { MAX_SPEECH_CHUNK_CHARACTERS, nextStreamSpeechPart, speechChunks, speechText, type SpeechStatus } from '../shared/speech'
import type { ChatMessage } from '../shared/chat'

const sessionId = '00000000-0000-4000-a000-000000000002'
const messageId = '00000000-0000-4000-a000-000000000003'
const identity = { sessionId, messageId }
const assistant: ChatMessage = { ownership: { origin: 'athena-local', sessionId, correlationId: messageId }, id: messageId, role: 'assistant', content: 'Hello from Athena.', status: 'complete', createdAt: 1 }
function fixture(content = assistant.content) {
  const context = { sessionId, idle: true, inputActive: false, lastMessage: { ...assistant, content } }
  const settings = { ...defaultSettings, voiceEnabled: true }
  const statuses: SpeechStatus[] = []
  const generate = vi.fn(async () => new Uint8Array([1, 2, 3]))
  const controller = new SpeechController({ generate }, { context: () => context, settings: () => settings, changed: (status) => statuses.push(status) })
  return { context, settings, statuses, generate, controller }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('speech from completed replies', () => {
  it('routes incremental local audio in order, consumes text once, and closes on interruption', async () => {
    const settings = structuredClone(defaultSettings); settings.voiceEnabled = true; settings.localVoice.engine = 'sesame-csm'
    const generated: string[] = [], closed = vi.fn()
    const stream = vi.fn(async function* (text: string) { generated.push(text); try { yield new Uint8Array([1]); yield new Uint8Array([2]) } finally { closed() } })
    const context = { sessionId, idle: true, lastMessage: { ...assistant } }
    const controller = new SpeechController({ generate: vi.fn(), stream, mimeType: 'audio/wav' }, { settings: () => settings, context: () => context, changed: vi.fn() })
    expect(await controller.begin(identity)).toMatchObject({ bytes: new Uint8Array([1]), index: 0 })
    controller.playing({ ...identity, index: 0 })
    expect(await controller.next({ ...identity, index: 1 })).toMatchObject({ bytes: new Uint8Array([2]), index: 1 })
    controller.playing({ ...identity, index: 1 })
    expect(await controller.next({ ...identity, index: 2 })).toMatchObject({ done: true })
    expect(generated).toEqual(['Hello from Athena.']); expect(closed).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]).toHaveLength(5)
    controller.dispose()
  })
  it('waits for an intact thought with CSM rather than marking a first-word request spoken', () => {
    expect(nextStreamSpeechPart('Hello from', 0, false, true)).toBeUndefined()
    expect(nextStreamSpeechPart('Hello from Athena.', 0, false, true)?.text).toBe('Hello from Athena.')
    expect(nextStreamSpeechPart('Hello from', 0, true, true)?.text).toBe('Hello from')
  })
  it('does not interrupt local playback when a different conversation requests speech', async () => {
    const f = fixture()
    expect(await f.controller.begin(identity, 3)).toMatchObject({ ok: true })
    expect(f.controller.playing({ ...identity, index: 0 }, 3)).toEqual({ ok: true })
    const before = f.statuses.length
    expect(await f.controller.begin({ sessionId: crypto.randomUUID(), messageId: crypto.randomUUID() }, 1)).toMatchObject({ ok: false })
    expect(f.statuses).toHaveLength(before)
    expect(f.controller.isBusy()).toBe(true)
    expect(f.generate).toHaveBeenCalledTimes(1)
    f.controller.dispose()
  })
  it.each(['online-chat', undefined] as const)('refuses synthesis, replay and announcements for %s messages', async origin => {
    const f = fixture()
    f.context.lastMessage.ownership = origin ? { origin, sessionId, correlationId: messageId } : undefined
    expect(await f.controller.begin(identity)).toMatchObject({ ok: false })
    expect(await f.controller.begin({ ...identity, replay: true })).toMatchObject({ ok: false })
    expect(await f.controller.announce({ ...identity, text: 'Online operation', waitForStart: true })).toEqual({ started: false })
    expect(f.generate).not.toHaveBeenCalled()
    expect(f.statuses).toEqual([])
    f.controller.dispose()
  })
  it('offers transient speech without changing messages and releases only after confirmed playback starts', async () => {
    const f = fixture(), original = structuredClone(f.context.lastMessage)
    let started = false
    const pending = f.controller.announce({ ...identity, text: "Sure. I'm opening VS Code now.", waitForStart: true }).then((value) => { started = value.started })
    const offered = f.statuses.at(-1)!, speechId = { sessionId, messageId: offered.messageId! }
    expect(offered).toMatchObject({ offered: true, announcement: true })
    expect(started).toBe(false)
    expect((await f.controller.begin(speechId, 1)).ok).toBe(true)
    expect((await f.controller.begin(speechId, 2)).ok).toBe(false)
    expect(f.controller.playing({ ...speechId, index: 0 }, 2).ok).toBe(false)
    expect(f.controller.playing({ ...speechId, index: 0 }, 1).ok).toBe(true)
    await pending; expect(started).toBe(true)
    expect(f.context.lastMessage).toEqual(original)
    f.controller.stop()
  })
  it('bounds slow speech and discards late generated audio', async () => {
    const f = fixture(); let release!: (bytes: Uint8Array<ArrayBuffer>) => void
    f.generate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = f.controller.announce({ ...identity, text: 'Let me take a look.', waitForStart: true })
    const speechId = { sessionId, messageId: f.statuses.at(-1)!.messageId! }
    const audio = f.controller.begin(speechId)
    await vi.advanceTimersByTimeAsync(4000)
    expect(await pending).toEqual({ started: false }); expect(f.controller.isBusy()).toBe(false)
    release(new Uint8Array([1])); expect((await audio).ok).toBe(false)
  })
  it('stops pending acknowledgment on cancellation or a new task and accepts no late playback', async () => {
    const f = fixture(); f.context.lastMessage.status = 'streaming'
    const abort = new AbortController()
    const pending = f.controller.announce({ ...identity, text: 'Let me check.', waitForStart: true, signal: abort.signal })
    const speechId = { sessionId, messageId: f.statuses.at(-1)!.messageId! }
    await f.controller.begin(speechId)
    abort.abort(); expect(await pending).toEqual({ started: false })
    expect(f.controller.playing({ ...speechId, index: 0 }).ok).toBe(false)
    const second = f.controller.announce({ ...identity, text: 'Let me check.', waitForStart: true })
    f.context.lastMessage.id = crypto.randomUUID(); f.controller.reconcile()
    expect(await second).toEqual({ started: false })
  })
  it('blocks speech during voice input and cancels pending audio on interruption', async () => {
    const f = fixture()
    f.context.inputActive = true
    expect((await f.controller.begin(identity)).ok).toBe(false)
    expect(f.generate).not.toHaveBeenCalled()
    f.context.inputActive = false
    let finish!: (bytes: Uint8Array<ArrayBuffer>) => void
    f.generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.controller.begin(identity)
    f.context.inputActive = true; f.controller.reconcile()
    finish(new Uint8Array([1]))
    expect((await pending).ok).toBe(false)
    expect(f.statuses.at(-1)?.phase).toBe('idle')
  })
  it('selects the current assistant reply, uses configured voice and speed, and plays segments sequentially', async () => {
    const f = fixture('First sentence. ' + 'A long thought. '.repeat(350))
    f.settings.voiceName = 'marin'; f.settings.voiceSpeed = 1.4
    const first = await f.controller.begin(identity)
    expect(first).toMatchObject({ ok: true, index: 0 })
    expect(f.generate).toHaveBeenCalledWith(expect.any(String), 'marin', 1.4, expect.any(AbortSignal), `athena-local:${sessionId}:${f.settings.localAI.model}`)
    expect((await f.controller.next({ ...identity, index: 1 })).ok).toBe(false)
    expect(f.controller.playing({ ...identity, index: 0 }).ok).toBe(true)
    const second = await f.controller.next({ ...identity, index: 1 })
    expect(second).toMatchObject({ ok: true, index: 1 })
    expect(f.controller.playing({ ...identity, index: 1 }).ok).toBe(true)
    expect((await f.controller.next({ ...identity, index: 20 })).ok).toBe(false)
    f.controller.stopRequest(identity)
    expect(f.statuses.at(-1)?.phase).toBe('idle')
  })
  it('requires voice opt-in, no mute, no DND, and a matching assistant message', async () => {
    const f = fixture()
    f.settings.voiceEnabled = false
    expect((await f.controller.begin(identity)).ok).toBe(false)
    f.settings.voiceEnabled = true; f.settings.voiceMuted = true
    expect((await f.controller.begin(identity)).ok).toBe(false)
    f.settings.voiceMuted = false; f.settings.doNotDisturb = true
    expect((await f.controller.begin(identity)).ok).toBe(false)
    f.settings.doNotDisturb = false; f.context.lastMessage.role = 'user'
    expect((await f.controller.begin(identity)).ok).toBe(false)
    expect(f.generate).not.toHaveBeenCalled()
  })
  it('begins on a completed streaming sentence and waits for later text without duplicate synthesis', async () => {
    const f = fixture('Hello there. More')
    f.context.lastMessage.status = 'streaming'
    f.context.idle = false
    expect(await f.controller.begin(identity)).toMatchObject({ ok: true, index: 0 })
    expect(f.generate).toHaveBeenCalledWith('Hello there.', expect.any(String), expect.any(Number), expect.any(AbortSignal), `athena-local:${sessionId}:${f.settings.localAI.model}`)
    expect(f.controller.playing({ ...identity, index: 0 }).ok).toBe(true)
    expect(await f.controller.next({ ...identity, index: 1 })).toMatchObject({ ok: true, waiting: true })
    f.context.lastMessage.content += ' to you.'
    expect(await f.controller.next({ ...identity, index: 1 })).toMatchObject({ ok: true, index: 1 })
    expect(f.controller.playing({ ...identity, index: 1 }).ok).toBe(true)
    f.context.lastMessage.status = 'complete'; f.context.idle = true
    expect(await f.controller.next({ ...identity, index: 2 })).toMatchObject({ ok: true, done: true })
    expect(f.generate).toHaveBeenCalledTimes(2)
  })
  it('prevents duplicate requests, overlapping playback, and stale audio after a session change', async () => {
    const f = fixture(); let resolve!: (bytes: Uint8Array<ArrayBuffer>) => void
    f.generate.mockImplementation(() => new Promise<Uint8Array<ArrayBuffer>>((done) => { resolve = done }))
    const pending = f.controller.begin(identity)
    expect((await f.controller.begin(identity)).ok).toBe(false)
    f.context.sessionId = crypto.randomUUID()
    f.controller.reconcile(); resolve(new Uint8Array([1]))
    expect((await pending).ok).toBe(false)
    expect(f.statuses.at(-1)?.phase).toBe('idle')
  })
  it('aborts generation when muted and refuses to speak the same reply twice', async () => {
    const f = fixture(); const first = await f.controller.begin(identity)
    expect(first.ok).toBe(true)
    f.settings.voiceMuted = true; f.controller.reconcile()
    expect(f.statuses.at(-1)?.phase).toBe('idle')
    f.settings.voiceMuted = false
    expect((await f.controller.begin(identity)).ok).toBe(false)
  })
  it('does not issue another paid call for a duplicate part or wrong message', async () => {
    const f = fixture('one. '.repeat(1_000))
    await f.controller.begin(identity); f.controller.playing({ ...identity, index: 0 })
    const wrong = await f.controller.next({ ...identity, messageId: crypto.randomUUID(), index: 1 })
    expect(wrong.ok).toBe(false)
    await f.controller.next({ ...identity, index: 1 })
    expect((await f.controller.next({ ...identity, index: 1 })).ok).toBe(false)
    expect(f.generate).toHaveBeenCalledTimes(2)
  })
  it('cleans up on provider failure and disposal', async () => {
    const f = fixture(); f.generate.mockRejectedValue(new Error('private provider data'))
    const result = await f.controller.begin(identity)
    expect(result).toEqual({ ok: false, message: 'Speech generation failed.' })
    f.controller.dispose()
    expect((await f.controller.begin({ ...identity, messageId: crypto.randomUUID() })).ok).toBe(false)
  })
  it('lets only the owning renderer cancel its generation, while an explicit stop remains available', async () => {
    const f = fixture()
    let finish!: (bytes: Uint8Array<ArrayBuffer>) => void
    f.generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.controller.begin(identity, 11)
    f.controller.stopRequest({ ...identity, playerOnly: true }, 22)
    expect(f.statuses.at(-1)?.phase).toBe('generating')
    f.controller.stopRequest({ ...identity, playerOnly: true }, 11)
    expect(f.statuses.at(-1)?.phase).toBe('idle')
    finish(new Uint8Array([1]))
    expect((await pending).ok).toBe(false)
  })
})

describe('speakable text', () => {
  it('releases complete sentences during generation and final remainder on completion', () => {
    expect(nextStreamSpeechPart('Hello there. Working on', 0, false)).toEqual({ text: 'Hello there.', consumed: 12 })
    expect(nextStreamSpeechPart('Hello there. Working on it', 12, false)).toBeUndefined()
    expect(nextStreamSpeechPart('Hello there. Working on it', 12, true)?.text).toBe('Working on it')
  })
  it('starts local speech before a punctuation-free response finishes', () => {
    const text = 'Athena is checking the project files and comparing the active configuration with the saved workspace before she explains what needs to change next'
    const part = nextStreamSpeechPart(text, 0, false)
    expect(part?.text.length).toBeGreaterThan(0)
    expect(part?.text.length).toBeLessThanOrEqual(8)
    expect(part?.text.length).toBeLessThan(text.length)
    expect(text.slice(0, part!.consumed).trim()).toBe(part!.text)
  })
  it('skips fenced code and links but keeps visible prose', () => {
    expect(speechText('Hello **Athena**. [Project](https://example.com)\n```ts\nsecret();\n```\nDone.')).toBe('Hello Athena. Project Code block omitted. Done.')
  })
  it('does not speak a trailing web Sources appendix', () => {
    expect(speechText('Here is the answer.\n\nSources:\n- [React](https://react.dev/) — react.dev; retrieved 2026-10-11T00:00:00.000Z')).toBe('Here is the answer.')
  })
  it('splits a full reply into segments within the API input limit without losing words', () => {
    const text = 'This is a sentence. '.repeat(2_400)
    const parts = speechChunks(text)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => part.length <= MAX_SPEECH_CHUNK_CHARACTERS)).toBe(true)
    expect(parts.join(' ')).toBe(text.trim())
  })
})
