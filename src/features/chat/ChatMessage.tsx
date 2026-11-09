import { Pencil, RotateCcw, SquarePen, Volume2, VolumeX } from 'lucide-react'
import { useState } from 'react'
import { stripTrailingSourcesSection, type ChatMessage as Message } from '../../../shared/chat'
import { CopyText, MessageMarkdown } from './MessageMarkdown'
import { AttachmentCards } from './AttachmentCards'
import { ArtifactCards } from './ArtifactCards'
import { AgentActivity, AgentDuration, AgentTimeline } from './AgentActivity'
import { ChatTooltip } from './ChatTooltip'
import { commandAtStart } from '../../../shared/slashCommands'
import { ChatChoices, parseChoicePrompt } from './ChatChoices'
import { clipboardHtmlToMarkdown } from './richPaste'

export function ChatMessage({ message, canRetry, retryDisabled, onRetry, onEdit, onAnswerChoice, choiceDisabled = false, onSpeak, onStopSpeaking, sessionId, speaking = false }: {
  message: Message
  canRetry: boolean
  retryDisabled: boolean
  onRetry(): void
  onEdit?(text: string): Promise<boolean>
  onAnswerChoice?(text: string): Promise<boolean>
  choiceDisabled?: boolean
  onSpeak?(): void
  onStopSpeaking?(): void
  sessionId?: string
  speaking?: boolean
}) {
  const assistant = message.role === 'assistant'
  const [editing, setEditing] = useState(false), [text, setText] = useState(message.content)
  const visibleContent = assistant ? stripTrailingSourcesSection(message.content) : message.content
  const timestamp = <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
  const parsedCommand = commandAtStart(message.content)
  const commandOffset = message.content.length - message.content.trimStart().length
  const recognizedCommand = !assistant && !!message.command && parsedCommand?.name === message.command.name
  const choicePrompt = assistant && message.status === 'complete' && onAnswerChoice ? parseChoicePrompt(visibleContent) : null
  return <div className={`chat-message-row ${message.role} ${speaking ? 'is-speaking' : ''}`}>{!assistant && !!message.attachments?.length && sessionId && <div className="chat-message-attachments"><AttachmentCards sessionId={sessionId} attachments={message.attachments} /></div>}<article className={`chat-message ${message.role}`} aria-label={assistant ? 'Athena message' : 'Your message'}>
    {editing ? <form className="chat-edit" onSubmit={(event) => { event.preventDefault(); void onEdit?.(text).then((ok) => { if (ok) setEditing(false) }) }}><textarea autoFocus aria-label="Edit message" value={text} maxLength={12_000} onChange={(event) => setText(event.target.value)} onPaste={(event) => {
      const html = event.clipboardData.getData('text/html')
      const formatted = clipboardHtmlToMarkdown(html)
      if (!formatted) return
      event.preventDefault()
      const target = event.currentTarget
      const replacement = `${text.slice(0, target.selectionStart)}${formatted}${text.slice(target.selectionEnd)}`
      if (replacement.length > 12_000) return
      const caret = target.selectionStart + formatted.length
      setText(replacement)
      requestAnimationFrame(() => target.setSelectionRange(caret, caret))
    }} /><p className="chat-message-note">Resending replaces all later messages in this conversation.</p><button type="button" className="chat-action" onClick={() => setEditing(false)}>Cancel</button><button className="chat-action" disabled={retryDisabled || !text.trim()}>Save & resend</button></form> : assistant && message.execution && (message.execution.timeline?.length || message.execution.activities.length) ? <AgentTimeline execution={message.execution} executionId={message.id} sessionId={sessionId} fallbackText={visibleContent} /> : <div className="chat-message-content">{assistant ? <MessageMarkdown content={visibleContent} /> : recognizedCommand ? <p className="chat-user-text">{message.content.slice(0, commandOffset)}<span className="chat-sent-command" title={message.command!.source}><SquarePen size={16} strokeWidth={1.8} aria-hidden="true" />{message.command!.name}</span>{message.content.slice(commandOffset + message.command!.name.length)}</p> : <MessageMarkdown content={message.content} stripSources={false} />}</div>}
    {choicePrompt && <ChatChoices prompt={choicePrompt} disabled={choiceDisabled} onAnswer={onAnswerChoice!} />}
    {assistant && !!message.attachments?.length && sessionId && <AttachmentCards sessionId={sessionId} attachments={message.attachments} />}
    {assistant && !!message.artifacts?.length && sessionId && <ArtifactCards sessionId={sessionId} artifacts={message.artifacts} />}
    {assistant && message.execution && <AgentActivity execution={message.execution} executionId={message.id} sessionId={sessionId} />}
    {!!message.sources?.length && <details className="chat-sources"><summary>Source Evidence · {new Set(message.sources.map((source) => `${source.workspace}/${source.path}`)).size} files</summary>{message.sources.map((source) => <div key={`${source.workspace}/${source.path}:${source.start}:${source.end}`}><code>{source.workspace}/{source.path}:{source.start}–{source.end}</code></div>)}</details>}
    {assistant && message.error && <p className="chat-error" role="alert">{message.error}</p>}
    {assistant && message.execution && <AgentDuration execution={message.execution} />}
    {message.status === 'streaming' && !message.content && <div className="chat-thinking" aria-label="Preparing response"><span /><span /><span /></div>}
    {message.status === 'stopped' && <p className="chat-message-note">Stopped · partial response</p>}
    {assistant && message.status !== 'streaming' && <footer>
      {visibleContent && <CopyText text={visibleContent} compact />}
      {message.content && message.status === 'complete' && onSpeak && <ChatTooltip label={speaking ? 'Stop speaking' : 'Speak response'}><button type="button" className="chat-action chat-icon-action" aria-label={speaking ? 'Stop speaking' : 'Speak response'} onClick={speaking ? onStopSpeaking : onSpeak}>{speaking ? <VolumeX size={16} strokeWidth={1.8} /> : <Volume2 size={16} strokeWidth={1.8} />}</button></ChatTooltip>}
      {canRetry && <ChatTooltip label={message.status !== 'complete' && message.execution?.activities.length ? 'Continue unfinished task' : 'Regenerate response'}><button className="chat-action chat-icon-action" aria-label={message.status !== 'complete' && message.execution?.activities.length ? 'Continue unfinished task' : 'Retry response'} disabled={retryDisabled} onClick={onRetry}><RotateCcw size={16} strokeWidth={1.8} /></button></ChatTooltip>}
      <span className="chat-message-timestamp">{timestamp}</span>
    </footer>}
  </article>{!assistant && <div className="chat-user-actions" aria-label="Message actions">{!editing && <>{message.content && <CopyText text={message.content} compact />}{onEdit && <ChatTooltip label="Edit and resend"><button type="button" className="chat-action chat-icon-action" aria-label="Edit message" disabled={retryDisabled} onClick={() => { setText(message.content); setEditing(true) }}><Pencil size={16} strokeWidth={1.8} /></button></ChatTooltip>}</>}</div>}</div>
}
