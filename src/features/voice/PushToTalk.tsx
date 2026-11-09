import { useEffect, useId, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'
import { desktop } from '../../services/desktop'
import { useAthena } from '../../store/athenaStore'
import { VoiceCapture } from '../../services/speech/voiceCapture'
import type { VoicePhase } from '../../../shared/voice'
import '../../styles/voice.css'

export function PushToTalk({ sessionId, disabled, onTranscript, onActive, toggle = false }: {
  sessionId?: string; disabled: boolean; onTranscript(text: string, sessionId: string): void; onActive(active: boolean): void; toggle?: boolean
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle'), [notice, setNotice] = useState('')
  const [level, setLevel] = useState(0)
  const capture = useRef<VoiceCapture | null>(null)
  const instructionId = useId()
  const configuredAutoSend = useAthena((state) => state.snapshot?.settings.voiceAutoSend ?? false)
  const localMode = useAthena((state) => state.snapshot?.settings.aiMode === 'local')
  const autoSend = configuredAutoSend
  const current = useRef({ sessionId, disabled, onTranscript, onActive })
  current.current = { sessionId, disabled, onTranscript, onActive }
  useEffect(() => {
    const recorder = new VoiceCapture(desktop, {
      state: (state, message) => {
        setPhase(state); setNotice(message ?? ''); current.current.onActive(state !== 'idle')
        if (state !== 'listening') setLevel(0)
      },
      level: setLevel,
      transcript: (text, id) => { if (current.current.sessionId === id) current.current.onTranscript(text, id) },
    })
    capture.current = recorder
    const unsubscribe = desktop.onVoice((state) => { if (state.id === recorder.id && state.phase === 'idle' && state.message) recorder.cancel(state.message) })
    const cancel = () => recorder.cancel()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && recorder.phase !== 'idle') { event.preventDefault(); cancel() }
    }
    window.addEventListener('keydown', keydown)
    const offline = () => { if (useAthena.getState().snapshot?.settings.aiMode !== 'local') cancel() }
    window.addEventListener('pagehide', cancel); window.addEventListener('offline', offline)
    return () => {
      unsubscribe(); recorder.cancel(); capture.current = null
      window.removeEventListener('keydown', keydown); window.removeEventListener('pagehide', cancel); window.removeEventListener('offline', offline)
    }
  }, [])
  useEffect(() => { capture.current?.cancel() }, [sessionId])
  useEffect(() => { if (disabled) capture.current?.cancel() }, [disabled])
  const begin = () => { if (!disabled && sessionId) void capture.current?.begin(sessionId) }
  const active = phase !== 'idle'
  const bars = Array.from({ length: 24 }, (_, index) => 0.55 + ((index * 17) % 11) / 20)
  return <div className={`voice-input ${active ? 'is-active' : ''}`}>
    <button type="button" className={`chat-action voice-button ${active ? 'voice-active' : ''} ${autoSend ? 'voice-auto-send' : ''}`} disabled={disabled || phase === 'transcribing'}
      aria-label={phase === 'listening' ? 'Finish voice message' : 'Start voice message'} aria-pressed={phase === 'listening'} aria-describedby={instructionId} aria-keyshortcuts={toggle ? undefined : 'Control+Shift+A Meta+Shift+A'}
      title={`${toggle ? 'Click to start or finish' : 'Hold to talk · release to transcribe'}${autoSend ? ' and send' : ''} · Escape cancels`}
      onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); if (toggle) { if (capture.current?.phase === 'listening') capture.current.finish(); else begin() } else { event.currentTarget.setPointerCapture(event.pointerId); begin() } }}
      onPointerUp={() => { if (!toggle) capture.current?.finish() }} onPointerCancel={() => capture.current?.cancel()}
      onLostPointerCapture={() => { if (!toggle && capture.current?.phase === 'listening') capture.current.cancel() }}
      onKeyDown={(event) => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!event.repeat) { if (toggle && capture.current?.phase === 'listening') capture.current.finish(); else begin() } } }}
      onKeyUp={(event) => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!toggle) capture.current?.finish() } }}
    ><Mic size={17} />{autoSend && !active && <span className="voice-auto-send-indicator" aria-hidden="true" />}</button>
    {active && <button type="button" className="chat-action" aria-label="Cancel voice input" onClick={() => capture.current?.cancel()}><X size={15} /></button>}
    {phase === 'listening' && <div className="voice-wave" role="img" aria-label="Live microphone waveform" style={{ '--voice-level': level } as React.CSSProperties}>{bars.map((factor, index) => <span key={index} style={{ '--voice-height': `${Math.max(4, 4 + level * factor * 22)}px` } as React.CSSProperties} />)}</div>}
    <span id={instructionId} className="voice-sr-only">{toggle ? 'Click to start recording, then click again to transcribe.' : 'Hold to record, then release to transcribe.'} Recording lasts up to 60 seconds. {autoSend ? 'The transcript sends automatically if the composer is empty and has no attachments. Tool approvals still apply.' : 'Review the transcript before sending your message.'}</span>
    {(active || notice) && <div className="voice-notice" role="status">
      <span>{phase === 'preparing' ? 'Preparing microphone…' : phase === 'listening' ? `Microphone on · ${toggle ? 'click again' : 'release'} to transcribe (60s max)` : phase === 'transcribing' ? (localMode ? 'Transcribing locally…' : 'Transcribing with OpenAI…') : notice}</span>
      {!active && <><button type="button" className="chat-action" onClick={() => useAthena.getState().setPage('privacy')}>Privacy</button><button type="button" className="chat-action" aria-label="Dismiss voice notice" onClick={() => setNotice('')}><X size={13} /></button></>}
    </div>}
  </div>
}
