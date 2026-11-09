import { useEffect, useRef, useState } from 'react'
import type { ChatSnapshot } from '../../../shared/chat'
import type { Settings } from '../../../shared/settings'
import type { SpeechStatus } from '../../../shared/speech'
import { nextStreamSpeechPart } from '../../../shared/speech'
import { desktop } from '../../services/desktop'
import { SpeechPlayer } from '../../services/speech/speechPlayer'

export function useSpeechOutput(chat: ChatSnapshot, settings?: Settings, enabled = true) {
  enabled = enabled && (chat.ownership ?? chat.messages.at(-1)?.ownership)?.origin === 'athena-local'
  const [status, setStatus] = useState<SpeechStatus>({ phase: 'idle' })
  const settingsRef = useRef(settings)
  const chatRef = useRef(chat)
  chatRef.current = chat
  settingsRef.current = settings
  const playerRef = useRef<SpeechPlayer | null>(null)
  const previousRef = useRef<{ sessionId?: string; phase: ChatSnapshot['phase']; revision: number; enabled: boolean; messageId?: string; status?: string } | null>(null)
  const startedRef = useRef<string | undefined>(undefined)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const announcementRef = useRef<string | undefined>(undefined)
  const pendingReplyRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    const player = new SpeechPlayer(desktop, setStatus, () => settingsRef.current?.voiceVolume ?? 0.8, () => settingsRef.current?.voiceSpeed ?? 1,
      (level) => { void desktop.reportSpeechLevel({ level }).catch(() => {}) })
    playerRef.current = player
    const unsubscribe = desktop.onSpeech((state) => {
      if (state.ownership?.origin !== 'athena-local' || state.ownership.sessionId !== chatRef.current.sessionId) return
      player.handleRemote(state)
      if (state.announcement && state.offered && state.sessionId && state.messageId && enabledRef.current) {
        announcementRef.current = state.messageId
        void player.start({ sessionId: state.sessionId, messageId: state.messageId })
      }
      if (state.announcement && state.phase === 'idle' && announcementRef.current === state.messageId) {
        announcementRef.current = undefined
        setStatus(state)
      }
    })
    return () => { unsubscribe(); player.dispose(); playerRef.current = null }
  }, [])
  useEffect(() => {
    const previous = previousRef.current
    const last = chat.messages.at(-1)
    previousRef.current = { sessionId: chat.sessionId, phase: chat.phase, revision: chat.revision, enabled, messageId: last?.id, status: last?.status }
    if (!previous) return
    if (previous.sessionId !== chat.sessionId) { startedRef.current = undefined; pendingReplyRef.current = undefined; playerRef.current?.stop(); return }
    if (last?.role === 'assistant' && (last.status === 'stopped' || last.status === 'error')) {
      if (startedRef.current === last.id) playerRef.current?.stop()
      if (pendingReplyRef.current === last.id) pendingReplyRef.current = undefined
      return
    }
    if (last?.role === 'assistant' && previous.revision !== chat.revision && (last.status === 'streaming' || last.status === 'complete')) pendingReplyRef.current = last.id
    if (enabled) playerRef.current?.onChatUpdate()
    if (!enabled || !settings?.voiceEnabled || !settings.localVoice.autoSpeak || settings.voiceMuted || settings.doNotDisturb) return
    if (announcementRef.current) return
    const actionTask = Boolean(last?.execution?.activities.some((activity) => !activity.tool.startsWith('voice_')))
    if (actionTask && (!settings.localVoice.completionAnnouncements || last?.status !== 'complete')) return
    if (last?.role === 'assistant' && (last.status === 'streaming' || (last.status === 'complete' && pendingReplyRef.current === last.id)) && last.content.trim() && chat.sessionId
      && startedRef.current !== last.id && nextStreamSpeechPart(last.content, 0, last.status === 'complete')) {
      startedRef.current = last.id
      void playerRef.current?.start({ sessionId: chat.sessionId, messageId: last.id })
    }
  }, [chat.revision, chat.sessionId, chat.phase, chat.messages, settings?.voiceEnabled, settings?.voiceMuted, settings?.doNotDisturb, settings?.localVoice.autoSpeak, settings?.localVoice.completionAnnouncements, enabled, status.phase, status.messageId])
  useEffect(() => { if (!enabled) { startedRef.current = undefined; playerRef.current?.stop() } }, [enabled])
  useEffect(() => { if (!settings?.voiceEnabled || settings.voiceMuted || settings.doNotDisturb) playerRef.current?.stop() }, [settings?.voiceEnabled, settings?.voiceMuted, settings?.doNotDisturb])
  useEffect(() => playerRef.current?.setVolume(), [settings?.voiceVolume])
  useEffect(() => playerRef.current?.setSpeed(), [settings?.voiceSpeed])
  useEffect(() => { playerRef.current?.stop() }, [settings?.localVoice.profileId, settings?.localVoice.engine])

  return { status, stopSpeaking: () => playerRef.current?.stop(), speakMessage: (sessionId: string, messageId: string) => enabledRef.current ? playerRef.current?.start({ sessionId, messageId, replay: true }) : undefined }
}
