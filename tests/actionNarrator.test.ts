import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionNarrator, actionDescription, type Announcement } from '../electron/main/voice/actionNarrator'
import { defaultSettings, restoreSettings } from '../shared/settings'
import { voiceControlIntent } from '../shared/voiceIntent'

const event = (tool = 'open_application', messageId = 'task') => ({ ownership: { origin: 'athena-local' as const, sessionId: 'session', correlationId: messageId }, sessionId: 'session', messageId, tool, input: { app: 'vscode' }, signal: new AbortController().signal })
function fixture() {
  const settings = structuredClone(defaultSettings)
  settings.voiceEnabled = true
  const announce = vi.fn(async (_request: Announcement) => ({ started: true }))
  return { settings, announce, narrator: new ActionNarrator(() => settings, announce, () => 0) }
}
afterEach(() => vi.useRealTimers())
describe('owned local action narration', () => {
  it('rejects online, unowned and incorrectly correlated tool events', async () => {
    const f = fixture(), local = event()
    await f.narrator.beforeAction({ ...local, ownership: undefined })
    await f.narrator.beforeAction({ ...local, ownership: { ...local.ownership, origin: 'online-chat' } })
    await f.narrator.beforeAction({ ...local, ownership: { ...local.ownership, correlationId: 'another-task' } })
    expect(f.announce).not.toHaveBeenCalled()
  })
  it('describes validated action intent without claiming success and varies consecutive requests', async () => {
    const f = fixture()
    const first = await f.narrator.beforeAction(event())
    const second = await f.narrator.beforeAction(event('open_application', 'next-task'))
    expect(first).toContain("I'm opening Visual Studio Code now.")
    expect(first).not.toBe(second)
    expect(f.announce).toHaveBeenCalledWith(expect.objectContaining({ waitForStart: true, signal: expect.any(AbortSignal) }))
    expect(actionDescription('open_application', { app: 'untrusted name' })).toBeUndefined()
    expect(actionDescription('casual_conversation', {})).toBeUndefined()
  })
  it('holds parallel tools behind one initial playback barrier', async () => {
    const f = fixture(); let release!: (value: { started: boolean }) => void
    f.announce.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    let secondFinished = false
    const first = f.narrator.beforeAction(event('read_file'))
    const second = f.narrator.beforeAction(event('search_code')).then(() => { secondFinished = true })
    await Promise.resolve()
    expect(secondFinished).toBe(false); expect(f.announce).toHaveBeenCalledOnce()
    release({ started: true }); await Promise.all([first, second])
    expect(secondFinished).toBe(true); expect(f.announce).toHaveBeenCalledOnce()
  })
  it('rate limits progress and never repeats the same operation category', async () => {
    vi.useFakeTimers(); const f = fixture()
    await f.narrator.beforeAction(event('read_file'))
    await f.narrator.beforeAction(event('search_code'))
    expect(f.announce).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(60_000)
    await f.narrator.beforeAction(event('search_code'))
    expect(f.announce).toHaveBeenCalledTimes(2)
    expect(f.announce.mock.calls[1][0]).toMatchObject({ waitForStart: false })
    vi.advanceTimersByTime(60_000)
    await f.narrator.beforeAction(event('search_files'))
    expect(f.announce).toHaveBeenCalledTimes(2)
  })
  it.each(['voiceMuted', 'doNotDisturb'] as const)('respects %s without dispatching speech', async (key) => {
    const f = fixture(); f.settings[key] = true
    await f.narrator.beforeAction(event()); expect(f.announce).not.toHaveBeenCalled()
  })
  it('honors opt-outs and cancellation; never calls a cloud service', async () => {
    const f = fixture(); f.settings.aiMode = 'local'; f.settings.strictOffline = true
    await f.narrator.beforeAction(event()); expect(f.announce).toHaveBeenCalledOnce()
    f.settings.localVoice.naturalAcknowledgments = false
    await f.narrator.beforeAction(event('open_application', 'new')); expect(f.announce).toHaveBeenCalledOnce()
    const cancelled = new AbortController(); cancelled.abort()
    await f.narrator.beforeAction({ ...event(), signal: cancelled.signal }); expect(f.announce).toHaveBeenCalledOnce()
  })
  it('persists preferences and supplies safe defaults to old settings', () => {
    const f = fixture()
    expect(restoreSettings({ localVoice: { engine: 'chatterbox-turbo' } }).localVoice).toMatchObject({ naturalAcknowledgments: true, speakBeforeActions: true, spokenProgress: true, progressIntervalSeconds: 60, completionAnnouncements: true, allowSpeechInterruption: true })
    f.settings.localVoice.progressIntervalSeconds = 120
    f.settings.localVoice.spokenProgress = false
    expect(restoreSettings(JSON.parse(JSON.stringify(f.settings))).localVoice).toEqual(f.settings.localVoice)
  })
  it('distinguishes explicit cancellation from speech interruption and quoted/casual text', () => {
    expect(voiceControlIntent('Hey Athena, stop talking.')).toBe('stop-speech')
    expect(voiceControlIntent('Athena, cancel the current task.')).toBe('cancel-task')
    expect(voiceControlIntent('Explain what cancel the task means')).toBeUndefined()
    expect(voiceControlIntent('stop')).toBeUndefined()
    expect(voiceControlIntent('Open Chrome instead')).toBeUndefined()
  })
})
