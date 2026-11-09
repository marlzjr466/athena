import { useState, type FormEvent } from 'react'
import { ArrowUp, Check, RotateCcw, Sparkles } from 'lucide-react'
import { parseLocalIntent } from '../../../shared/behavior'
import { SIZE } from '../../../shared/settings'
import { desktop } from '../../services/desktop'
import { useAthena } from '../../store/athenaStore'

export function LocalChat({ mini = false }: { mini?: boolean }) {
  const [input, setInput] = useState('')
  const [reply, setReply] = useState('A little company, a little calm. What can I do for you?')
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState(false)
  async function send(text: string) {
    if (!text.trim() || busy) return
    setBusy(true); setSuccess(false); setInput('')
    try {
      const intent = parseLocalIntent(text)
      const settings = useAthena.getState().snapshot!.settings
      if (intent === 'smaller' || intent === 'bigger') {
        const size = Math.max(SIZE.min, Math.min(SIZE.max, settings.size + (intent === 'smaller' ? -20 : 20)))
        await desktop.updateSettings({ size }); setReply(`A little adjustment. I’m now ${size} pixels tall.`); setSuccess(true)
      } else if (intent === 'help' || intent === 'unknown') {
        setReply(intent === 'unknown' ? 'For AI conversation, open the control center and choose Conversation. Here, try “stay here”, “resume floating”, “make yourself smaller”, or “open settings”.' : 'I can stay here, resume floating, change my size, hide, and open settings. Open Conversation in the control center for AI text chat.')
      } else {
        await desktop.command(intent)
        setReply({ pin: 'Right here. I’ll stay in this spot.', unpin: settings.randomMovement ? `Unpinned. I’ll wander again after ${settings.wanderIntervalSeconds} seconds once we finish here.` : 'Unpinned. Free to Wander is off; you can enable it in Floating settings.', hide: 'Taking a little break. Find me in the tray.', show: 'Here I am. Good to see you.', 'open-settings': 'Your preferences are open.' }[intent]); setSuccess(true)
      }
    } catch { setReply('I couldn’t complete that change. Please try again from the control center.') }
    finally { setBusy(false) }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void send(input) }
  return <div className={`local-chat ${mini ? 'mini' : ''}`}>
    {!mini && <div className="chat-welcome"><span className="chat-orb"><Sparkles size={28} /></span><h2>A little hello goes a long way.</h2><p>Try a local command to get to know your companion.</p></div>}
    <div className="chat-reply" aria-live="polite">{success && <Check size={15} />}<p>{reply}</p></div>
    <div className="chat-suggestions"><button disabled={busy} onClick={() => void send('stay here')}>Stay here</button><button disabled={busy} onClick={() => void send('make yourself smaller')}>A little smaller</button>{!mini && <button disabled={busy} onClick={() => void send('help')}>What can you do?</button>}</div>
    <form onSubmit={submit} className="chat-form"><input aria-label="Ask Athena" placeholder="Ask Athena..." value={input} maxLength={500} onChange={(event) => setInput(event.target.value)} /><button aria-label="Send message" disabled={busy || !input.trim()} type="submit"><ArrowUp size={18} /></button></form>
    <div className="chat-disclaimer"><span>Local controls · AI chat in control center</span><button aria-label="Clear conversation" onClick={() => { setReply('A fresh start. What can I do for you?'); setSuccess(false) }}><RotateCcw size={12} /></button></div>
  </div>
}
