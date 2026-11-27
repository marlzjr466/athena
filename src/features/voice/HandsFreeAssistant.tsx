import { LivePeer } from '../../services/speech/livePeer'
import { MicrophoneSource, currentAudioDevices, onAudioDevices, routeSpeech } from '../../services/speech/audioDevices'
import { useEffect, useRef, useState } from 'react'
import { MicOff } from 'lucide-react'
import { MicVAD, type RealTimeVADOptions } from '@ricky0123/vad-web'
import { AdaptiveNoiseFloor, isPlaybackEcho, chooseClarification, chooseWakeAcknowledgement, classifyHandsFreeTranscript, encodeHandsFreeWav, handsFreeMicrophoneConstraints, isUsableSpeechSegment, isVoiceInterruption, negativeSpeechConfidenceThreshold, shouldFallbackFromAudioWorklet, silenceEndpointMs, speechConfidenceThreshold, type HandsFreeState } from '../../../shared/handsFree'
import type { VoiceInteractionSettings } from '../../../shared/handsFree'
import { desktop } from '../../services/desktop'
import { PlaybackAmplitude } from '../../services/speech/playbackAmplitude'
import { handsFreeAudio } from '../../services/speech/handsFreeAudio'
import { useAthena } from '../../store/athenaStore'
import { setVoiceAmplitude } from '../../three/voiceAmplitude'
import { VoiceSegmentQueue, VoiceSentenceBuffer } from '../../../shared/voiceResponse'
import type { AIOwnership } from '../../../shared/aiOwnership'
import '../../styles/handsFree.css'

type Phase = HandsFreeState['state']
interface CaptureRuntime {
  vad?: MicVAD
  stream?: MediaStream
  processing: boolean
  requestId?: string
  noiseFloor: AdaptiveNoiseFloor
  lastThresholdUpdate: number
  source?: MicrophoneSource
  reconnectTimer?: ReturnType<typeof setTimeout>
  reconnecting?: boolean
  reconnectAttempts?: number
}

function releaseCapture(active: CaptureRuntime): void {
  if (active.requestId) void desktop.cancelHandsFreeTranscription({ id: active.requestId }).catch(() => {})
  if (active.vad) void active.vad.destroy().catch(() => {})
  active.stream?.getTracks().forEach((track) => track.stop())
  clearTimeout(active.reconnectTimer)
  active.source?.close()
}

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
  const activeMeterAt = useRef(0)
  const cloudPeer = useRef<LivePeer | undefined>(undefined)
  useEffect(()=>desktop.onVoiceAutomationStopped?.(()=>cloudPeer.current?.stopAutomation()),[])
  useEffect(()=>desktop.onVoiceSubmissionEnded?.((id,complete)=>cloudPeer.current?.submittedTaskEnded(id,complete)),[])
  const runtime = useRef<CaptureRuntime | undefined>(undefined)
  const leaseActive = useRef(false)
  const ownership = useRef<AIOwnership | undefined>(undefined)
  const [localSessionId, setLocalSessionId] = useState<string | undefined>()
  useEffect(() => {
    let live = true, observed = false
    const off = desktop.onChat(snapshot => {
      if (!live) return
      observed = true
      setLocalSessionId(snapshot.sessionId)
      const progress=snapshot.automationProgress
      if(progress?.cancelTarget==='voice' && progress.phase==='running' && progress.engine)
        cloudPeer.current?.automationProgress(progress.id,progress.engine)
    })
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
  const lastSpoken = useRef({ text: '', until: 0 })
  const overlappedPlayback = useRef(false)
  const audio = useRef<HTMLAudioElement | undefined>(undefined)
  const meter = useRef<PlaybackAmplitude | undefined>(undefined)
  meter.current ??= new PlaybackAmplitude(setVoiceAmplitude)
  useEffect(() => () => { meter.current?.dispose(); meter.current = undefined }, [])
  const releaseRoute = useRef<(() => void) | undefined>(undefined)
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
    followUpActive.current = false
    clearTimeout(followUpTimer.current); followUpTimer.current = undefined
    void desktop.clearHandsFreeContext()
    setStatus('standby')
  }

  const cleanupPlayback = () => {
    releaseRoute.current?.(); releaseRoute.current = undefined
    if (audio.current) lastSpoken.current.until = Date.now() + 1800
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
    cloudPeer.current?.close('Voice playback stopped.')
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
            lastSpoken.current.until = Date.now() + 1800
            segmentFinished.current = undefined
            cleanupPlayback()
            resolve(true)
          }
          player.onerror = () => {
            if (activeReplyId.current !== id) return
            activeReplyId.current = undefined
            cleanupPlayback()
            setNotice('Athena’s voice could not play. Check the selected output in Voice Settings.')
          }
          player.onplaying = () => {
            if (activeReplyId.current !== id) return
            lastSpoken.current = { text: output, until: Number.POSITIVE_INFINITY }
            meter.current?.start(player)
            diagnostics.current.firstAudioMs ??= Math.round(performance.now() - firstAudioStartedAt)
            if (speechEndedAt.current !== undefined) diagnostics.current.speechEndToAudioMs ??= Math.round(performance.now() - speechEndedAt.current)
            if (!diagnostics.current.traceEvents?.some((entry) => entry.stage === 'first-audible-playback')) trace('first-audible-playback', undefined, `elapsedFromSpeechEndMs=${diagnostics.current.speechEndToAudioMs ?? 0}`)
          }
        })
        try {
          const playbackStarted = performance.now()
          const release = await routeSpeech(player, message => { void stopPlayback(); setNotice(message) }, meter.current)
          if (activeReplyId.current !== id || turnId.current !== turn || disposed.current) { release(); return false }
          releaseRoute.current = release
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
        } catch (error) {
          if (activeReplyId.current === id) { activeReplyId.current = undefined; cleanupPlayback() }
          setNotice(error instanceof Error ? error.message : 'Athena’s voice could not play. Check Voice Settings.')
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

  // All action planning runs in the main-process registry. The floating renderer
  // owns audio and interruption only, never session mutations or message submission.
  const routeCommand = async (rawText: string): Promise<string | null | undefined> => {
    const interrupt = isVoiceInterruption(rawText)
    if (interrupt === 'stop-speech') { await stopPlayback(); return undefined }
    if (interrupt === 'cancel-task') {
      await desktop.cancelHandsFreeReply()
      await stopPlayback()
      return null // Also route the explicit stop to the selected conversation.
    }
    if (interrupt === 'standby') {
      followUpActive.current = false; clearTimeout(followUpTimer.current)
      await stopPlayback(); await desktop.clearHandsFreeContext(); setStatus('standby'); return undefined
    }
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
    const current = settingsRef.current
    if (route.kind === 'wake-only' || route.includedWakePhrase) {
      if (current?.liveVoice.engine === 'live') {
        const config=current.liveVoice
        const stream=runtime.current?.stream
        const allowed=config.cloudAllowed && !current.strictOffline && current.voiceEnabled && !current.voiceMuted && !current.doNotDisturb && interaction.autoVoiceResponse
        if (allowed && stream && !cloudPeer.current) {
          const owner=ownership.current
          const connect=async(recovering=false)=>{
            const peer:LivePeer=new LivePeer({mode:'floating',stream,settings:config,initial:recovering || route.kind==='wake-only'?undefined:route.text,
              volume:current.voiceVolume,amplitude:setVoiceAmplitude,
              state:(state,message)=>{
                if (cloudPeer.current!==peer || disposed.current)return
                const talking=state==='speaking'
                void reportPlayback(talking)
                setStatus(talking?'speaking':state==='listening'?'listening':'processing',message ?? (state==='working'?'Working on your request…':state==='connecting'?'Connecting to GPT-Live…':talking&&config.fullDuplex?'Speaking and listening':'GPT-Live connected'))
              },
              pauseWork:paused=>owner?desktop.steerVoiceAutomation({paused,ownership:owner}):Promise.resolve(false),
              cancelWork:async()=>{await desktop.cancelHandsFreeReply()},
              delegate:async (text,id)=>{
                if(!owner || cloudPeer.current!==peer || disposed.current) return 'The voice session has ended.'
                const result=await desktop.answerHandsFree({id,text,ownership:owner,liveRequest:peer.request})
                return (result.ok?result.text:result.message) || 'The task result is unavailable.'
              },
              ended:reason=>{
                if(cloudPeer.current!==peer)return
                cloudPeer.current=undefined;void reportPlayback(false)
                if(!disposed.current){
                  if(!recovering && /WebRTC connection failed|connection was interrupted/i.test(reason) && runtime.current?.stream===stream && ownership.current===owner && settingsRef.current?.liveVoice.cloudAllowed && !settingsRef.current.strictOffline){
                    void connect(true).catch(()=>setStatus('standby','Connection recovery failed. Wake Athena to try again.'))
                    return
                  }
                  followUpActive.current=false;setStatus('standby',reason)
                  if(config.fallback && /failed|interrupted|could not|budget|unable/i.test(reason)){
                    followUpActive.current=true;setStatus('follow-up','Using your local voice.');armFollowUpExpiry()
                  }
                }
              },
            })
            cloudPeer.current=peer
            try {await peer.start()}catch(e){if(cloudPeer.current===peer)cloudPeer.current=undefined;throw e}
          }
          try {await connect();return}
          catch(error){
            if(disposed.current || turnId.current!==turn)return
            if(!config.fallback){endVoiceConversation();setStatus('error',error instanceof Error?error.message:'GPT-Live is unavailable.');return}
            setStatus('listening','Using your local voice.')
          }
        } else if(!config.fallback) {
          endVoiceConversation();setStatus('error','Enable cloud voice and audio output in Voice Settings to use GPT-Live.');return
        }
      }
    }
    if (route.kind === 'wake-only') {
      const acknowledgement = chooseWakeAcknowledgement(previousWakeAcknowledgement.current)
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
      followUpActive.current = false
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
    let retryOnDevice: (() => void) | undefined
    let retryDeviceChange: (() => void) | undefined
    let startupRetryTimer: ReturnType<typeof setTimeout> | undefined
    const clearStartupRetry = () => {
      retryOnDevice?.(); retryOnDevice = undefined
      if (retryDeviceChange) navigator.mediaDevices?.removeEventListener('devicechange', retryDeviceChange)
      retryDeviceChange = undefined; clearTimeout(startupRetryTimer)
    }
    const failCapture = (active: CaptureRuntime, message: string) => {
      if (runtime.current !== active) return
      runtime.current = undefined
      releaseCapture(active)
      releaseVoiceLease(effectOwner)
      setStatus('error', message)
    }
    const boot = async () => {
      clearStartupRetry()
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
        const reconnect = () => {
          clearTimeout(active.reconnectTimer)
          active.reconnectTimer = setTimeout(async () => {
            if (cancelled || runtime.current !== active || !active.source?.needsReconnect()) return
            if (active.processing || active.reconnecting || !active.vad) { reconnect(); return }
            active.reconnecting = true
            try {
              await active.vad.pause()
              await active.vad.start()
              if (active.stream) await cloudPeer.current?.replaceMicrophone(active.stream)
              active.reconnectAttempts = 0
              setNotice(currentAudioDevices().input.message ?? '')
              if (!activeReplyId.current && !cloudPeer.current) setStatus(followUpActive.current ? 'follow-up' : 'standby')
            } catch {
              await active.vad.pause().catch(() => {})
              active.reconnectAttempts = (active.reconnectAttempts ?? 0) + 1
              setStatus('error', 'Microphone unavailable. Reconnect it or choose an input in Voice Settings; listening will recover when a device is available.')
              if (active.reconnectAttempts < 3) reconnect()
            } finally { active.reconnecting = false }
          }, 500 * Math.max(1, active.reconnectAttempts ?? 1))
        }
        active.source = new MicrophoneSource(() => microphoneConstraints(interactionRef.current ?? interaction).audio as MediaTrackConstraints, () => { active.reconnectAttempts = 0; reconnect() })
        const createStream = async () => {
          const stream = await active.source!.getStream()
          if (cancelled || runtime.current !== active) { active.source?.close(); throw new Error('Capture cancelled.') }
          active.stream = stream
          return stream
        }
        const onSpeechEnd = async (samples: Float32Array) => {
          cloudPeer.current?.resumeListening()
          if (cloudPeer.current || runtime.current !== active || active.processing || cancelled) { samples.fill(0); return }
          if (overlappedPlayback.current && !interactionRef.current?.allowSpeechInterruption) { samples.fill(0); return }
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
            if (overlappedPlayback.current && isPlaybackEcho(result.transcript!, lastSpoken.current.text)) {
              setStatus(followUpActive.current ? 'follow-up' : 'standby')
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
          resumeStream: async () => createStream(),
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
            if (cloudPeer.current && probabilities.isSpeech>=0.7)cloudPeer.current.activity()
            const floor = active.noiseFloor.observe(frameRms(frame), probabilities.isSpeech, current.automaticNoiseCalibration)
            const now = Date.now()
            if (currentAudioDevices().testActive && now - (activeMeterAt.current ?? 0) > 100) {
              activeMeterAt.current = now
              void desktop.audioDevices({ action: 'level', level: Math.min(1, frameRms(frame) * 5) }).catch(() => {})
            }
            if (now - active.lastThresholdUpdate >= 500) {
              const thresholds = speechThresholds(current, floor)
              active.vad?.setOptions({ ...thresholds, redemptionMs: silenceEndpointMs(current.endOfSpeechDelayMs, speechStartedAt.current === undefined ? 0 : performance.now() - speechStartedAt.current) })
              active.lastThresholdUpdate = now
            }
          },
          onSpeechRealStart: () => {
            if (runtime.current !== active || cancelled) return
            if(cloudPeer.current){if(interactionRef.current?.allowSpeechInterruption)cloudPeer.current.interruptSpeech();else cloudPeer.current.activity();return}
            overlappedPlayback.current = Boolean(audio.current && !audio.current.paused) || Date.now() < lastSpoken.current.until
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
          onVADMisfire: () => {cloudPeer.current?.resumeListening()},
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
        if (['NotFoundError', 'NotReadableError', 'AbortError', 'OverconstrainedError'].includes(errorName)) {
          const previousInput = currentAudioDevices().input.deviceId
          const retry = () => {
            clearTimeout(startupRetryTimer)
            startupRetryTimer = setTimeout(() => { if (!cancelled) void boot() }, 500)
          }
          retryOnDevice = onAudioDevices(next => { if (next.input.deviceId && next.input.deviceId !== previousInput) retry() })
          // With no active capture lease, Chromium can redact input IDs. A real
          // OS device-change event still permits one fresh authorized attempt.
          retryDeviceChange = retry
          navigator.mediaDevices.addEventListener('devicechange', retryDeviceChange)
        }
      }
    }
    void boot()
    return () => {
      cancelled = true
      cloudPeer.current?.close('Voice owner changed.');cloudPeer.current=undefined
      clearStartupRetry()
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

  useEffect(()=>{
    if(settings?.liveVoice.engine!=='live' || !settings.liveVoice.cloudAllowed || settings.strictOffline || settings.voiceMuted || !settings.voiceEnabled || settings.doNotDisturb || !interaction?.autoVoiceResponse)cloudPeer.current?.close('Cloud voice stopped.')
    else cloudPeer.current?.setVolume(settings.voiceVolume)
  },[settings?.liveVoice.engine,settings?.liveVoice.cloudAllowed,settings?.strictOffline,settings?.voiceMuted,settings?.voiceEnabled,settings?.doNotDisturb,settings?.voiceVolume,interaction?.autoVoiceResponse])

  if (!interaction?.handsFreeEnabled) return null
  const labels: Record<Phase, string> = { standby: 'Listening for Athena', listening: 'Listening', processing: 'Processing', speaking: 'Speaking', 'follow-up': 'Ready for follow-up', paused: 'Paused', error: notice || 'Microphone unavailable' }
  return <div className={`hands-free-status hands-free-${phase}`} role="status" aria-label={notice || labels[phase]}>
    <span className="hands-free-status-dot" aria-hidden="true" />
    {import.meta.env.DEV && <button type="button" className="hands-free-diagnostic" aria-pressed={diagnosticDirectMode} title="Switching modes clears temporary voice history so both runs start with the same short prompt. Whisper and spoken playback stay enabled." disabled={phase === 'processing' || phase === 'speaking'} onClick={() => void toggleDiagnosticMode()}>{diagnosticDirectMode ? 'Direct test · ON' : 'Direct test · OFF'}</button>}
    <button type="button" aria-label="Stop hands-free listening" title="Stop listening" onClick={() => void desktop.updateSettings({ voiceInteraction: { ...interaction, handsFreeEnabled: false } })}><MicOff size={12} /></button>
  </div>
}
