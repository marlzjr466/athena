import type { ChatMessage } from '../../../shared/chat'
import type { Settings } from '../../../shared/settings'
import { nextStreamSpeechPart, speechText, speechStartSchema, speechPartSchema, speechStopSchema, type SpeechAudioResult, type SpeechIdentity, type SpeechStatus } from '../../../shared/speech'
import { ChatError } from '../ai/AIProvider'
import type { SpeechService } from './speechService'
import { randomUUID } from 'node:crypto'
import type { Announcement, AnnouncementResult } from './actionNarrator'
import { isLocalOwnership } from '../../../shared/aiOwnership'

function localMessage(message: ChatMessage | undefined, sessionId: string): boolean {
  return isLocalOwnership(message?.ownership) && message.ownership.sessionId === sessionId && message.ownership.correlationId === message.id
}

interface SpeechContext { sessionId: string; idle: boolean; inputActive?: boolean; lastMessage?: ChatMessage; findMessage?(id: string): ChatMessage | undefined }
interface Hooks { context(): SpeechContext; settings(): Settings; changed(status: SpeechStatus): void }
interface Playback extends SpeechIdentity { ownerId: number; replay: boolean; abort: AbortController; index: number; consumed: number; phase: 'generating' | 'playing' | 'waiting'; announcement?: PendingAnnouncement; audio?: AsyncGenerator<Uint8Array>; audioConsumed?: number }
interface PendingAnnouncement extends SpeechIdentity { taskId: string; text: string; terminal: boolean; claimed: boolean; release(result: AnnouncementResult): void; cleanup(): void }

export class SpeechController {
  private playback?: Playback
  private disposed = false
  private lastStarted?: SpeechIdentity
  private announcement?: PendingAnnouncement
  constructor(private service: SpeechService, private hooks: Hooks) {}

  private publish(status: SpeechStatus): void { this.hooks.changed({ ...status, ownership: status.sessionId && status.messageId ? { origin: 'athena-local', sessionId: status.sessionId, correlationId: status.messageId } : undefined }) }
  private permitted(): boolean {
    const settings = this.hooks.settings()
    return settings.voiceEnabled && !settings.voiceMuted && !settings.doNotDisturb
  }
  private valid(playback: Playback): boolean {
    const context = this.hooks.context()
    if (playback.announcement) return this.playback === playback && this.validAnnouncement(playback.announcement) && !playback.abort.signal.aborted
    const message = playback.replay ? context.findMessage?.(playback.messageId) : context.lastMessage
    return this.playback === playback && !playback.abort.signal.aborted && this.permitted()
      && localMessage(message, context.sessionId)
      && !context.inputActive && context.sessionId === playback.sessionId
      && (!playback.replay || context.idle)
      && message?.id === playback.messageId && message.role === 'assistant'
      && (message.status === 'streaming' || message.status === 'complete')
  }
  private validAnnouncement(announcement: PendingAnnouncement): boolean {
    const context = this.hooks.context()
    const task = context.findMessage?.(announcement.taskId) ?? context.lastMessage
    return !this.disposed && this.announcement === announcement && this.permitted() && this.hooks.settings().localVoice.autoSpeak
      && localMessage(task, context.sessionId)
      && !context.inputActive && context.sessionId === announcement.sessionId && context.lastMessage?.id === announcement.taskId && task?.id === announcement.taskId
      && (announcement.terminal || ['streaming', 'complete'].includes(task.status))
  }
  isBusy(): boolean { return Boolean(this.playback || this.announcement) }
  announce(request: Announcement): Promise<AnnouncementResult> {
    if (this.disposed || !this.permitted() || !this.hooks.settings().localVoice.autoSpeak || request.signal?.aborted || this.isBusy()) return Promise.resolve({ started: false })
    const context = this.hooks.context()
    const task = context.findMessage?.(request.messageId) ?? context.lastMessage
    if (!localMessage(task, context.sessionId)) return Promise.resolve({ started: false })
    if (context.inputActive || context.sessionId !== request.sessionId || context.lastMessage?.id !== request.messageId || task?.id !== request.messageId) return Promise.resolve({ started: false })
    return new Promise((resolve) => {
      let released = false
      const release = (result: AnnouncementResult) => { if (!released) { released = true; clearTimeout(startTimeout); resolve(result) } }
      const cancelled = () => {
        // ChatController aborts its request signal on successful completion too.
        const current = this.hooks.context().lastMessage
        if (current?.id === request.messageId && current.status === 'complete') return
        if (this.announcement === announcement) this.stop()
      }
      const startTimeout = setTimeout(() => { if (this.announcement === announcement) this.stop() }, 4000)
      const lifetime = setTimeout(() => { if (this.announcement === announcement) this.stop() }, 20_000)
      const announcement: PendingAnnouncement = {
        sessionId: request.sessionId, messageId: randomUUID(), taskId: request.messageId, text: request.text,
        terminal: task.status === 'error' || task.status === 'stopped', claimed: false, release,
        cleanup: () => { clearTimeout(startTimeout); clearTimeout(lifetime); request.signal?.removeEventListener('abort', cancelled); release({ started: false }) },
      }
      this.announcement = announcement
      request.signal?.addEventListener('abort', cancelled, { once: true })
      this.publish({ phase: 'generating', sessionId: announcement.sessionId, messageId: announcement.messageId, announcement: true, offered: true })
    })
  }
  private async generate(playback: Playback, index: number): Promise<SpeechAudioResult> {
    if (!this.valid(playback)) return { ok: false, message: 'Speech sequence expired.' }
    const context = this.hooks.context()
    const message = playback.replay ? context.findMessage?.(playback.messageId) : context.lastMessage
    const announcementText = playback.announcement ? speechText(playback.announcement.text) : undefined
    if (playback.audio) {
      playback.phase = 'generating'; playback.index = index
      try {
        const chunk = await playback.audio.next()
        if (!this.valid(playback)) return { ok: false, message: 'Speech was stopped.' }
        if (!chunk.done) return { ok: true, bytes: chunk.value, mimeType: this.service.mimeType ?? 'audio/wav', index }
        playback.audio = undefined; playback.consumed = playback.audioConsumed ?? playback.consumed
      } catch { if (this.playback === playback) this.stop(); return { ok: false, message: 'Local streaming speech stopped or failed.' } }
    }
    const part = announcementText !== undefined
      ? playback.consumed ? undefined : { text: announcementText, consumed: announcementText.length }
      : nextStreamSpeechPart(message?.content ?? '', playback.consumed, message?.status === 'complete')
    if (!part) {
      if (playback.announcement || message?.status === 'complete') { this.stop(); return { ok: true, done: true } }
      playback.phase = 'waiting'
      return { ok: true, waiting: true }
    }
    const settings = this.hooks.settings()
    playback.phase = 'generating'
    playback.index = index
    this.publish({ phase: 'generating', sessionId: playback.sessionId, messageId: playback.messageId, index, announcement: Boolean(playback.announcement) })
    try {
      let bytes: Uint8Array
      if (this.service.stream) {
        playback.audio = this.service.stream(part.text, settings.voiceName, settings.voiceSpeed, playback.abort.signal, `athena-local:${playback.sessionId}:${settings.localAI.model}`)
        playback.audioConsumed = part.consumed
        const chunk = await playback.audio.next()
        if (chunk.done) throw new ChatError('The local voice returned no audio.')
        bytes = chunk.value
      } else bytes = await this.service.generate(part.text, settings.voiceName, settings.voiceSpeed, playback.abort.signal, `athena-local:${playback.sessionId}:${settings.localAI.model}`)
      if (!this.valid(playback)) {
        if (this.playback === playback) this.stop()
        return { ok: false, message: 'Speech was stopped.' }
      }
      if (!playback.audio) playback.consumed = part.consumed
      return { ok: true, bytes, mimeType: this.service.mimeType ?? 'audio/mpeg', index }
    } catch (error) {
      const message = error instanceof ChatError ? error.userMessage : 'Speech generation failed.'
      if (this.playback === playback) this.stop(message)
      return { ok: false, message }
    }
  }
  begin(input: unknown, ownerId = 0): Promise<SpeechAudioResult> {
    const parsed = speechStartSchema.safeParse(input)
    if (!parsed.success || this.disposed) return Promise.resolve({ ok: false, message: 'Invalid speech request.' })
    const identity = { sessionId: parsed.data.sessionId, messageId: parsed.data.messageId }
    if (!this.permitted()) return Promise.resolve({ ok: false, message: 'Enable voice and unmute Athena in Settings → Voice.' })
    const announcement = this.announcement
    if (announcement && identity.sessionId === announcement.sessionId && identity.messageId === announcement.messageId) {
      if (parsed.data.replay || announcement.claimed || !this.validAnnouncement(announcement)) return Promise.resolve({ ok: false, message: 'Announcement expired or already claimed.' })
      announcement.claimed = true
      const playback: Playback = { ...identity, announcement, ownerId, replay: false, abort: new AbortController(), index: 0, consumed: 0, phase: 'generating' }
      this.playback = playback
      return this.generate(playback, 0)
    }
    if (announcement) return Promise.resolve({ ok: false, message: 'Athena is finishing an action announcement.' })
    if (!parsed.data.replay && this.lastStarted?.sessionId === identity.sessionId && this.lastStarted.messageId === identity.messageId) return Promise.resolve({ ok: false, message: 'This response was already spoken.' })
    const context = this.hooks.context()
    const message = parsed.data.replay ? context.findMessage?.(identity.messageId) ?? context.lastMessage : context.lastMessage
    if (!localMessage(message, context.sessionId)) return Promise.resolve({ ok: false, message: 'Companion speech is available only for local conversation responses.' })
    if ((parsed.data.replay && !context.idle) || context.inputActive || context.sessionId !== identity.sessionId || message?.id !== identity.messageId || !['streaming', 'complete'].includes(message.status) || message.role !== 'assistant') return Promise.resolve({ ok: false, message: 'This response is not ready to speak, or voice input is active.' })
    if (!nextStreamSpeechPart(message.content, 0, message.status === 'complete')) return Promise.resolve({ ok: false, message: 'No complete speech segment is ready yet.' })
    // Rejected or stale requests must not interrupt the authorized local owner.
    if (this.playback) this.stop()
    this.lastStarted = identity
    const playback: Playback = { ...identity, ownerId, replay: Boolean(parsed.data.replay), abort: new AbortController(), index: 0, consumed: 0, phase: 'generating' }
    this.playback = playback
    return this.generate(playback, 0)
  }
  next(input: unknown, ownerId = 0): Promise<SpeechAudioResult> {
    const parsed = speechPartSchema.safeParse(input), playback = this.playback
    if (!parsed.success || !playback || playback.ownerId !== ownerId || !this.valid(playback) || !['playing', 'waiting'].includes(playback.phase)
      || parsed.data.sessionId !== playback.sessionId || parsed.data.messageId !== playback.messageId
      || parsed.data.index !== playback.index + 1 || parsed.data.index > 1_000) return Promise.resolve({ ok: false, message: 'Speech sequence expired.' })
    return this.generate(playback, parsed.data.index)
  }
  playing(input: unknown, ownerId = 0): { ok: boolean; reason?: string } {
    const parsed = speechPartSchema.safeParse(input), playback = this.playback
    if (!parsed.success) return { ok: false, reason: 'invalid playback identity' }
    if (!playback) return { ok: false, reason: 'no active playback' }
    if (playback.ownerId !== ownerId) return { ok: false, reason: 'another window owns playback' }
    if (playback.sessionId !== parsed.data.sessionId || playback.messageId !== parsed.data.messageId || playback.index !== parsed.data.index) return { ok: false, reason: 'playback segment changed' }
    if (playback.phase !== 'generating') return { ok: false, reason: `playback is ${playback.phase}` }
    if (!this.valid(playback)) return { ok: false, reason: 'conversation or voice input changed' }
    playback.phase = 'playing'
    playback.announcement?.release({ started: true })
    this.publish({ phase: 'playing', sessionId: playback.sessionId, messageId: playback.messageId, index: playback.index, announcement: Boolean(playback.announcement) })
    return { ok: true }
  }
  reconcile(): void { if ((this.playback && !this.valid(this.playback)) || (this.announcement && !this.validAnnouncement(this.announcement))) this.stop() }
  stop(message?: string): void {
    const playback = this.playback
    const announcement = this.announcement
    if (!playback && !announcement) return
    this.playback = undefined
    this.announcement = undefined
    announcement?.cleanup()
    playback?.abort.abort()
    void playback?.audio?.return(undefined).catch(() => {})
    const identity = playback ?? announcement!
    this.publish({ phase: 'idle', sessionId: identity.sessionId, messageId: identity.messageId, message, announcement: Boolean(announcement) })
  }
  stopRequest(input: unknown, ownerId = 0): { ok: boolean } {
    const parsed = speechStopSchema.safeParse(input)
    if (parsed.success && this.playback?.sessionId === parsed.data.sessionId && this.playback.messageId === parsed.data.messageId
      && (!parsed.data.playerOnly || this.playback.ownerId === ownerId)) this.stop()
    return { ok: true }
  }
  dispose(): void { this.disposed = true; this.stop() }
}
