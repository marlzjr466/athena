import { emptyAudioDeviceState, type AudioDeviceState } from '../../../shared/audioDevices'
import { desktop } from '../desktop'

let state = emptyAudioDeviceState()
const listeners = new Set<(state: AudioDeviceState) => void>()
let refreshPending: Promise<void> | undefined
let refreshAgain = false
let enumerateRequested = false
let floatingVisible = true
const broker = () => {
  const surface = new URLSearchParams(window.location.search).get('surface')
  return (surface === 'floating' && floatingVisible) || (surface === 'control' && !floatingVisible)
}
export function setAudioDiscoveryVisibility(visible: boolean): void {
  if (floatingVisible === visible) return
  floatingVisible = visible
  if (broker()) void refreshAudioDevices().catch(() => {})
}
export const currentAudioDevices = () => state
export function onAudioDevices(listener: (state: AudioDeviceState) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
function accept(next: AudioDeviceState): void {
  if (next.revision < state.revision) return
  state = next; for (const listener of listeners) listener(state)
}
export function refreshAudioDevices(enumerateHere = false): Promise<void> {
  enumerateRequested ||= enumerateHere
  if (refreshPending) { refreshAgain = true; return refreshPending }
  refreshPending = (async () => {
    do {
      refreshAgain = false
      const enumerate = enumerateRequested || broker()
      enumerateRequested = false
      if (enumerate && navigator.mediaDevices?.enumerateDevices) {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' || d.kind === 'audiooutput')
          .map(d => ({ kind: d.kind as 'audioinput' | 'audiooutput', deviceId: d.deviceId, groupId: d.groupId, label: d.label }))
        accept(await desktop.audioDevices({ action: 'inventory', devices }))
      } else accept(await desktop.audioDevices({ action: 'get' }))
    } while (refreshAgain)
  })().finally(() => { refreshPending = undefined })
  return refreshPending
}
/** One visible discovery broker (Floating Athena, or the control window when hidden); Chromium uses Core Audio / Windows endpoints, without another native process. */
export function connectAudioDevices(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const off = desktop.onAudioDevices(accept)
  const refresh = () => { if (!broker()) return; clearTimeout(timer); timer = setTimeout(() => { if (broker()) void refreshAudioDevices().catch(() => {}) }, 180) }
  navigator.mediaDevices?.addEventListener?.('devicechange', refresh); window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  void refreshAudioDevices().catch(() => {})
  return () => { off(); clearTimeout(timer); navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
}

export async function microphoneConstraints(base: MediaTrackConstraints): Promise<MediaStreamConstraints> {
  const settings = (await desktop.getSnapshot()).settings.audioDevices
  const route = (await desktop.audioDevices({ action: 'get' })).input
  // Before the first authorized capture Chromium may redact endpoint identities.
  // Only system-default selection can bootstrap capture without a resolved ID.
  const id = route.deviceId
  if (!id && settings.inputDeviceId === 'default' && !settings.automaticSwitching && state.devices.some(d => d.kind === 'audioinput' && d.label)) throw new Error(route.message ?? 'The selected microphone is unavailable.')
  return { video: false, audio: { ...base, ...(id ? { deviceId: { exact: id } } : {}) } }
}

/** Route the same playback object in place; never restart synthesis or replay audio. */
export async function routeSpeech(audio: HTMLAudioElement, stopped: (message: string) => void, context?: { prepare(audio: HTMLAudioElement, sinkId: string): Promise<void>; setSinkId?(sinkId: string): Promise<void> }): Promise<() => void> {
  accept(await desktop.audioDevices({ action: 'get' }))
  if (state.outputHeld || !state.output.deviceId) throw new Error(state.message ?? 'Select an available speaker in Voice Settings.')
  if (typeof audio.setSinkId !== 'function') throw new Error('This runtime cannot safely select audio outputs. Update Athena before using voice playback.')
  let closed = false, ready = false, target = state.output.deviceId
  let version = 0
  let lane: Promise<void> = Promise.resolve()
  const wasMuted = audio.muted
  const fail = () => {
    if (closed) return
    closed = true; off(); audio.pause(); audio.muted = wasMuted
    stopped('Audio output is unavailable. Reconnect a speaker or choose another in Voice Settings.')
  }
  const off = onAudioDevices(next => {
    if (closed) return
    if (next.outputHeld || !next.output.deviceId) { fail(); return }
    if (target === next.output.deviceId) return
    target = next.output.deviceId
    const revision = ++version
    audio.muted = true
    lane = lane.then(async () => {
      if (closed || revision !== version) return
      await audio.setSinkId(target)
      if (closed || revision !== version) return
      if (ready && context) {
        if (!context.setSinkId) throw new Error('Web Audio output cannot be switched safely.')
        await context.setSinkId(target)
      }
      if (!closed && revision === version) audio.muted = wasMuted
    }).catch(fail)
  })
  try {
    await audio.setSinkId(target)
    await lane
    if (closed) throw new Error('Audio output changed before playback.')
    await context?.prepare(audio, target)
    ready = true
    await lane
    if (closed) throw new Error('Audio output changed before playback.')
    // A change during prepare must also move the Web Audio destination.
    if (context?.setSinkId) await context.setSinkId(target)
    audio.muted = wasMuted
    return () => { closed = true; off(); audio.muted = wasMuted }
  } catch (error) { closed = true; off(); audio.pause(); throw error }
}

/** Serialized capture owner; late getUserMedia completions are closed, never leaked. */
export class MicrophoneSource {
  private stream?: MediaStream
  private pending?: Promise<MediaStream>
  private closed = false
  private key?: string
  private stale = false
  private off: () => void
  constructor(private constraints: () => MediaTrackConstraints, private changed: () => void) {
    let previous = currentAudioDevices().input.deviceId
    this.off = onAudioDevices(next => {
      const id = next.input.deviceId
      if (id !== previous) {
        previous = id
        const track = this.stream?.getAudioTracks()[0]
        const actual = track?.getSettings()
        const device = next.devices.find(d => d.kind === 'audioinput' && d.deviceId === id)
        if (id && (actual?.deviceId === id || (actual?.groupId && actual.groupId === device?.groupId)
          || (actual?.deviceId === 'default' && track?.label && track.label === device?.label))) { this.key = id; return }
        this.stale = true
        // open() already retries a changed route before resolving its owner.
        // Consent revealing devices must not cancel that in-flight capture.
        if (!this.pending) changed()
      }
    })
  }
  getStream(): Promise<MediaStream> {
    if (this.closed) return Promise.reject(new Error('Microphone capture was cancelled.'))
    if (this.pending) return this.pending
    if (!this.stale && this.stream?.getAudioTracks().some(t => t.readyState === 'live')) return Promise.resolve(this.stream)
    this.pending = this.open().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async open(attempt = 0): Promise<MediaStream> {
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined; this.stale = false
    const constraints = await microphoneConstraints(this.constraints())
    if (this.closed) throw new Error('Microphone capture was cancelled.')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia(constraints) }
    catch (error) {
      // Drop only the optional voiceIsolation constraint. Never drop the selected device.
      const audio = constraints.audio
      if (!(error instanceof DOMException) || error.name !== 'OverconstrainedError' || typeof audio !== 'object' || !('voiceIsolation' in audio)) throw error
      const fallback = { ...audio }; delete (fallback as Record<string, unknown>).voiceIsolation
      stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: fallback })
    }
    if (this.closed) { stream.getTracks().forEach(t => t.stop()); throw new Error('Microphone capture was cancelled.') }
    this.stream = stream; this.key = stream.getAudioTracks()[0]?.getSettings().deviceId
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => { if (!this.closed && this.stream === stream) { this.stale = true; this.changed() } }, { once: true })
    await refreshAudioDevices(true).catch(() => {})
    // Initial enumeration after consent is not a physical device change.
    if (currentAudioDevices().input.deviceId === this.key) this.stale = false
    if (this.stale) {
      stream.getTracks().forEach(t => t.stop()); this.stream = undefined
      if (attempt >= 2) throw new Error('Microphone devices are still changing. Listening will retry when stable.')
      return this.open(attempt + 1)
    }
    return stream
  }
  needsReconnect(): boolean { return this.stale || !this.stream?.getAudioTracks().some(t => t.readyState === 'live') }
  close(): void { this.closed = true; this.off(); this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined }
}
