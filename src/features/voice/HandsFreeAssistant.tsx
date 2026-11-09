import { useEffect, useRef, useState } from 'react'
import { MicOff } from 'lucide-react'
import { MicVAD, type RealTimeVADOptions } from '@ricky0123/vad-web'
import { AdaptiveNoiseFloor, chooseClarification, chooseWakeAcknowledgement, classifyHandsFreeTranscript, encodeHandsFreeWav, handsFreeMicrophoneConstraints, isUsableSpeechSegment, isVoiceInterruption, negativeSpeechConfidenceThreshold, normalizeVoiceCommand, SESAME_WAKE_ACKNOWLEDGEMENT, shouldFallbackFromAudioWorklet, silenceEndpointMs, speechConfidenceThreshold, type HandsFreeState } from '../../../shared/handsFree'
import { chooseHiggsWakeAcknowledgement } from '../../../shared/higgsTTS'
import { isHiggsEngine, isSesameEngine } from '../../../shared/localVoice'
import type { VoiceInteractionSettings } from '../../../shared/handsFree'
import { desktop } from '../../services/desktop'
import { PlaybackAmplitude } from '../../services/speech/playbackAmplitude'
import { handsFreeAudio } from '../../services/speech/handsFreeAudio'
import { useAthena } from '../../store/athenaStore'
import { setVoiceAmplitude } from '../../three/voiceAmplitude'
import { parseVoiceWebOpen } from './voiceWebCommand'
import { VoiceSegmentQueue, VoiceSentenceBuffer } from '../../../shared/voiceResponse'
import type { AIOwnership } from '../../../shared/aiOwnership'
import '../../styles/handsFree.css'

type Phase = HandsFreeState['state']
type PendingChatAction = 'send' | 'draft' | null
type PendingVoiceAction = { action: 'open-app'; app: string } | { action: 'focus-app'; app: string } | { action: 'open-url'; url: string }
interface CaptureRuntime {
  vad?: MicVAD
  stream?: MediaStream
  processing: boolean
  requestId?: string
  noiseFloor: AdaptiveNoiseFloor
  lastThresholdUpdate: number
  deviceChange?: EventListener
}

function releaseCapture(active: CaptureRuntime): void {
  if (active.requestId) void desktop.cancelHandsFreeTranscription({ id: active.requestId }).catch(() => {})
  if (active.vad) void active.vad.destroy().catch(() => {})
  active.stream?.getTracks().forEach((track) => track.stop())
  if (active.deviceChange) navigator.mediaDevices?.removeEventListener('devicechange', active.deviceChange)
}

const appAliases: Array<[RegExp, string]> = [
  [/\b(?:visual studio code|vs\s?code|vscode)\b/i, 'vscode'],
  [/\b(?:google chrome|chrome)\b/i, 'chrome'], [/\bsafari\b/i, 'safari'], [/\bfinder\b/i, 'finder'],
  [/\bterminal\b/i, 'terminal'], [/\bslack\b/i, 'slack'], [/\bspotify\b/i, 'spotify'],
  [/\bnotes\b/i, 'notes'], [/\bcalculator\b/i, 'calculator'],
]

function frameRms(values: Float32Array): number {
  let sum = 0
  for (const sample of values) sum += sample * sample
  return Math.sqrt(sum / values.length)
}

function speechThresholds(settings: VoiceInteractionSettings, floor: number) {
  const positiveSpeechThreshold = speechConfidenceThreshold(settings.wakeSensitivity, floor, settings.noiseSuppressionLevel)
  return { positiveSpeechThreshold: Math.min(0.68, positiveSpeechThreshold), negativeSpeechThreshold: negativeSpeechConfidenceThreshold(settings.wakeSensitivity, floor, settings.noiseSuppressionLevel) }
}

function microphoneConstraints(settings: VoiceInteractionSettings): MediaStreamConstraints {
  const supported = navigator.mediaDevices.getSupportedConstraints() as MediaTrackSupportedConstraints & { voiceIsolation?: boolean }
  return handsFreeMicrophoneConstraints(settings.noiseSuppressionLevel, Boolean(supported.voiceIsolation))
}

function isPersistentSpeechServiceError(message: string): boolean {
  return /(?:whisper.{0,40}(?:not found|unavailable|install|model|configure|disabled)|(?:select|choose|configure).{0,30}(?:local )?whisper|speech recognition is disabled|microphone authorization expired)/i.test(message)
}

function asBlobBytes(bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function appAction(text: string): { kind: 'open' | 'focus'; app: string } | undefined {
  const match = /^(?:please\s+)?(open|launch|start|switch to|focus)(?:\s+the)?\s+(.+)$/i.exec(text)
  if (!match) return undefined
  const app = appAliases.find(([pattern]) => pattern.test(match[2]))?.[1]
  return app ? { kind: /^(?:switch to|focus)$/i.test(match[1]) ? 'focus' : 'open', app } : undefined
}

function speakable(text: string): string {
  return text.replace(/\n\nSources:\n[\s\S]*$/i, '').replace(/```[\s\S]*?```/g, ' code block omitted. ').replace(/`([^`]+)`/g, '$1').replace(/https?:\/\/\S+/g, 'link').replace(/[#*_>|~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3600)
}

export function HandsFreeAssistant() {
  const settings = useAthena((state) => state.snapshot?.settings)
  const visible = useAthena((state) => state.snapshot?.visible ?? false)
  const [manualVoiceActive, setManualVoiceActive] = useState(false)
  const [phase, setPhase] = useState<Phase>('paused')
  const [notice, setNotice] = useState('')
  const [diagnosticDirectMode, setDiagnosticDirectMode] = useState(false)
  const diagnosticDirectModeRef = useRef(false)
  const runtime = useRef<CaptureRuntime | undefined>(undefined)
  const leaseActive = useRef(false)
  const ownership = useRef<AIOwnership | undefined>(undefined)
  const [localSessionId, setLocalSessionId] = useState<string | undefined>()
  useEffect(() => {
    let live = true, observed = false
    const off = desktop.onChat(snapshot => { if (live) { observed = true; setLocalSessionId(snapshot.sessionId) } })
    void desktop.getChat().then(snapshot => { if (live && !observed) setLocalSessionId(snapshot.sessionId) }).catch(() => {})
    return () => { live = false; off() }
  }, [])
  const reportVoiceState = (state: HandsFreeState) => desktop.setHandsFreeState({ ...state, ownership: ownership.current })
  const reportPlayback = (playing: boolean) => desktop.handsFreePlayback({ playing, ownership: ownership.current })
  const releaseVoiceLease = (lease?: AIOwnership) => {
    if (!lease) return
    if (ownership.current?.sessionId === lease.sessionId && ownership.current.correlationId === lease.correlationId) {
      leaseActive.current = false
      ownership.current = undefined
    }
    void desktop.disableHandsFree(lease).catch(() => {})
  }
  const audio = useRef<HTMLAudioElement | undefined>(undefined)
  const meter = useRef<PlaybackAmplitude | undefined>(undefined)
  meter.current ??= new PlaybackAmplitude(setVoiceAmplitude)
  useEffect(() => () => { meter.current?.dispose(); meter.current = undefined }, [])
  const audioUrl = useRef<string | undefined>(undefined)
  const activeReplyId = useRef<string | undefined>(undefined)
  const segmentFinished = useRef<((played: boolean) => void) | undefined>(undefined)
  const streamingQueue = useRef<VoiceSegmentQueue | undefined>(undefined)
  const previousClarification = useRef<string | undefined>(undefined)
  const previousWakeAcknowledgement = useRef<string | undefined>(undefined)
  const clarificationFailures = useRef(0)
  const clarificationCooldownUntil = useRef(0)
  const followUpActive = useRef(false)
  const followUpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingChat = useRef<PendingChatAction>(null)
  const pendingAction = useRef<PendingVoiceAction | null>(null)
  const disposed = useRef(false)
  const phaseRef = useRef<Phase>('paused')
  const turnId = useRef(0)
  const diagnostics = useRef<NonNullable<HandsFreeState['diagnostics']>>({})
  const traceClock = useRef<{ id: string; startedAt: number } | undefined>(undefined)
  const speechStartedAt = useRef<number | undefined>(undefined)
  const lastSpeechFrameAt = useRef<number | undefined>(undefined)
  const speechEndedAt = useRef<number | undefined>(undefined)
  const interaction = settings?.voiceInteraction
  const interactionRef = useRef(interaction)
  const settingsRef = useRef(settings)
  interactionRef.current = interaction
  settingsRef.current = settings

  useEffect(() => desktop.onVoice((state) => setManualVoiceActive(state.phase !== 'idle')), [])

  const setStatus = (next: Phase, message?: string) => {
    phaseRef.current = next; setPhase(next); setNotice(message ?? '')
    void reportVoiceState({ state: next, ...(message ? { message } : {}), ...(import.meta.env.DEV ? { diagnostics: { ...diagnostics.current } } : {}) }).catch(() => {})
  }

  const trace = (stage: string, durationMs?: number, detail?: string) => {
    if (!import.meta.env.DEV || !traceClock.current) return
    const event = { stage, timestamp: new Date().toISOString(), elapsedMs: Math.max(0, Math.round(performance.now() - traceClock.current.startedAt)), ...(durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(durationMs)) }), ...(detail ? { detail: detail.slice(0, 1200) } : {}) }
    diagnostics.current.traceEvents = [...(diagnostics.current.traceEvents ?? []), event].slice(-80)
    void reportVoiceState({ state: phaseRef.current, diagnostics: { ...diagnostics.current } }).catch(() => {})
  }

  const startTrace = () => {
    const id = crypto.randomUUID()
    traceClock.current = { id, startedAt: performance.now() }
    diagnostics.current = { traceId: id, traceMode: diagnosticDirectModeRef.current ? 'direct' : 'normal', traceEvents: [] }
    trace('vad-speech-start')
  }

  const toggleDiagnosticMode = async () => {
    await desktop.clearHandsFreeContext().catch(() => {})
    const next = !diagnosticDirectModeRef.current
    diagnosticDirectModeRef.current = next
    setDiagnosticDirectMode(next)
  }

  const endVoiceConversation = () => {
    followUpActive.current = false; pendingChat.current = null; pendingAction.current = null
    clearTimeout(followUpTimer.current); followUpTimer.current = undefined
    void desktop.clearHandsFreeContext()
    setStatus('standby')
  }

  const cleanupPlayback = () => {
    segmentFinished.current?.(false)
    segmentFinished.current = undefined
    meter.current?.stop()
    const player = audio.current
    audio.current = undefined
    if (player) { player.onended = null; player.onerror = null; player.pause(); player.removeAttribute('src'); player.load() }
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current)
    audioUrl.current = undefined
  }

  const stopPlayback = async () => {
    streamingQueue.current?.cancel()
    streamingQueue.current = undefined
    activeReplyId.current = undefined
    cleanupPlayback()
    await desktop.stopHandsFreeSpeech().catch(() => ({ ok: true }))
  }

  useEffect(() => desktop.onLocalVoicePlaybackStopped(() => {
    // Main already cancelled the previous owner. Do not issue a second global
    // stop here: it could cancel the new settings preview that caused this event.
    streamingQueue.current?.cancel(); streamingQueue.current = undefined
    activeReplyId.current = undefined
    cleanupPlayback()
    void reportPlayback(false)
    if (!disposed.current) setStatus('standby')
  }), [])

  const playStreamSegment = async (text: string, turn: number, firstAudioStartedAt: number, onStarted?: () => void, cache = false): Promise<boolean> => {
    if (turnId.current !== turn || disposed.current) return false
    const output = speakable(text)
    if (!output) return true
    const id = crypto.randomUUID()
    activeReplyId.current = id
    try {
      const ttsStartedAt = performance.now()
      trace('tts-generation-start', undefined, `characters=${output.length};engine=${settingsRef.current?.localVoice.engine ?? 'unknown'}`)
      for await (const generated of handsFreeAudio(desktop, { id, text: output, ownership: ownership.current, cache }, () => activeReplyId.current === id && turnId.current === turn && !disposed.current)) {
        const ttsMs = Math.round(generated.generationMs)
        diagnostics.current.firstTtsMs ??= ttsMs
        diagnostics.current.ttsMs = (diagnostics.current.ttsMs ?? 0) + ttsMs
        trace('tts-generation-complete', Math.max(ttsMs, performance.now() - ttsStartedAt), `cached=${Boolean(generated.cached)};bytes=${generated.bytes?.byteLength ?? 0}`)
        if (activeReplyId.current !== id || turnId.current !== turn || disposed.current) return false
        if (!generated.ok || !generated.bytes?.length) {
          activeReplyId.current = undefined
          setNotice(generated.message ?? 'Athena’s local voice could not be generated.')
          return false
        }
        const url = URL.createObjectURL(new Blob([asBlobBytes(generated.bytes)], { type: generated.mimeType ?? 'audio/wav' }))
        audioUrl.current = url
        const player = new Audio(url)
        audio.current = player
        player.volume = settingsRef.current?.voiceVolume ?? 0.8
        player.playbackRate = settingsRef.current?.voiceSpeed ?? 1
        const finished = new Promise<boolean>((resolve) => {
          segmentFinished.current = resolve
          player.onended = () => {
            if (activeReplyId.current !== id) return
            segmentFinished.current = undefined
            cleanupPlayback()
            resolve(true)
          }
          player.onerror = () => {
            if (activeReplyId.current !== id) return
            activeReplyId.current = undefined
            cleanupPlayback()
            setNotice('Athena’s voice could not play. Check the Mac audio output device.')
          }
          player.onplaying = () => {
            if (activeReplyId.current !== id) return
            meter.current?.start(player)
            diagnostics.current.firstAudioMs ??= Math.round(performance.now() - firstAudioStartedAt)
            if (speechEndedAt.current !== undefined) diagnostics.current.speechEndToAudioMs ??= Math.round(performance.now() - speechEndedAt.current)
            if (!diagnostics.current.traceEvents?.some((entry) => entry.stage === 'first-audible-playback')) trace('first-audible-playback', undefined, `elapsedFromSpeechEndMs=${diagnostics.current.speechEndToAudioMs ?? 0}`)
          }
        })
        try {
          const playbackStarted = performance.now()
          await player.play()
          diagnostics.current.playbackStartMs = Math.round(performance.now() - playbackStarted)
          diagnostics.current.firstPlaybackStartMs ??= diagnostics.current.playbackStartMs
          diagnostics.current.firstAudioMs ??= Math.round(performance.now() - firstAudioStartedAt)
          if (cache) {
            diagnostics.current.wakeAckCached = generated.cached
            if (speechEndedAt.current !== undefined) diagnostics.current.wakeAcknowledgementMs ??= Math.round(performance.now() - speechEndedAt.current)
          }
          if (speechEndedAt.current !== undefined) diagnostics.current.speechEndToAudioMs ??= Math.round(performance.now() - speechEndedAt.current)
          if (!diagnostics.current.traceEvents?.some((entry) => entry.stage === 'first-audible-playback')) trace('first-audible-playback', undefined, `playPromiseResolved=true;elapsedFromSpeechEndMs=${diagnostics.current.speechEndToAudioMs ?? 0}`)
          if (activeReplyId.current !== id || turnId.current !== turn) return false
          void reportPlayback(true)
          setStatus('speaking')
          onStarted?.()
          if (!await finished) return false
        } catch {
          if (activeReplyId.current === id) { activeReplyId.current = undefined; cleanupPlayback() }
          setNotice('Athena’s voice could not play. Check the Mac audio output device.')
          return false
        }
      }
      if (activeReplyId.current === id) activeReplyId.current = undefined
      return turnId.current === turn && !disposed.current
    } catch {
      if (activeReplyId.current === id) { activeReplyId.current = undefined; cleanupPlayback(); setNotice('Local speech was interrupted or failed.') }
      return false
    }
  }

  const armFollowUpExpiry = () => {
    clearTimeout(followUpTimer.current)
    const seconds = interactionRef.current?.followUpTimeoutSeconds ?? 15
    followUpTimer.current = setTimeout(() => {
      followUpActive.current = false
      pendingChat.current = null
      pendingAction.current = null
      void desktop.clearHandsFreeContext()
      setStatus('standby')
    }, seconds * 1000)
  }

  const say = async (text: string, keepFollowUp = true, turn?: number, cache = false) => {
    if (turn !== undefined && turnId.current !== turn) return
    const output = speakable(text)
    const currentSettings = settingsRef.current
    const allowFollowUp = keepFollowUp && Boolean(interactionRef.current?.followUpEnabled)
    if (!output || !interactionRef.current?.autoVoiceResponse || !currentSettings?.voiceEnabled || currentSettings.voiceMuted || currentSettings.doNotDisturb) {
      if (allowFollowUp && followUpActive.current) { setStatus('follow-up'); armFollowUpExpiry() }
      else endVoiceConversation()
      return
    }
    await stopPlayback()
    if (turn !== undefined && turnId.current !== turn) return
    setStatus('processing', 'Preparing Athena’s local voice…')
    const speakingTurn = turnId.current
    let started!: () => void
    const began = new Promise<void>((resolve) => { started = resolve })
    void playStreamSegment(output, speakingTurn, performance.now(), started, cache).then((ok) => {
      if (turnId.current !== speakingTurn || disposed.current) return
      void reportPlayback(false)
      if (allowFollowUp && followUpActive.current) { setStatus('follow-up', ok ? undefined : 'Local speech stopped or failed.'); armFollowUpExpiry() }
      else { endVoiceConversation(); if (!ok) setStatus('error', 'Local speech stopped or failed.') }
    }).finally(started)
    // Preserve the existing contract: return once playback starts, not after
    // the whole utterance. Completion still owns follow-up/idle transitions.
    await began
  }

  const clarify = async () => {
    const now = Date.now()
    if (now < clarificationCooldownUntil.current) {
      setStatus('follow-up'); armFollowUpExpiry(); return
    }
    clarificationFailures.current++
    const text = clarificationFailures.current >= 3
      ? "I'm having a little trouble hearing you. Could you try speaking a bit closer?"
      : chooseClarification(previousClarification.current)
    previousClarification.current = text
    if (clarificationFailures.current >= 3) clarificationCooldownUntil.current = now + 4_000
    followUpActive.current = true
    await say(text, true)
  }

  const getChat = () => desktop.getChat()
  const findSession = async (query: string) => {
    const chat = await getChat()
    const matches = (chat.sessions ?? []).filter((session) => session.title.toLowerCase().includes(query.toLowerCase()))
    return { chat, matches }
  }
  const routeSessionCommand = async (text: string): Promise<string | null> => {
    const command = normalizeVoiceCommand(text)
    if (/^(?:open my chat|show my chat|open chat|show chat|open my conversations|show my conversations)$/i.test(command)) {
      await desktop.command('open-chat'); return 'Sure. I opened your conversations.'
    }
    if (/^(?:create|start) (?:a )?new chat(?: for this project)?$/i.test(command)) {
      const chat = await getChat(), project = /for this project$/i.test(command) ? chat.workspaces?.[0]?.id : undefined
      const result = await desktop.chatSession({ action: 'create', ...(project ? { workspaceId: project } : {}) })
      return result.ok ? 'A new chat is ready.' : result.message ?? 'I could not create a new chat.'
    }
    if (/^(?:close|hide) (?:my )?(?:chat|conversation)$/i.test(command)) {
      await desktop.command('close-chat'); return 'Okay, I closed the chat window.'
    }
    const rename = /^(?:rename|call) (?:this|the current) chat (?:to|as) (.+)$/i.exec(command)
    if (rename) {
      const chat = await getChat()
      if (!chat.sessionId) return 'There is no active chat to rename.'
      const result = await desktop.chatSession({ action: 'rename', id: chat.sessionId, title: rename[1].trim() })
      return result.ok ? `Done. I renamed this chat to ${rename[1].trim()}.` : result.message ?? 'I could not rename this chat.'
    }
    if (/^(?:show|list) (?:my )?(?:chats|conversations)$/i.test(command)) {
      const chat = await getChat(), titles = (chat.sessions ?? []).slice(0, 6).map((session) => session.title)
      return titles.length ? `Here are your recent conversations: ${titles.join('; ')}.` : 'There are no saved conversations yet.'
    }
    const requestedProject = /^(?:open|switch to|use) (?:my )?(?:last |the )?(.+?) project(?: in (?:vs code|visual studio code))?$/i.exec(command)
    if (requestedProject || /^(?:open|switch to) my last project$/i.test(command)) {
      const chat = await getChat(), query = requestedProject?.[1]?.replace(/^(?:last|the)\s+/i, '')
      const sessions = (chat.sessions ?? []).filter((session) => session.project)
      const matches = query && !/^(?:last|current)$/i.test(query) ? sessions.filter((session) => session.project!.name.toLowerCase().includes(query.toLowerCase())) : sessions.slice(0, 1)
      const unique = [...new Map(matches.map((session) => [session.project!.id, session])).values()]
      if (unique.length === 1) {
        const result = await desktop.chatSession({ action: 'switch', id: unique[0].id })
        if (result.ok) { await desktop.command('open-chat'); return `I switched to the ${unique[0].project!.name} project conversation.` }
      }
      if (unique.length > 1) return `I found more than one match: ${unique.map((session) => session.project!.name).join(', ')}. Which project did you mean?`
      if (chat.sessionId) {
        const result = await desktop.chatContext({ action: 'connect', sessionId: chat.sessionId })
        return result.ok ? 'I opened the project folder picker. Choose the folder you want to authorize.' : result.message ?? 'I could not open the project picker.'
      }
      return 'Open a chat first, then I can attach a project folder to it.'
    }
    const switchChat = /^(?:open|switch to) (?:my )?(.+?) (?:chat|conversation)$/i.exec(command)
    if (switchChat) {
      const { matches } = await findSession(switchChat[1])
      if (matches.length === 1) { await desktop.chatSession({ action: 'switch', id: matches[0].id }); await desktop.command('open-chat'); return `I opened ${matches[0].title}.` }
      if (matches.length > 1) return `I found a few matching chats: ${matches.slice(0, 5).map((item) => item.title).join(', ')}. Which one should I open?`
      return `I could not find a chat called ${switchChat[1]}.`
    }
    const readLatest = /^(?:read|say) (?:the )?(?:latest|last) (?:chat )?(?:response|answer|message)$/i.test(command)
    if (readLatest) {
      const chat = await getChat(), message = [...chat.messages].reverse().find((entry) => entry.role === 'assistant' && entry.content.trim())
      return message?.content ?? 'There is no assistant response in the active chat yet.'
    }
    if (/^(?:summarize|summary of) (?:this|my current) conversation$/i.test(command)) {
      const chat = await getChat(), excerpt = chat.messages.slice(-12).map((message) => `${message.role}: ${message.content.slice(0, 1200)}`).join('\n')
      if (!excerpt) return 'The active conversation is empty.'
      const response = await desktop.answerHandsFree({ text: `Summarize this conversation briefly and accurately. Use only this transcript as evidence:\n${excerpt}`, ownership: ownership.current })
      return response.ok ? response.text ?? 'I could not summarize the conversation.' : response.message ?? 'I could not summarize the conversation.'
    }
    return null
  }

  const sendOrDraft = async (kind: Exclude<PendingChatAction, null>, text: string, sessionQuery?: string): Promise<string> => {
    let chat = await getChat(), sessionId = chat.sessionId
    if (sessionQuery) {
      const match = (chat.sessions ?? []).filter((session) => session.title.toLowerCase().includes(sessionQuery.toLowerCase()))
      if (match.length !== 1) return match.length ? `I found more than one chat matching ${sessionQuery}. Please say the full chat name.` : `I could not find a chat called ${sessionQuery}.`
      sessionId = match[0].id
      const switched = await desktop.chatSession({ action: 'switch', id: sessionId })
      if (!switched.ok) return switched.message ?? 'I could not switch to that chat.'
      chat = await getChat()
    }
    if (!sessionId) return 'There is no active chat to use.'
    if (kind === 'draft') {
      const result = await desktop.chatSession({ action: 'draft', id: sessionId, text })
      return result.ok ? 'I put that in the chat draft without sending it.' : result.message ?? 'I could not create the draft.'
    }
    if (chat.phase !== 'idle') return 'That chat is still working. I did not send another message.'
    const sent = await desktop.sendChat({ text, sessionId })
    await desktop.command('open-chat')
    return sent.ok ? 'I sent that to the selected chat.' : sent.message ?? 'I could not send the message.'
  }

  const executeVoiceAction = async (action: PendingVoiceAction, confirmed = false): Promise<string> => {
    const options = { confirmed }
    const result = action.action === 'open-app'
      ? await desktop.openApplicationByVoice({ app: action.app, ...options })
      : action.action === 'focus-app'
        ? await desktop.focusApplicationByVoice({ app: action.app, ...options })
        : await desktop.openURLByVoice({ url: action.url, ...options })
    return result.message || (result.ok ? 'The requested desktop action is complete.' : 'I could not complete that desktop action.')
  }

  const queueVoiceURL = async (address: string): Promise<string> => {
    const action: PendingVoiceAction = { action: 'open-url', url: address }
    const mode = (await getChat()).config?.agentMode ?? 'ask'
    if (mode === 'read-only') return 'Read Only mode blocks desktop actions. Change the permission mode in this conversation before asking me to open it.'
    if (mode === 'ask') { pendingAction.current = action; return `Would you like me to open ${address}? Say yes to confirm or no to cancel.` }
    return executeVoiceAction(action)
  }

  // `null` means this is not one of Athena's local voice commands and should
  // fall through to the conversational AI. `undefined` means a command was
  // handled silently (for example, "stop talking" or "stop listening").
  const routeCommand = async (rawText: string): Promise<string | null | undefined> => {
    const text = normalizeVoiceCommand(rawText).replace(/^(?:wait|hold on|listen)[,\s]+/i, '')
    const interrupt = isVoiceInterruption(rawText)
    if (interrupt === 'stop-speech') { await stopPlayback(); return undefined }
    if (interrupt === 'cancel-task') {
      pendingAction.current = null
      await stopPlayback()
      const chat = await getChat()
      if (chat.phase !== 'idle') { await desktop.stopChat(); return 'Okay, I stopped the active chat task. Any completed changes are preserved.' }
      return 'Okay, I cancelled that pending action.'
    }
    if (interrupt === 'standby') {
      followUpActive.current = false; pendingChat.current = null; pendingAction.current = null; clearTimeout(followUpTimer.current)
      await stopPlayback(); await desktop.clearHandsFreeContext(); setStatus('standby'); return undefined
    }
    if (pendingAction.current) {
      if (/^(?:yes|yes please|do it|go ahead|confirm|sure|okay|ok)$/i.test(text)) {
        const action = pendingAction.current; pendingAction.current = null
        return executeVoiceAction(action, true)
      }
      if (/^(?:no|no thanks|cancel|not now|don't|do not)$/i.test(text)) {
        pendingAction.current = null
        return 'Okay, I did not open anything.'
      }
      pendingAction.current = null
    }
    if (pendingChat.current) {
      const pending = pendingChat.current; pendingChat.current = null
      return sendOrDraft(pending, text)
    }
    const draft = /^(?:type|put|draft) (?:this )?(?:in|into) (?:my )?(?:current )?chat(?:\s*[:,-]\s*|\s+)(.+)$/i.exec(text)
    if (draft) return sendOrDraft('draft', draft[1])
    if (/^(?:type|put|draft) (?:this )?(?:in|into) (?:my )?(?:current )?chat$/i.test(text)) {
      pendingChat.current = 'draft'; return 'What would you like me to put in the chat draft?'
    }
    const explicitSend = /^(?:send|ask) (?:this )?(?:to|in) (?:my )?(?:current )?chat(?:\s*[:,-]\s*|\s+)(.+)$/i.exec(text)
    if (explicitSend) return sendOrDraft('send', explicitSend[1])
    const namedSend = /^ask my (.+?) chat(?:\s+(?:where|how|what|why|when|about)\b|\s*[:,-]\s*)(.+)$/i.exec(text)
    if (namedSend) return sendOrDraft('send', namedSend[2], namedSend[1])
    if (/^(?:send|ask) (?:a )?message to (?:my )?(?:current )?chat$/i.test(text)) {
      pendingChat.current = 'send'; return 'Sure. What would you like me to send?'
    }
    const nativeAutomationRequest = /\b(?:new\s+(?:online\s+|local\s+)?(?:chat|conversation)|ChatGPT\s+conversation|Online\s+AI\s+Chat|Athena\s+Academy|YouTube|https?:\/\/|VS\s*Code|Visual\s+Studio\s+Code)\b/i.test(text)
    if (!nativeAutomationRequest) {
      const sessionResponse = await routeSessionCommand(text)
      if (sessionResponse) return sessionResponse
    }
    const browserRequest = parseVoiceWebOpen(text)
    if (browserRequest?.kind === 'result') {
      const result = await desktop.getVoiceSearchResult({ index: browserRequest.index })
      return result.ok && result.url ? queueVoiceURL(result.url) : result.message ?? 'I do not have that search result anymore. Search again first.'
    }
    // Explicit URL opens go through the main-process browser action so the
    // Browser Access permission, OS result, audit record, and diagnostics are
    // the same for voice and local Athena Chat.
    if (browserRequest?.kind === 'url') return null
    const app = appAction(text)
    if (app) return null
    return null
  }

  const routeTranscript = async (transcript: string, turn: number) => {
    if (turnId.current !== turn || disposed.current) return
    const interaction = interactionRef.current
    if (!interaction) return
    const routingStarted = performance.now()
    trace('transcript-routing-start', undefined, `characters=${transcript.length}`)
    const route = classifyHandsFreeTranscript(transcript, interaction.wakePhrases, followUpActive.current, interaction.followUpEnabled)
    trace('transcript-routing-complete', performance.now() - routingStarted, `kind=${route.kind}`)
    if (route.kind === 'ignore') {
      setStatus('standby')
      return
    }
    clarificationFailures.current = 0
    previousClarification.current = undefined
    clarificationCooldownUntil.current = 0
    setStatus('listening')
    followUpActive.current = interaction.followUpEnabled
    clearTimeout(followUpTimer.current)
    if (route.kind === 'wake-only') {
      const engine = settingsRef.current?.localVoice.engine
      const acknowledgement = engine && isSesameEngine(engine) ? SESAME_WAKE_ACKNOWLEDGEMENT
        : engine && isHiggsEngine(engine) ? chooseHiggsWakeAcknowledgement(previousWakeAcknowledgement.current)
        : chooseWakeAcknowledgement(previousWakeAcknowledgement.current)
      previousWakeAcknowledgement.current = acknowledgement
      if (speechEndedAt.current !== undefined) diagnostics.current.wakeRecognitionMs = Math.round(performance.now() - speechEndedAt.current)
      await say(acknowledgement, interaction.followUpEnabled, turn, true)
      return
    }
    const request = route.text
    let awaitingAnswer = false
    try {
      const commandRoutingStarted = performance.now()
      const directDiagnostic = diagnostics.current.traceMode === 'direct'
      const actionResult = directDiagnostic ? null : await routeCommand(request)
      trace(directDiagnostic ? 'voice-command-routing-bypassed' : 'voice-command-routing-complete', performance.now() - commandRoutingStarted, `action=${actionResult === null ? 'none' : actionResult === undefined ? 'deferred' : 'handled'}`)
      if (turnId.current !== turn || phaseRef.current === 'paused') return
      if (actionResult === undefined) {
        if (followUpActive.current) { setStatus('follow-up'); armFollowUpExpiry() }
        else endVoiceConversation()
        return
      }
      if (actionResult !== null) { await say(actionResult, interaction.followUpEnabled, turn); return }
      setStatus('processing', 'Athena is thinking…')
      awaitingAnswer = true
      const aiStarted = performance.now()
      diagnostics.current.aiPreparationMs = undefined
      diagnostics.current.aiFirstTokenMs = undefined
      diagnostics.current.firstTtsMs = undefined
      diagnostics.current.ttsMs = 0
      diagnostics.current.firstPlaybackStartMs = undefined
      diagnostics.current.firstAudioMs = undefined
      diagnostics.current.speechEndToAudioMs = undefined
      const canSpeak = interaction.autoVoiceResponse && Boolean(settingsRef.current?.voiceEnabled) && !settingsRef.current?.voiceMuted && !settingsRef.current?.doNotDisturb
      const replyId = traceClock.current?.id ?? crypto.randomUUID()
      const turnOwner = ownership.current
      const sentences = new VoiceSentenceBuffer()
      const queue = canSpeak ? new VoiceSegmentQueue() : undefined
      if (queue) streamingQueue.current = queue
      let modelStartedAt = aiStarted
      let streamedText = false
      const unsubscribe = desktop.onHandsFreeReplyProgress((event) => {
        if (event.id !== replyId || turnId.current !== turn || disposed.current || !turnOwner
          || event.ownership?.origin !== 'athena-local' || event.ownership.sessionId !== turnOwner.sessionId
          || event.ownership.correlationId !== turnOwner.correlationId) return
        if (event.type === 'model-start') { modelStartedAt = performance.now(); diagnostics.current.aiPreparationMs = Math.round(modelStartedAt - aiStarted) }
        if (event.type === 'trace' && event.trace) {
          const item = event.trace
          if (item.stage === 'first-token') {
            diagnostics.current.aiFirstTokenMs = item.durationMs
            if (speechEndedAt.current !== undefined) diagnostics.current.speechEndToFirstTokenMs = Math.round(performance.now() - speechEndedAt.current)
          }
          trace(`${item.transport}-${item.stage}`, item.durationMs, JSON.stringify({ model: item.model, transport: item.transport, endpoint: item.endpoint, promptBytes: item.promptBytes, toolBytes: item.toolBytes, promptTokenEstimate: item.promptTokenEstimate, inputTokens: item.inputTokens, outputTokens: item.outputTokens, numCtx: item.numCtx, numPredict: item.numPredict, temperature: item.temperature, keepAlive: item.keepAlive, think: item.think, stream: item.stream, toolCount: item.toolCount, messageCount: item.messageCount, round: item.round, timestamp: item.timestamp }))
          return
        }
        if (event.type !== 'text' || !event.text) return
        if (!streamedText) diagnostics.current.aiFirstTokenMs ??= Math.round(performance.now() - modelStartedAt)
        streamedText = true
        for (const segment of sentences.push(event.text)) queue?.push(speakable(segment))
      })
      const playback = queue ? (async () => {
        let played = true
        for (;;) {
          const segment = await queue.take()
          if (segment === undefined || turnId.current !== turn || disposed.current) break
          if (!await playStreamSegment(segment, turn, aiStarted)) { played = false; queue.cancel(); break }
          if (turnId.current === turn && phaseRef.current === 'speaking') setStatus('processing', 'Athena is preparing the next phrase…')
        }
        return played
      })() : undefined
      let response: Awaited<ReturnType<typeof desktop.answerHandsFree>>
      try { response = await desktop.answerHandsFree({ id: replyId, text: request, ownership: turnOwner, ...(directDiagnostic ? { diagnosticDirect: true } : {}) }) }
      finally { diagnostics.current.aiMs = Math.round(performance.now() - aiStarted); unsubscribe() }
      awaitingAnswer = false
      if (turnId.current !== turn || disposed.current) { queue?.cancel(); await playback; return }
      if (!queue) {
        await say(response.ok && response.text ? response.text : response.message ?? 'Sorry, I couldn’t finish that. Could you try again?', interaction.followUpEnabled, turn)
        return
      }
      if (response.ok && response.text) {
        if (!streamedText) for (const segment of sentences.push(response.text)) queue.push(speakable(segment))
        for (const segment of sentences.flush()) queue.push(speakable(segment))
      } else queue.push(response.message ?? 'Sorry, I couldn’t finish that. Could you try again?')
      queue.finish()
      const played = await playback
      if (streamingQueue.current === queue) streamingQueue.current = undefined
      if (turnId.current !== turn || disposed.current) return
      void reportPlayback(false)
      trace('voice-turn-complete', undefined, `responseOk=${response.ok};playbackOk=${played};elapsedFromSpeechEndMs=${speechEndedAt.current === undefined ? 0 : Math.round(performance.now() - speechEndedAt.current)}`)
      if (!played) { const message = 'Athena’s local voice could not finish. Check My Athena → Local AI setup → Local voice.'; if (followUpActive.current) { setStatus('follow-up', message); armFollowUpExpiry() } else { endVoiceConversation(); setStatus('error', message) } }
      else if (followUpActive.current) { setStatus('follow-up'); armFollowUpExpiry() }
      else endVoiceConversation()
    } catch {
      if (turnId.current === turn && !disposed.current) {
        awaitingAnswer = false
        streamingQueue.current?.cancel()
        streamingQueue.current = undefined
        await say('Sorry, I couldn’t finish that. Could you try again?', interaction.followUpEnabled, turn)
      }
    } finally {
      if (awaitingAnswer && turnId.current === turn && !disposed.current && phaseRef.current === 'processing') {
        if (followUpActive.current) { setStatus('follow-up'); armFollowUpExpiry() }
        else endVoiceConversation()
      }
    }
  }

  useEffect(() => {
    if (!interaction?.handsFreeEnabled || !visible || manualVoiceActive || !localSessionId) {
      disposed.current = true
      turnId.current++
      const active = runtime.current
      runtime.current = undefined
      if (active) releaseCapture(active)
      clearTimeout(followUpTimer.current); followUpTimer.current = undefined
      followUpActive.current = false; pendingChat.current = null
      if (leaseActive.current) {
        if (activeReplyId.current || audio.current) void stopPlayback()
        void desktop.cancelHandsFreeReply(); void reportVoiceState({ state: 'paused' }); releaseVoiceLease(ownership.current)
      }
      if (interaction?.handsFreeEnabled && !visible) {
        void reportVoiceState({ state: 'error', message: 'Floating Athena is hidden. Turn on Floating Athena to start hands-free listening.' })
      } else if (interaction?.handsFreeEnabled && manualVoiceActive) {
        void reportVoiceState({ state: 'paused', message: 'Hands-free is paused while chat microphone input is active.' })
      }
      setPhase('paused')
      return
    }
    disposed.current = false
    let cancelled = false
    let effectOwner: AIOwnership | undefined
    const failCapture = (active: CaptureRuntime, message: string) => {
      if (runtime.current !== active) return
      runtime.current = undefined
      releaseCapture(active)
      releaseVoiceLease(effectOwner)
      setStatus('error', message)
    }
    const boot = async () => {
      let startupStage = 'loading local speech detector'
      setStatus('processing', 'Starting microphone…')
      const authorized = await desktop.enableHandsFree(localSessionId)
      if (!authorized.ok) { if (!cancelled) setStatus('error', authorized.message ?? 'Hands-free microphone authorization failed.'); return }
      effectOwner = authorized.ownership
      if (!effectOwner) { if (!cancelled) setStatus('error', 'Hands-free authorization did not return a local session lease.'); return }
      if (cancelled) { releaseVoiceLease(effectOwner); return }
      ownership.current = effectOwner
      leaseActive.current = true
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
        releaseVoiceLease(effectOwner)
        setStatus('error', 'This Athena runtime cannot run the local speech detector. Update Athena and try again.')
        return
      }
      try {
        const active: CaptureRuntime = { vad: undefined as unknown as MicVAD, processing: false, noiseFloor: new AdaptiveNoiseFloor(), lastThresholdUpdate: 0 }
        runtime.current = active
        const createStream = async () => {
          const current = interactionRef.current ?? interaction
          let stream: MediaStream
          const constraints = microphoneConstraints(current)
          try { stream = await navigator.mediaDevices.getUserMedia(constraints) }
          catch (error) {
            // Some macOS input stacks advertise voice isolation but reject it.
            // Retry once without that optional control; noise suppression stays on.
            const audio = constraints.audio
            if (!audio || typeof audio !== 'object' || !('voiceIsolation' in audio)) throw error
            const fallback = handsFreeMicrophoneConstraints(current.noiseSuppressionLevel, false)
            stream = await navigator.mediaDevices.getUserMedia(fallback)
          }
          active.stream = stream
          for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
            if (runtime.current !== active || cancelled) return
            failCapture(active, 'Microphone disconnected. Reconnect it, then turn Hands-Free Athena off and on in Settings → Voice.')
          }, { once: true })
          if (active.deviceChange) navigator.mediaDevices.removeEventListener('devicechange', active.deviceChange)
          active.deviceChange = () => {
            if (runtime.current === active && stream.getAudioTracks().every((track) => track.readyState === 'ended')) failCapture(active, 'Microphone input changed or disconnected. Reconnect it and restart hands-free listening in Settings → Voice.')
          }
          navigator.mediaDevices.addEventListener?.('devicechange', active.deviceChange)
          return stream
        }
        const onSpeechEnd = async (samples: Float32Array) => {
          if (runtime.current !== active || active.processing || cancelled) { samples.fill(0); return }
          active.processing = true
          speechEndedAt.current = performance.now()
          const turn = ++turnId.current
          if (speechStartedAt.current !== undefined) diagnostics.current.speechMs = Math.round(performance.now() - speechStartedAt.current)
          if (lastSpeechFrameAt.current !== undefined) diagnostics.current.endpointMs = Math.round(performance.now() - lastSpeechFrameAt.current)
          trace('vad-end-detected', diagnostics.current.endpointMs, `speechDurationMs=${diagnostics.current.speechMs ?? 0};redemptionMs=${silenceEndpointMs(interactionRef.current?.endOfSpeechDelayMs ?? interaction.endOfSpeechDelayMs, diagnostics.current.speechMs ?? 0)}`)
          speechStartedAt.current = undefined
          lastSpeechFrameAt.current = undefined
          const id = traceClock.current?.id ?? crypto.randomUUID(); active.requestId = id
          let wav: Uint8Array<ArrayBuffer> | undefined
          let vadPaused = false
          let transcript: string | undefined
          let needsClarification = false
          const resumeVad = async (): Promise<boolean> => {
            if (!vadPaused) return runtime.current === active && !cancelled
            if (runtime.current !== active || cancelled) { vadPaused = false; return false }
            try {
              await active.vad?.start()
              vadPaused = false
              return true
            } catch {
              vadPaused = false
              failCapture(active, 'The local speech listener could not resume. Turn Hands-Free Athena off and on in Settings → Voice.')
              return false
            }
          }
          try {
            if (!isUsableSpeechSegment(samples, active.noiseFloor.current())) {
              trace('speech-segment-rejected')
              if (followUpActive.current) { setStatus('follow-up'); armFollowUpExpiry() }
              else setStatus('standby')
              return
            }
            setStatus('processing', 'Transcribing speech locally…')
            const wavStarted = performance.now()
            wav = encodeHandsFreeWav(samples)
            diagnostics.current.wavMs = Math.round(performance.now() - wavStarted)
            if (cancelled || runtime.current !== active) return
            // Whisper and Silero are both local inference workloads. Pause the
            // live VAD loop while Whisper decodes, then resume before AI/TTS so
            // interruption detection remains available during the response.
            try {
              if (active.vad?.listening) {
                const pauseStarted = performance.now()
                await active.vad.pause()
                vadPaused = true
                trace('vad-paused-for-whisper', performance.now() - pauseStarted)
              }
            } catch { /* Whisper can still proceed if VAD pause is unavailable. */ }
            const sttStarted = performance.now()
            trace('whisper-start', undefined, `wavBytes=${wav.byteLength}`)
            let result: Awaited<ReturnType<typeof desktop.transcribeHandsFree>>
            try { result = await desktop.transcribeHandsFree({ id, mimeType: 'audio/wav', bytes: wav }) }
            finally { diagnostics.current.sttMs = Math.round(performance.now() - sttStarted); trace('whisper-complete', diagnostics.current.sttMs) }
            if (runtime.current !== active || cancelled) return
            const wasVadPaused = vadPaused
            const resumeStarted = performance.now()
            if (!await resumeVad()) return
            if (wasVadPaused) trace('vad-resumed-after-whisper', performance.now() - resumeStarted)
            if (!result.ok || !result.transcript?.trim()) {
              const message = result.message ?? ''
              if (/cancel(?:led|ed)|intentional/i.test(message)) {
                if (followUpActive.current) { setStatus('follow-up'); armFollowUpExpiry() }
                else setStatus('standby')
                return
              }
              if (isPersistentSpeechServiceError(message)) {
                setStatus('error', 'Local speech recognition needs attention. Check My Athena → Local AI setup → Local voice. Microphone clips stay on this Mac.')
                void active.vad?.pause().catch(() => {})
                return
              }
              if (followUpActive.current) needsClarification = true
              else setStatus('standby')
              return
            }
            transcript = result.transcript.trim()
            trace('transcript-ready', undefined, `characters=${transcript.length}`)
          } catch {
            if (runtime.current === active && !cancelled) {
              if (!await resumeVad()) return
              if (followUpActive.current) needsClarification = true
              else setStatus('standby')
            }
          } finally {
            if (vadPaused) await resumeVad()
            wav?.fill(0); samples.fill(0)
            if (active.requestId === id) active.requestId = undefined
            if (runtime.current === active) active.processing = false
            if (runtime.current === active && !cancelled && turnId.current === turn) {
              if (transcript) void routeTranscript(transcript, turn).catch(() => { if (turnId.current === turn) { if (followUpActive.current) { setStatus('follow-up'); armFollowUpExpiry() } else setStatus('standby') } })
              else if (needsClarification) void clarify().catch(() => { if (turnId.current === turn) { setStatus('follow-up'); armFollowUpExpiry() } })
            }
          }
        }
        const vadOptions: Partial<RealTimeVADOptions> = {
          model: 'v5', startOnLoad: false, processorType: 'AudioWorklet',
          baseAssetPath: new URL('vad-assets/', window.location.href).href,
          onnxWASMBasePath: new URL('vad-assets/', window.location.href).href,
          getStream: createStream,
          // Disconnect Silero during Whisper, but keep the authorized capture
          // stream alive. Reopening CoreAudio on every utterance added latency
          // and repeatedly allocated input-device resources.
          pauseStream: async () => {},
          resumeStream: async (stream) => stream,
          positiveSpeechThreshold: speechThresholds(interactionRef.current ?? interaction, active.noiseFloor.current()).positiveSpeechThreshold,
          negativeSpeechThreshold: speechThresholds(interactionRef.current ?? interaction, active.noiseFloor.current()).negativeSpeechThreshold,
          minSpeechMs: 300, preSpeechPadMs: 360,
          redemptionMs: interactionRef.current?.endOfSpeechDelayMs ?? interaction.endOfSpeechDelayMs,
          submitUserSpeechOnPause: false,
          ortConfig: (ort) => { ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1 },
          onFrameProcessed: (probabilities, frame) => {
            if (runtime.current !== active) return
            const current = interactionRef.current
            if (!current) return
            if (import.meta.env.DEV && speechStartedAt.current !== undefined && probabilities.isSpeech >= 0.5) lastSpeechFrameAt.current = performance.now()
            const floor = active.noiseFloor.observe(frameRms(frame), probabilities.isSpeech, current.automaticNoiseCalibration)
            const now = Date.now()
            if (now - active.lastThresholdUpdate >= 500) {
              const thresholds = speechThresholds(current, floor)
              active.vad?.setOptions({ ...thresholds, redemptionMs: silenceEndpointMs(current.endOfSpeechDelayMs, speechStartedAt.current === undefined ? 0 : performance.now() - speechStartedAt.current) })
              active.lastThresholdUpdate = now
            }
          },
          onSpeechRealStart: () => {
            if (runtime.current !== active || cancelled) return
            speechStartedAt.current = performance.now()
            lastSpeechFrameAt.current = speechStartedAt.current
            startTrace()
            const current = interactionRef.current
            if (current) active.vad?.setOptions({ redemptionMs: current.endOfSpeechDelayMs })
            if (!followUpActive.current || !current) return
            if (phaseRef.current === 'speaking' && !current.allowSpeechInterruption) return
            clearTimeout(followUpTimer.current); followUpTimer.current = undefined
            if (phaseRef.current === 'speaking' || phaseRef.current === 'processing') {
              turnId.current++
              void desktop.cancelHandsFreeReply()
              if (activeReplyId.current || audio.current) void stopPlayback()
            }
            setStatus('listening')
          },
          onSpeechEnd,
          onVADMisfire: () => {},
        }
        active.vad = await MicVAD.new(vadOptions)
        if (cancelled || disposed.current) { releaseCapture(active); if (runtime.current === active) runtime.current = undefined; return }
        startupStage = 'opening microphone and audio processor'
        try {
          await active.vad.start()
        } catch (error) {
          if (!shouldFallbackFromAudioWorklet(error) || cancelled || disposed.current) throw error
          // Some packaged Electron/macOS audio stacks reject AudioWorklet module
          // loading for the app's custom secure scheme. Keep Silero VAD local and
          // fall back to its supported ScriptProcessor adapter in that case only.
          const workletVad = active.vad
          active.vad = undefined
          try { await workletVad.destroy() } catch { /* A partial worklet init may not yet have a processor node. */ }
          active.stream?.getTracks().forEach((track) => track.stop())
          active.stream = undefined
          if (active.deviceChange) navigator.mediaDevices?.removeEventListener('devicechange', active.deviceChange)
          active.deviceChange = undefined
          active.vad = await MicVAD.new({ ...vadOptions, processorType: 'ScriptProcessor' })
          if (cancelled || disposed.current) { releaseCapture(active); if (runtime.current === active) runtime.current = undefined; return }
          startupStage = 'opening fallback audio processor'
          await active.vad.start()
        }
        if (cancelled || disposed.current) { releaseCapture(active); if (runtime.current === active) runtime.current = undefined; return }
        if (!cancelled) setStatus('standby')
      } catch (error) {
        if (runtime.current && ownership.current?.correlationId === effectOwner?.correlationId) { const active = runtime.current; runtime.current = undefined; releaseCapture(active) }
        if (cancelled) return
        releaseVoiceLease(effectOwner)
        const errorName = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error'
        const errorMessage = error instanceof Error ? error.message : String(error ?? '')
        const safeDetail = `${startupStage}: ${errorName}${errorMessage ? ` — ${errorMessage}` : ''}`
          .replace(/(?:athena|file|https?):\/\/[^\s)]+/gi, '[local audio asset]').replace(/\s+/g, ' ').slice(0, 210)
        console.error('Hands-free microphone startup failed', { detail: safeDetail })
        // Keep the root cause visible in Settings; the generic error sentence was
        // consuming most of the IPC status limit and truncating ONNX/WASM errors.
        setStatus('error', `Hands-free startup failed: ${safeDetail}`.slice(0, 240))
      }
    }
    void boot()
    return () => {
      cancelled = true
      turnId.current++
      const active = runtime.current
      runtime.current = undefined
      if (active) releaseCapture(active)
      clearTimeout(followUpTimer.current); followUpTimer.current = undefined
      if (effectOwner && ownership.current?.correlationId === effectOwner.correlationId) {
        if (activeReplyId.current || audio.current) void stopPlayback()
        void desktop.cancelHandsFreeReply(); void reportVoiceState({ state: 'paused' })
      }
      releaseVoiceLease(effectOwner)
    }
  }, [interaction?.handsFreeEnabled, visible, manualVoiceActive, localSessionId, JSON.stringify(settings?.localAI)])

  useEffect(() => {
    const active = runtime.current
    if (!active) return
    const current = interactionRef.current
    if (!current) return
    const thresholds = speechThresholds(current, active.noiseFloor.current())
    active.vad?.setOptions({ ...thresholds, redemptionMs: current.endOfSpeechDelayMs })
    const constraints = microphoneConstraints(current).audio
    if (constraints && typeof constraints === 'object') void active.stream?.getAudioTracks()[0]?.applyConstraints(constraints).catch(() => {})
  }, [interaction?.noiseSuppressionLevel, interaction?.automaticNoiseCalibration, interaction?.wakeSensitivity, interaction?.endOfSpeechDelayMs])

  useEffect(() => {
    if (!interaction?.handsFreeEnabled || !settings?.voiceEnabled || settings.voiceMuted || settings.doNotDisturb) {
      if (!interaction?.handsFreeEnabled) return
      cleanupPlayback(); activeReplyId.current = undefined
      void desktop.stopHandsFreeSpeech(); void reportPlayback(false)
      if (followUpActive.current) setStatus('follow-up')
    }
  }, [interaction?.handsFreeEnabled, settings?.voiceEnabled, settings?.voiceMuted, settings?.doNotDisturb])

  if (!interaction?.handsFreeEnabled) return null
  const labels: Record<Phase, string> = { standby: 'Listening for Athena', listening: 'Listening', processing: 'Processing', speaking: 'Speaking', 'follow-up': 'Ready for follow-up', paused: 'Paused', error: notice || 'Microphone unavailable' }
  return <div className={`hands-free-status hands-free-${phase}`} role="status" aria-label={notice || labels[phase]}>
    <span className="hands-free-status-dot" aria-hidden="true" />
    {import.meta.env.DEV && <button type="button" className="hands-free-diagnostic" aria-pressed={diagnosticDirectMode} title="Switching modes clears temporary voice history so both runs start with the same short prompt. Whisper and spoken playback stay enabled." disabled={phase === 'processing' || phase === 'speaking'} onClick={() => void toggleDiagnosticMode()}>{diagnosticDirectMode ? 'Direct test · ON' : 'Direct test · OFF'}</button>}
    <button type="button" aria-label="Stop hands-free listening" title="Stop listening" onClick={() => void desktop.updateSettings({ voiceInteraction: { ...interaction, handsFreeEnabled: false } })}><MicOff size={12} /></button>
  </div>
}
