import { ApprovalActions } from '../../components/ApprovalActions'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Circle, FolderOpen, LoaderCircle, Square, VolumeX, X } from 'lucide-react'
import { elapsedLabel } from '../../../shared/agent'
import { MAX_MESSAGE_LENGTH } from '../../../shared/chat'
import { isChatGPTUsageLimitMessage } from '../../../shared/chatgpt'
import { useChat } from '../../store/chatStore'
import { useAthena } from '../../store/athenaStore'
import { desktop } from '../../services/desktop'
import '../../styles/floatingConversation.css'
import '../../styles/automationProgress.css'

export function FloatingConversation() {
  const { snapshot, send, stop, command, pending, issue } = useChat()
  const settings = useAthena((state) => state.snapshot?.settings)
  const characterState = useAthena((state) => state.snapshot?.state)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState(''), [now, setNow] = useState(Date.now())
  const draftRef = useRef(''), sessionRef = useRef(snapshot.sessionId)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const editing = useRef(false)
  useEffect(() => {
    clearTimeout(timer.current)
    sessionRef.current = snapshot.sessionId
    editing.current = false
    draftRef.current = snapshot.draft ?? ''
    setDraft(draftRef.current)
  }, [snapshot.sessionId])
  useEffect(() => {
    if (editing.current) return
    draftRef.current = snapshot.draft ?? ''
    setDraft(draftRef.current)
  }, [snapshot.draft])
  useEffect(() => () => {
    clearTimeout(timer.current)
    const id = sessionRef.current
    if (editing.current && id) void desktop.chatSession({ action: 'draft', id, text: draftRef.current }).catch(() => {})
  }, [])
  const changeDraft = (text: string) => {
    draftRef.current = text; editing.current = true; setDraft(text)
    clearTimeout(timer.current)
    const id = sessionRef.current
    if (id) timer.current = setTimeout(() => {
      void desktop.chatSession({ action: 'draft', id, text }).then((result) => {
        if (result.ok && id === sessionRef.current && text === draftRef.current) editing.current = false
      }).catch(() => setNotice('Could not save the transcript.'))
    }, 250)
  }
  const sendDraft = async (text = draftRef.current) => {
    if (!text.trim() || snapshot.phase !== 'idle' || pending || !snapshot.sessionId) return
    clearTimeout(timer.current)
    editing.current = true
    const id = snapshot.sessionId
    const saved = await desktop.chatSession({ action: 'draft', id, text })
    if (!saved.ok || id !== useChat.getState().snapshot.sessionId) { setNotice(saved.message ?? 'Conversation changed. Review the transcript.'); return }
    const accepted = await send(text)
    if (accepted && id === sessionRef.current && draftRef.current === text) {
      draftRef.current = ''; editing.current = false; setDraft('')
    } else if (!accepted) setNotice('The message was not sent. Your transcript is still here.')
  }
  const last = snapshot.messages.at(-1)
  const execution = last?.role === 'assistant' ? last.execution : undefined
  const activity = execution?.activities.at(-1)
  const approval = execution?.approval
  const working = execution?.status === 'working' && !execution.finishedAt
  useEffect(() => {
    if (!working) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [working, execution?.startedAt])
  const openProject = async () => {
    if (!snapshot.sessionId) return
    const result = await desktop.chatContext({ action: 'connect', sessionId: snapshot.sessionId })
    if (!result.ok) setNotice(result.message ?? 'Could not connect that folder.')
  }
  const stopSpeaking = () => {
    const message = snapshot.messages.at(-1)
    if (snapshot.sessionId && message?.role === 'assistant') void desktop.stopSpeech({ sessionId: snapshot.sessionId, messageId: message.id })
  }
  return <div className="floating-conversation" aria-label="Floating Athena conversation">
    <div className="floating-conversation-top">
      <span>{characterState === 'listening' ? 'Listening…' : characterState === 'speaking' ? 'Speaking…' : snapshot.phase !== 'idle' ? 'Working…' : 'Ready to help'}</span>
      {settings?.showFloatingProject && <span className="floating-project">{snapshot.workspaces?.[0]?.name ?? 'No project'}</span>}
    </div>
    {settings?.showFloatingBubble && last?.content && <div className="floating-conversation-reply" aria-live="polite"><span>{last.role === 'user' ? 'You' : 'Athena'}</span><p>{last.content.slice(-360)}{last.content.length > 360 ? '…' : ''}</p></div>}
    {settings?.showFloatingTaskStatus && execution && <div className="floating-conversation-activity" role="status">
      <span>{elapsedLabel(execution.startedAt, execution.finishedAt ?? now, Boolean(working))}</span>
      {activity && <span>{activity.label} · {activity.status}</span>}
    </div>}
    {snapshot.automationProgress && <section className="automation-progress" role="status" aria-label="Athena automation progress">
      <header><strong>{snapshot.automationProgress.phase === 'running' ? 'Working on your request' : snapshot.automationProgress.phase === 'complete' ? 'Request complete' : 'Request stopped'}</strong>{snapshot.automationProgress.phase === 'running' && snapshot.automationProgress.cancelTarget === 'voice' && <button type="button" aria-label="Cancel automation" onClick={() => void desktop.cancelHandsFreeReply()}><X size={13} /></button>}</header>
      <p>{snapshot.automationProgress.task}</p>
      <ol>{snapshot.automationProgress.steps.map(step => <li key={step.id} className={`automation-step ${step.status}`}>
        {step.status === 'complete' ? <Check size={12} /> : step.status === 'running' ? <LoaderCircle size={12} className="automation-spinner" /> : step.status === 'failed' || step.status === 'cancelled' ? <X size={12} /> : <Circle size={10} />}
        <span>{step.label}{step.message ? ` · ${step.message}` : ''}</span>
      </li>)}</ol>
    </section>}
    {approval && snapshot.sessionId && <div className="floating-conversation-approval" role="group" aria-label="Approval required">
      <strong>{approval.title}</strong><p>{approval.description}</p>
      <ApprovalActions approval={approval} pending={pending} decide={(allow, remember) => void command({ action: 'agent-approval', id: snapshot.sessionId!, approvalId: approval!.id, allow, remember })} />
    </div>}
    <form onSubmit={(event) => { event.preventDefault(); void sendDraft() }}>
      <textarea aria-label="Message Athena" placeholder="Ask Athena..." value={draft} maxLength={MAX_MESSAGE_LENGTH} rows={2} onChange={(event) => changeDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendDraft() } }} />
      <div className="floating-conversation-actions">
        <button type="button" title="Select an authorized project folder" aria-label="Connect project folder" disabled={snapshot.phase !== 'idle' || !snapshot.sessionId} onClick={() => void openProject()}><FolderOpen size={16} /></button>
        {characterState === 'speaking' || characterState === 'working' ? <button type="button" title="Stop speaking" aria-label="Stop speaking" onClick={stopSpeaking}><VolumeX size={16} /></button> : null}
        {snapshot.phase !== 'idle' ? <button type="button" title="Stop current task" aria-label="Stop current task" onClick={() => void stop()}><Square size={16} /></button>
          : <button type="submit" title="Send message" aria-label="Send message" disabled={!draft.trim() || pending}><ArrowUp size={16} /></button>}
      </div>
    </form>
    {(notice || issue || snapshot.error) && <div className="floating-conversation-error" role="alert"><span>{notice || issue || snapshot.error}</span>{isChatGPTUsageLimitMessage(notice || issue || snapshot.error || undefined) && <button type="button" onClick={() => void desktop.openChatGPTUsage()}>Manage usage</button>}</div>}
  </div>
}
