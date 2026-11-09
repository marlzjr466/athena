import { useEffect } from 'react'
import { ArrowUpRight, EyeOff, Maximize2, MessageCircle, Monitor, Pin, Power, Settings2, Unplug, Volume2, VolumeX, X } from 'lucide-react'
import { Logo } from '../../components/shared/Logo'
import { useAthena } from '../../store/athenaStore'
import { FloatingConversation } from './FloatingConversation'
import { connectChat, useChat } from '../../store/chatStore'
import { desktop } from '../../services/desktop'
import type { DesktopCommand } from '../../../shared/contracts'
import { avatarName } from '../../../shared/avatarModels'
import { useSpeechOutput } from '../voice/useSpeechOutput'

export function MiniPanel() {
  const { snapshot, command, update } = useAthena()
  const conversation = useChat((state) => state.snapshot)
  useSpeechOutput(conversation, snapshot?.settings)
  useEffect(connectChat, [])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') void command('close-panel') }
    let timer: ReturnType<typeof setTimeout>
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => {
      if (useChat.getState().snapshot.phase === 'idle' && !['listening', 'thinking', 'speaking', 'working'].includes(useAthena.getState().snapshot?.state ?? 'idle')) void command('close-panel')
    }, 60_000) }
    window.addEventListener('keydown', close)
    window.addEventListener('pointermove', reset)
    window.addEventListener('keydown', reset)
    const visible = () => { if (!document.hidden) reset() }
    document.addEventListener('visibilitychange', visible)
    reset()
    return () => { clearTimeout(timer); window.removeEventListener('keydown', close); window.removeEventListener('pointermove', reset); window.removeEventListener('keydown', reset); document.removeEventListener('visibilitychange', visible) }
  }, [command])
  if (!snapshot) return null
  const name = avatarName(snapshot.settings.avatarVariant, snapshot.importedAvatars)
  const action = (cmd: DesktopCommand) => { void command(cmd); if (cmd !== 'open-panel' && cmd !== 'open-chat') void command('close-panel') }
  const lastReply = conversation.messages.at(-1)
  return <div className="mini-panel"><header><div><Logo small /><span>ATHENA</span><span className="status-dot" /></div><button className="icon-button" aria-label="Close panel" onClick={() => void command('close-panel')}><X size={16} /></button></header>
    {snapshot.panelMode === 'chat' ? <><FloatingConversation /><button className="mini-open" onClick={() => action('open-chat')}>Local conversation <ArrowUpRight size={13} /></button></> : <nav className="context-menu" aria-label={`${name} controls`}>
      <button onClick={() => action('open-panel')}><MessageCircle size={15} /> Ask Athena <span>↵</span></button><button onClick={() => action('open-chat')}><Maximize2 size={15} /> Local conversation</button>
      <button disabled={lastReply?.role !== 'assistant' || !conversation.sessionId} onClick={() => { if (conversation.sessionId && lastReply?.role === 'assistant') void desktop.stopSpeech({ sessionId: conversation.sessionId, messageId: lastReply.id }) }}><VolumeX size={15} /> Stop speaking</button>
      <button disabled={conversation.phase === 'idle'} onClick={() => void desktop.stopChat()}><X size={15} /> Stop task</button>
      <button onClick={() => void update({ voiceMuted: !snapshot.settings.voiceMuted })}>{snapshot.settings.voiceMuted ? <Volume2 size={15} /> : <VolumeX size={15} />}{snapshot.settings.voiceMuted ? 'Unmute Athena' : 'Mute Athena'}</button><hr />
      <button onClick={() => action(snapshot.settings.pinned ? 'unpin' : 'pin')}>{snapshot.settings.pinned ? <Unplug size={15} /> : <Pin size={15} />}{snapshot.settings.pinned ? `Unpin ${name}` : 'Stay here'}</button>
      <button disabled={snapshot.displays.length < 2} onClick={() => action('next-monitor')}><Monitor size={15} /> Move to another monitor</button><hr />
      <div className="context-sizes">{[{ name: 'Small', size: 120 }, { name: 'Medium', size: 180 }, { name: 'Large', size: 280 }].map(({ name, size }) => <button key={name} onClick={() => void update({ size })} className={snapshot.settings.size === size ? 'selected' : ''}>{name}</button>)}</div><hr />
      <button onClick={() => action('open-settings')}><Settings2 size={15} /> Settings</button><button onClick={() => action('hide')}><EyeOff size={15} /> Hide {name}</button><button onClick={() => action('quit')}><Power size={15} /> Quit Athena</button>
    </nav>}
  </div>
}
