import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Code2, FolderOpen, Lightbulb, PanelRight, Paperclip, RefreshCw, Sparkles, Square, VolumeX } from 'lucide-react'
import { connectChat, useChat } from '../../store/chatStore'
import { useAthena } from '../../store/athenaStore'
import { desktop, isDesktop } from '../../services/desktop'
import { MAX_MESSAGE_LENGTH } from '../../../shared/chat'
import { voiceControlIntent } from '../../../shared/voiceIntent'
import { emptyAIStatus } from '../../../shared/ai'
import { ChatMessage } from './ChatMessage'
import { clipboardHtmlToMarkdown } from './richPaste'
import { ConversationSidebar } from './ConversationSidebar'
import { ConversationControls } from './ConversationControls'
import { AttachmentCards } from './AttachmentCards'
import { WorkspacePanel } from './WorkspacePanel'
import { HeldPermissionPrompt } from '../../components/PermissionPrompt'
import { PushToTalk } from '../voice/PushToTalk'
import { useSpeechOutput } from '../voice/useSpeechOutput'
import { LONG_TEXT_PASTE_THRESHOLD, MAX_ATTACHMENT_BYTES, MAX_DRAFT_LENGTH, type Attachment, type ContextCommand } from '../../../shared/conversations'
import { inferPastedTextName } from '../../../shared/textAttachments'
import { BUILTIN_SLASH_COMMANDS, commandAtStart, filterSlashCommands, resolveSlashCommand, slashQuery, type SlashCommandCatalog, type SlashCommandDefinition } from '../../../shared/slashCommands'
import '../../styles/chat.css'
import '../../styles/conversations.css'

export function ChatView() {
  const { snapshot, pending, send, stop, retry, command } = useChat()
  const [input, setInput] = useState('')
  const [config, setConfig] = useState(emptyAIStatus)
  const [loading, setLoading] = useState(true)
  const [configurationError, setConfigurationError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [sidebar, setSidebar] = useState(true), [projectBrowser, setProjectBrowser] = useState(false)
  const [contextIssue, setContextIssue] = useState(''), [uploading, setUploading] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [voiceActive, setVoiceActive] = useState(false)
  const [slashCatalog, setSlashCatalog] = useState<SlashCommandCatalog>({ commands: BUILTIN_SLASH_COMMANDS, globalEnabled: false })
  const [slashOpen, setSlashOpen] = useState(false), [slashText, setSlashText] = useState(''), [slashIndex, setSlashIndex] = useState(0)
  const [selectedSlash, setSelectedSlash] = useState<SlashCommandDefinition | null>(null)
  const [slashNotice, setSlashNotice] = useState('')
  const settings = useAthena((state) => state.snapshot?.settings)
  const floatingVisible = useAthena((state) => state.snapshot?.visible ?? false)
  const { status: speechStatus, stopSpeaking, speakMessage } = useSpeechOutput(snapshot, settings, !floatingVisible)
  const transcript = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const [showLatest, setShowLatest] = useState(false)
  const follow = useRef(true)
  const autoScrolling = useRef(false)
  const autoScrollFrame = useRef<number | undefined>(undefined)
  const autoScrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const positionedSession = useRef<string | undefined>(undefined)
  const hasPositionedTranscript = useRef(false)
  const busy = snapshot.phase !== 'idle' || snapshot.sessions?.find(session => session.id === snapshot.sessionId)?.executionStatus === 'queued'
  const selectionRequired = settings?.aiMode === 'local' || settings?.aiMode === 'unconfigured'
  const model = snapshot.config?.model
  const configured = !selectionRequired && config.active && Boolean(config.provider === 'ChatGPT Subscription' ? config.model : model)
  const available = configured && online
  const sessionRef = useRef(snapshot.sessionId)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const unsavedDraft = useRef<{ id: string; text: string } | undefined>(undefined)
  const pasteGuard = useRef<{ fingerprint: string; at: number } | undefined>(undefined)
  const pendingCaret = useRef<{ start: number; end: number } | undefined>(undefined)
  const history = useRef<{ sessionId?: string; entries: Array<{ id: string; content: string }>; index: number | null; draft: string; start: number; end: number; pendingOlder: boolean }>({ entries: [], index: null, draft: '', start: 0, end: 0, pendingOlder: false })
  const slashRefreshId = useRef(0)
  const workspaceKey = snapshot.workspaces?.map((workspace) => `${workspace.id}:${workspace.authorized}`).join('|') ?? ''
  const suggestions = filterSlashCommands(slashCatalog.commands, slashText)
  const updateFollowFromPosition = () => {
    const element = transcript.current
    if (!element) return
    follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
    setShowLatest(!follow.current)
  }
  const cancelAutoScroll = () => {
    autoScrolling.current = false
    clearTimeout(autoScrollTimer.current)
    autoScrollTimer.current = undefined
  }
  const scrollToLatest = () => {
    const element = transcript.current
    if (!element) return
    follow.current = true
    setShowLatest(false)
    autoScrolling.current = true
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    clearTimeout(autoScrollTimer.current)
    // scrollend is used when available; this fallback also covers a no-op
    // scroll (already at the bottom) and older Chromium builds.
    autoScrollTimer.current = setTimeout(() => {
      cancelAutoScroll()
      updateFollowFromPosition()
    }, 1500)
  }
  const positionAtLatestImmediately = () => {
    const element = transcript.current
    if (!element) return
    cancelAutoScroll()
    follow.current = true
    setShowLatest(false)
    // Page/session entry should render at the newest message immediately.
    // Temporarily override any inherited smooth-scroll style as well.
    const previousBehavior = element.style.scrollBehavior
    element.style.scrollBehavior = 'auto'
    element.scrollTop = element.scrollHeight
    element.style.scrollBehavior = previousBehavior
  }
  const refreshSlash = async (action: 'list' | 'authorize-global' | 'revoke-global' = 'list') => {
    const id = snapshot.sessionId
    if (!id) return
    const request = ++slashRefreshId.current
    try {
      const result = await desktop.getSlashCommands({ action, sessionId: id })
      if (slashRefreshId.current === request && useChat.getState().snapshot.sessionId === id) { setSlashCatalog(result); setSlashNotice(result.message ?? '') }
    } catch { setSlashNotice('Could not load slash commands. Check project access and try Refresh.') }
  }
  useEffect(() => {
    if (unsavedDraft.current && unsavedDraft.current.id !== snapshot.sessionId) {
      clearTimeout(draftTimer.current)
      void desktop.chatSession({ action: 'draft', ...unsavedDraft.current }).catch(() => {})
      unsavedDraft.current = undefined
    }
    sessionRef.current = snapshot.sessionId
    history.current = { sessionId: snapshot.sessionId, entries: [], index: null, draft: '', start: 0, end: 0, pendingOlder: false }
    pendingCaret.current = undefined
    setInput(snapshot.draft ?? ''); setSelectedSlash(null); setSlashOpen(false); setSlashNotice(''); setContextIssue(''); setProjectBrowser(false); follow.current = true; setShowLatest(false)
  }, [snapshot.sessionId])
  useEffect(() => { setSelectedSlash(null); setSlashOpen(false); setSlashCatalog({ commands: BUILTIN_SLASH_COMMANDS, globalEnabled: false }); void refreshSlash() }, [snapshot.sessionId, workspaceKey])
  useEffect(() => {
    if (!unsavedDraft.current && (snapshot.draft ?? '') !== input) setInput(snapshot.draft ?? '')
  }, [snapshot.draft])
  const displayOffset = (raw: number, value: string, definition: SlashCommandDefinition | null) => {
    if (!definition) return raw
    const parsed = commandAtStart(value)
    if (!parsed) return raw
    const prefix = value.length - value.trimStart().length + parsed.name.length
    return Math.max(0, raw - prefix - (parsed.arguments ? 1 : 0))
  }
  useLayoutEffect(() => {
    const pending = pendingCaret.current, element = composer.current
    if (!pending || !element) return
    const start = Math.min(element.value.length, displayOffset(pending.start, input, selectedSlash))
    const end = Math.min(element.value.length, displayOffset(pending.end, input, selectedSlash))
    element.setSelectionRange(start, end)
    pendingCaret.current = undefined
  }, [input, selectedSlash])
  const changeInput = (value: string, caret?: { start: number; end: number }, persist = true) => {
    if (caret) pendingCaret.current = caret
    setInput(value)
    const resolution = resolveSlashCommand(value, slashCatalog.commands)
    const resolved = resolution?.status === 'resolved' ? resolution.matches[0] : null
    setSelectedSlash(resolved)
    if (resolution?.status === 'ambiguous') {
      setSlashText(resolution.parsed.name); setSlashIndex(0); setSlashOpen(true)
      setSlashNotice(`Choose which ${resolution.parsed.name} definition to use.`)
    } else {
      setSlashNotice('')
      const position = caret?.start ?? value.length
      const query = resolved ? null : slashQuery(value, position)
      setSlashOpen(query !== null)
      if (query !== null) { setSlashText(query); setSlashIndex(0); if (query === '/') void refreshSlash() }
    }
    clearTimeout(draftTimer.current)
    const id = snapshot.sessionId
    if (persist && id) {
      unsavedDraft.current = { id, text: value }
      draftTimer.current = setTimeout(() => {
        unsavedDraft.current = undefined
        void desktop.chatSession({ action: 'draft', id, text: value }).catch(() => setContextIssue('Could not save your draft.'))
      }, 250)
    }
  }
  useEffect(() => () => {
    clearTimeout(draftTimer.current)
    if (unsavedDraft.current) void desktop.chatSession({ action: 'draft', ...unsavedDraft.current }).catch(() => {})
  }, [])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void command({ action: 'create' }) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [command])
  const contextRequest = async (request: ContextCommand) => {
    setContextIssue(''); setUploading(true)
    try { const result = await desktop.chatContext(request); if (!result.ok) setContextIssue(result.message ?? 'Could not complete file request.'); return result.ok }
    catch { setContextIssue('Could not access the selected item. Try again.'); return false }
    finally { setUploading(false) }
  }
  const createPastedTextAttachment = async (text: string): Promise<boolean> => {
    const sessionId = snapshot.sessionId
    if (!sessionId) return false
    if (snapshot.attachments?.length && snapshot.attachments.length >= 8) { setContextIssue('Attach up to eight files per message.'); return false }
    if (!text.trim()) { setContextIssue('The pasted text is empty.'); return false }
    setContextIssue(''); setUploading(true)
    try {
      const name = inferPastedTextName(text, snapshot.attachments?.map((attachment) => attachment.name) ?? [])
      const result = await desktop.chatContext({ action: 'import-pasted', sessionId, name, text })
      if (!result.ok) { setContextIssue(result.message ?? 'Could not save the pasted text locally.'); return false }
      return true
    } catch (error) {
      setContextIssue(error instanceof Error ? error.message : 'Could not save the pasted text locally.')
      return false
    } finally { setUploading(false) }
  }
  const restoreTextAttachment = async (attachment: Attachment) => {
    const sessionId = snapshot.sessionId
    if (!sessionId || uploading) return
    setContextIssue(''); setUploading(true)
    try {
      const result = await desktop.chatContext({ action: 'preview', sessionId, id: attachment.id })
      if (!result.ok || result.text === undefined) { setContextIssue(result.message ?? 'Could not load the pasted text.'); return }
      const combined = input ? `${input}\n\n${result.text}` : result.text
      if (combined.length > MAX_DRAFT_LENGTH) { setContextIssue('This attachment is larger than Athena’s editable draft limit. Keep it attached or split it into smaller sections.'); return }
      changeInput(combined, { start: combined.length, end: combined.length })
      const removed = await desktop.chatContext({ action: 'remove', sessionId, id: attachment.id })
      if (!removed.ok) { setContextIssue(removed.message ?? 'The text was restored, but the attachment could not be removed.') }
      requestAnimationFrame(() => composer.current?.focus())
    } catch { setContextIssue('Could not restore the pasted text to the composer.') }
    finally { setUploading(false) }
  }
  const droppedFiles = async (files: File[]) => {
    const sessionId = snapshot.sessionId
    setDraggingFiles(false)
    if (!sessionId || busy || uploading) return
    setDraggingFiles(false); setContextIssue(''); setUploading(true)
    try {
      if (files.length + (snapshot.attachments?.length ?? 0) > 8) throw new Error('Attach up to 8 files per message.')
      for (let index = 0; index < files.length; index++) {
        const file = files[index]
        if (!file.size || file.size > MAX_ATTACHMENT_BYTES) throw new Error('Each file must be non-empty and no larger than 20 MB.')
        const result = await desktop.chatContext({ action: 'import', sessionId, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
        if (!result.ok) throw new Error(result.message ?? 'File could not be attached.')
      }
    } catch (error) { setContextIssue(error instanceof Error ? error.message : 'Could not attach files.') }
    finally { setUploading(false) }
  }
  useEffect(() => {
    const disconnect = connectChat()
    let live = true
    void desktop.getAIStatus().then((result) => {
      if (live) { setConfig(result.status); setConfigurationError(result.ok ? '' : result.message); setLoading(false) }
    }).catch(() => { if (live) { setLoading(false); setConfigurationError('Could not load AI settings.') } })
    const network = () => setOnline(navigator.onLine)
    window.addEventListener('online', network); window.addEventListener('offline', network)
    return () => { live = false; disconnect(); window.removeEventListener('online', network); window.removeEventListener('offline', network) }
  }, [settings?.aiMode, settings?.chatGPTCodingBackend, snapshot.sessionId, snapshot.workspaces?.map((workspace) => workspace.id).join('|')])
  useLayoutEffect(() => {
    // A previous conversation's reading position must never suppress the
    // initial scroll for the newly selected session.
    follow.current = true
    setShowLatest(false)
  }, [snapshot.sessionId])
  useLayoutEffect(() => {
    const sessionChanged = !hasPositionedTranscript.current || positionedSession.current !== snapshot.sessionId
    if (sessionChanged) {
      hasPositionedTranscript.current = true
      positionedSession.current = snapshot.sessionId
      positionAtLatestImmediately()
      return
    }
    if (!follow.current) return
    if (autoScrollFrame.current !== undefined) cancelAnimationFrame(autoScrollFrame.current)
    autoScrollFrame.current = requestAnimationFrame(() => {
      autoScrollFrame.current = undefined
      if (follow.current) scrollToLatest()
    })
  }, [snapshot.revision, snapshot.sessionId])
  useEffect(() => {
    const element = transcript.current
    if (!element) return
    const onScrollEnd = () => {
      if (!autoScrolling.current) return
      cancelAutoScroll()
      updateFollowFromPosition()
    }
    element.addEventListener('scrollend', onScrollEnd)
    return () => {
      element.removeEventListener('scrollend', onScrollEnd)
      if (autoScrollFrame.current !== undefined) cancelAnimationFrame(autoScrollFrame.current)
      cancelAutoScroll()
    }
  }, [])
  useEffect(() => {
    if (composer.current) { composer.current.style.height = 'auto'; composer.current.style.height = `${Math.min(composer.current.scrollHeight, 180)}px` }
  }, [input])
  const selectSlash = (definition: SlashCommandDefinition) => {
    const existing = commandAtStart(input)
    const leading = input.length - input.trimStart().length
    const value = `${' '.repeat(leading)}${definition.name}${existing?.arguments ? ` ${existing.arguments}` : ' '}`
    changeInput(value, { start: value.length, end: value.length })
    setSelectedSlash(definition)
    setSlashOpen(false); setSlashNotice('')
    requestAnimationFrame(() => composer.current?.focus())
  }
  const runBuiltin = async (definition: SlashCommandDefinition): Promise<boolean> => {
    const parsed = commandAtStart(input)
    if (parsed?.arguments.trim()) { setSlashNotice(`${definition.name} does not take arguments.`); return false }
    switch (definition.id) {
      case 'athena:help': setSlashNotice('Commands from this project appear above. Claude/Codex Markdown commands run through Athena’s current AI provider and normal permissions; native CLI-only syntax is not executed.'); break
      case 'athena:model': {
        if (selectionRequired) useAthena.getState().setPage('ai')
        else { const selector = document.querySelector('[aria-label="Conversation model"]') as HTMLElement | null; if (!selector) { setSlashNotice('The current provider has no model selector in this conversation. Check Settings → AI.'); return false } selector.click() }
        break
      }
      case 'athena:effort': {
        if (selectionRequired) useAthena.getState().setPage('ai')
        else { const selector = document.querySelector('[aria-label="Reasoning effort"]') as HTMLElement | null; if (!selector) { setSlashNotice('The current provider does not expose reasoning effort.'); return false } selector.click() }
        break
      }
      case 'athena:clear': if (!window.confirm('Clear this conversation? Completed project changes will not be reverted.')) return false; if (!await useChat.getState().clear()) return false; break
      case 'athena:new': if (!await command({ action: 'create', ...(snapshot.workspaces?.[0]?.authorized ? { workspaceId: snapshot.workspaces[0].id } : {}) })) return false; break
      case 'athena:project': if (!snapshot.sessionId || !await contextRequest({ action: 'connect', sessionId: snapshot.sessionId })) return false; break
      case 'athena:sessions': setSidebar(true); break
      default: setSlashNotice('This built-in is unavailable in Athena.'); return false
    }
    return true
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!input.trim() || busy || voiceActive || pending || uploading || !available) return
    const resolution = resolveSlashCommand(input, slashCatalog.commands)
    if (resolution?.status === 'unknown') { setSelectedSlash(null); setSlashOpen(false); setSlashNotice(`${resolution.parsed.name} is not registered in this conversation. Refresh project commands or send it as ordinary text without a leading slash.`); return }
    if (resolution?.status === 'ambiguous' && !resolution.matches.some(entry => entry.id === selectedSlash?.id)) { setSlashText(resolution.parsed.name); setSlashIndex(0); setSlashOpen(true); setSlashNotice(`Choose which ${resolution.parsed.name} definition to use.`); return }
    const resolved = selectedSlash && resolution?.matches.some(entry => entry.id === selectedSlash.id) ? selectedSlash : resolution?.matches[0]
    if (selectedSlash && (!resolved || resolved.id !== selectedSlash.id)) { setSlashNotice('The selected command changed. Refresh commands and retry.'); return }
    if (resolved?.execution === 'built-in') {
      void runBuiltin(resolved).then((ok) => { if (ok) { changeInput(''); setSelectedSlash(null); setSlashOpen(false) } })
      return
    }
    clearTimeout(draftTimer.current); unsavedDraft.current = undefined
    let messageText = input
    if (messageText.length > MAX_MESSAGE_LENGTH) {
      // A restored/edited long draft follows the same path as a long paste:
      // persist the complete text as an attachment, then send a short explicit
      // instruction so every provider receives the attachment through its
      // existing adapter instead of an oversized inline message.
      const attached = await createPastedTextAttachment(messageText)
      if (!attached) return
      messageText = 'Please follow the instructions in the attached text.'
      changeInput('')
    }
    const sentSession = snapshot.sessionId
    follow.current = true
    const accepted = await send(messageText, resolved?.id)
    if (accepted && sentSession === sessionRef.current) { history.current.index = null; setInput(''); setSelectedSlash(null); setSlashOpen(false); setSlashNotice('') }
  }
  const navigateHistory = (direction: -1 | 1, element: HTMLTextAreaElement) => {
    const sessionId = snapshot.sessionId
    const entries = snapshot.messages.filter(message => message.role === 'user' && message.status === 'complete').map(message => ({ id: message.id, content: message.content }))
    let state = history.current
    if (state.sessionId !== sessionId) state = history.current = { sessionId, entries, index: null, draft: '', start: 0, end: 0, pendingOlder: false }
    else state.entries = entries
    if (!entries.length) return false
    if (state.index === null) {
      if (direction > 0) return false
      state.draft = input; state.start = element.selectionStart; state.end = element.selectionEnd
      state.index = entries.length
    }
    const next = state.index + direction
    if (next < 0) return true
    if (next >= entries.length) {
      const draft = state.draft, start = state.start, end = state.end
      state.index = null
      changeInput(draft, { start, end }, false)
      return true
    }
    state.index = next
    const recalled = entries[next].content
    changeInput(recalled, { start: recalled.length, end: recalled.length }, false)
    setSlashOpen(false)
    return true
  }
  useEffect(() => {
    const state = history.current
    if (!state.pendingOlder || state.sessionId !== snapshot.sessionId) return
    const previousSelection = state.index === null ? undefined : state.entries[state.index]?.id
    const entries = snapshot.messages.filter(message => message.role === 'user' && message.status === 'complete').map(message => ({ id: message.id, content: message.content }))
    const selectedIndex = previousSelection ? entries.findIndex(entry => entry.id === previousSelection) : -1
    state.entries = entries; state.pendingOlder = false
    if (selectedIndex <= 0) return
    state.index = selectedIndex - 1
    const recalled = entries[state.index].content
    changeInput(recalled, { start: recalled.length, end: recalled.length }, false)
    setSlashOpen(false)
  }, [snapshot.revision, snapshot.sessionId])
  const receiveTranscript = (text: string, id: string) => {
    if (id !== sessionRef.current || id !== useChat.getState().snapshot.sessionId) return
    const intent = settings?.voiceAutoSend && !input.trim() ? voiceControlIntent(text) : undefined
    if (intent) {
      void desktop.stopAllSpeech()
      if (intent === 'cancel-task') void stop()
      setContextIssue(intent === 'cancel-task' ? 'Task cancellation requested. Completed actions are preserved.' : 'Speech stopped. The task was not cancelled.')
      return
    }
    const combined = [input.trimEnd(), text].filter(Boolean).join('\n')
    if (combined.length > MAX_MESSAGE_LENGTH) { setContextIssue('The combined message is too long. Send your existing draft before recording again.'); return }
    changeInput(combined); composer.current?.focus()
    if (!settings?.voiceAutoSend || input.trim() || snapshot.attachments?.length || busy || pending || uploading || !available) return
    // Voice commands enter the exact text path. Keep the transcript available if
    // submission fails; never silently send an existing draft or pending files.
    clearTimeout(draftTimer.current); unsavedDraft.current = undefined
    follow.current = true
    void send(combined).then((accepted) => {
      if (id !== sessionRef.current) return
      if (accepted) setInput((current) => current === combined ? '' : current)
      else if (composer.current?.value === combined) changeInput(combined)
    })
  }
  const last = snapshot.messages.at(-1)
  return <div className={`conversation-workbench ${sidebar ? 'with-sidebar' : ''}`}><section className={`ai-chat ${draggingFiles ? 'files-over' : ''}`} aria-label="Athena conversation" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDraggingFiles(true) } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingFiles(false) }} onDrop={(event) => { event.preventDefault(); void droppedFiles([...event.dataTransfer.files]) }}>
    <div className="chat-toolbar"><button type="button" className="chat-action" aria-label="Toggle conversation sidebar" aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><PanelRight size={17} /></button></div>
    {loading ? <p role="status">Loading AI configuration…</p> : !configured || configurationError ? <div className="chat-setup" role="status">
      <p>{selectionRequired ? 'Choose an online provider in Settings → AI. Your local model remains available through floating Athena.' : configurationError || (!config.active ? 'Online chat is not configured. Choose and connect an online provider in Settings → AI.' : config.provider === 'Cursor Subscription' ? 'Select an available Cursor model in the conversation dropdown before chatting.' : 'Select a text model in the conversation dropdown before chatting.')}</p>
      <button className="button primary" onClick={() => useAthena.getState().setPage('ai')}>Open AI settings</button>
    </div> : null}
    {!online && <p role="alert" className="chat-error">Athena is offline. Cloud chat is unavailable; local companion controls still work.</p>}
    {snapshot.error && <p role="alert" className="chat-error">{snapshot.error}</p>}
    {!isDesktop && <p role="status">Use the desktop app for Athena chat.</p>}
    {!!snapshot.workspaces?.length && <div className="chat-workspace-strip"><FolderOpen size={14} /><button className="chat-action" onClick={() => setProjectBrowser(!projectBrowser)}>{snapshot.workspaces.map((workspace) => workspace.name + (workspace.authorized ? '' : ' · select again')).join(', ')}</button><span>Project agent · permission-controlled</span></div>}
    {projectBrowser && <WorkspacePanel key={snapshot.sessionId} close={() => setProjectBrowser(false)} report={setContextIssue} />}
    <div className="chat-transcript-wrap"><div className="chat-transcript" ref={transcript} role="log" aria-label="Conversation history" aria-live="off" onWheelCapture={cancelAutoScroll} onPointerDownCapture={cancelAutoScroll} onKeyDownCapture={(event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelAutoScroll()
    }} onScroll={() => { if (!autoScrolling.current) updateFollowFromPosition() }}>
      {snapshot.hasMore && <button className="chat-action chat-load-more" onClick={() => { follow.current = false; void command({ action: 'more', id: snapshot.sessionId! }) }}>Load earlier messages</button>}
      {!snapshot.messages.length && !snapshot.voiceSearchPreview && <div className="chat-empty"><div className="chat-empty-symbol"><Sparkles size={28} /></div><span className="chat-empty-eyebrow">A LITTLE CLARITY. A LITTLE POSSIBILITY.</span><h1>What’s on your mind?</h1><p>A question, an idea, a little help with your code.<br />Let’s work through it together.</p><div className="chat-starters">{[{ icon: Code2, title: 'Work through code', text: 'Help me understand a piece of code.' }, { icon: Lightbulb, title: 'Explore an idea', text: 'Help me brainstorm an idea.' }].map(({ icon: Icon, title, text }) => <button key={title} disabled={loading || !available || !isDesktop} onClick={() => { changeInput(text); composer.current?.focus() }}><Icon size={18} /><span>{title}</span><ArrowUp size={14} /></button>)}</div></div>}
      {snapshot.messages.map((message) => <ChatMessage key={message.id} message={message} sessionId={snapshot.sessionId} speaking={speechStatus.phase === 'playing' && speechStatus.messageId === message.id} onSpeak={() => { if (snapshot.sessionId) void speakMessage(snapshot.sessionId, message.id) }} onStopSpeaking={stopSpeaking} canRetry={message.id === last?.id} retryDisabled={busy || pending || !available} onRetry={() => void retry()} onAnswerChoice={message.id === last?.id && message.role === 'assistant' ? async (answer) => {
        if (busy || pending || uploading || !available || voiceActive) return false
        follow.current = true
        return send(answer)
      } : undefined} choiceDisabled={busy || pending || uploading || !available || voiceActive} onEdit={(text) => {
        const resolution = resolveSlashCommand(text, slashCatalog.commands)
        if (resolution?.status === 'unknown') { setSlashNotice(`${resolution.parsed.name} is not registered in this conversation.`); return Promise.resolve(false) }
        if (resolution?.status === 'ambiguous') { setSlashNotice(`Choose which ${resolution.parsed.name} definition to use from the composer.`); return Promise.resolve(false) }
        return command({ action: 'edit', id: snapshot.sessionId!, messageId: message.id, text, ...(resolution?.matches[0] ? { commandId: resolution.matches[0].id } : {}) })
      }} />)}
      {snapshot.voiceSearchPreview && <div><p className="chat-message-note">Voice search result · temporary, not saved to this chat</p><ChatMessage message={snapshot.voiceSearchPreview} sessionId={snapshot.sessionId} canRetry={false} retryDisabled onRetry={() => {}} /></div>}
    </div>{showLatest && <button className="chat-jump" aria-label="Jump to latest message" title="Jump to latest message" onClick={scrollToLatest}><ArrowDown size={17} /></button>}</div>
    <div className="chat-composer-shell">
      {snapshot.sessionId && <HeldPermissionPrompt messages={snapshot.messages} sessionId={snapshot.sessionId} decide={(approvalId, allow, remember) => command({ action: 'agent-approval', id: snapshot.sessionId!, approvalId, allow, remember })} />}
      {slashOpen && !selectedSlash && <div className="chat-slash-menu" role="listbox" id="athena-slash-list" aria-label="Slash command suggestions">
        <div className="chat-slash-menu-heading"><span>Commands</span><button type="button" className="chat-action" aria-label="Refresh commands" onMouseDown={(event) => event.preventDefault()} onClick={() => void refreshSlash()}><RefreshCw size={13} /> Refresh</button></div>
        <div className="chat-slash-options">{suggestions.length ? suggestions.map((entry, index) => <div key={entry.id} id={`athena-slash-option-${index}`} role="option" aria-selected={index === slashIndex} className={`chat-slash-option ${index === slashIndex ? 'selected' : ''}`} onMouseEnter={() => setSlashIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => selectSlash(entry)}><span><strong>{entry.name}</strong><small>{entry.source}{entry.provider ? ` · ${entry.provider === 'claude' ? 'Claude-native' : entry.provider === 'codex' ? 'Codex-native' : 'Athena-native'}` : ''}{entry.compatibility === 'native-only' ? ' · native provider required' : ''}</small></span><span className="chat-slash-description">{entry.description}{entry.argumentHint && <em> {entry.argumentHint}</em>}</span></div>) : <p className="chat-slash-empty">No matching commands in this project.</p>}</div>
        <button type="button" className="chat-slash-global" onMouseDown={(event) => event.preventDefault()} onClick={() => void refreshSlash(slashCatalog.globalEnabled ? 'revoke-global' : 'authorize-global')}>{slashCatalog.globalEnabled ? 'Stop including global commands' : 'Include global Claude/Codex commands…'}</button>
      </div>}
    <form className="ai-chat-composer" onSubmit={submit}>
      {!!snapshot.attachments?.length && snapshot.sessionId && <AttachmentCards sessionId={snapshot.sessionId} attachments={snapshot.attachments} restoreText={restoreTextAttachment} remove={(id) => void contextRequest({ action: 'remove', sessionId: snapshot.sessionId!, id })} />}
      {contextIssue && <div className="chat-context-notice" role="status">{contextIssue}<button className="chat-action" onClick={() => useAthena.getState().setPage('privacy')}>Privacy settings</button><button className="chat-action" aria-label="Dismiss file notice" onClick={() => setContextIssue('')}>×</button></div>}
      {config.provider === 'Cursor Subscription' && snapshot.cursorModelNotice && <p className="chat-message-note" role="status">{snapshot.cursorModelNotice}</p>}
      {slashNotice && <p className="chat-message-note chat-slash-notice" role="status">{slashNotice}</p>}
      <div className="chat-command-input" role="combobox" aria-label="Slash command suggestions" aria-haspopup="listbox" aria-expanded={slashOpen && !selectedSlash} aria-controls={slashOpen && !selectedSlash ? 'athena-slash-list' : undefined} aria-activedescendant={slashOpen && !selectedSlash && suggestions.length ? `athena-slash-option-${Math.min(slashIndex, suggestions.length - 1)}` : undefined}>{selectedSlash && <span className="chat-command-chip" title={selectedSlash.source}>{selectedSlash.name}</span>}
      <textarea ref={composer} aria-label="Message Athena" aria-autocomplete="list" placeholder={selectedSlash ? 'Add arguments…' : 'Ask Athena...'} rows={1} maxLength={MAX_DRAFT_LENGTH} value={selectedSlash ? (commandAtStart(input)?.arguments ?? input) : input} disabled={loading || !available || !isDesktop} onFocus={(event) => { const query = selectedSlash ? null : slashQuery(input, event.currentTarget.selectionStart); if (query) { setSlashText(query); setSlashIndex(0); setSlashOpen(true); void refreshSlash() } }} onPaste={(event) => {
        const plain = event.clipboardData.getData('text/plain')
        const formatted = clipboardHtmlToMarkdown(event.clipboardData.getData('text/html'))
        const pasted = plain || formatted
        if (!pasted) return
        const fingerprint = `${pasted.length}:${pasted.slice(0, 64)}:${pasted.slice(-64)}`
        const previousPaste = pasteGuard.current
        if (previousPaste && previousPaste.fingerprint === fingerprint && Date.now() - previousPaste.at < 350) { event.preventDefault(); return }
        pasteGuard.current = { fingerprint, at: Date.now() }
        const element = event.currentTarget
        const displayValue = element.value
        const inlineValue = formatted || plain
        const inserted = `${displayValue.slice(0, element.selectionStart)}${inlineValue}${displayValue.slice(element.selectionEnd)}`
        const current = commandAtStart(input), leading = input.length - input.trimStart().length
        const prefix = selectedSlash && current ? `${' '.repeat(leading)}${selectedSlash.name} ` : ''
        const value = `${prefix}${inserted}`
        const shouldAttach = pasted.length >= LONG_TEXT_PASTE_THRESHOLD || value.length > MAX_MESSAGE_LENGTH
        // Keep ordinary plain-text paste on the browser's native path. This
        // preserves selection/caret behavior and the existing slash-command
        // autocomplete behavior; only long or over-limit content is intercepted.
        if (!formatted && !shouldAttach) return
        event.preventDefault()
        if (shouldAttach) {
          void createPastedTextAttachment(pasted)
          return
        }
        const caret = prefix.length + element.selectionStart + inlineValue.length
        changeInput(value, { start: caret, end: caret })
      }} onChange={(event) => {
        const current = commandAtStart(input), leading = input.length - input.trimStart().length
        const prefix = selectedSlash && current ? leading + current.name.length + 1 : 0
        const value = selectedSlash ? `${' '.repeat(leading)}${selectedSlash.name} ${event.target.value}` : event.target.value
        changeInput(value, { start: prefix + event.target.selectionStart, end: prefix + event.target.selectionEnd })
      }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (selectedSlash && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelectedSlash(null); requestAnimationFrame(() => composer.current?.select()); return }
        if (selectedSlash && (event.key === 'Backspace' || event.key === 'Delete') && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) { event.preventDefault(); setSelectedSlash(null); changeInput(input); return }
        if (slashOpen && !selectedSlash) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex((current) => suggestions.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length : 0); return }
          if (event.key === 'Escape') { event.preventDefault(); setSlashOpen(false); return }
          if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); if (suggestions.length) selectSlash(suggestions[Math.min(slashIndex, suggestions.length - 1)]); return }
        }
        if (!event.altKey && !event.metaKey && !event.ctrlKey && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
          const position = event.currentTarget.selectionStart
          if (event.key === 'ArrowUp' && (history.current.index !== null || input.length === 0 || position === 0)) {
            if (history.current.index === 0 && snapshot.hasMore && !history.current.pendingOlder && snapshot.sessionId) {
              history.current.pendingOlder = true
              void command({ action: 'more', id: snapshot.sessionId }).then(ok => { if (!ok) history.current.pendingOlder = false })
              event.preventDefault(); return
            }
            if (navigateHistory(-1, event.currentTarget)) event.preventDefault()
            return
          }
          if (event.key === 'ArrowDown' && (history.current.index !== null || position === event.currentTarget.value.length)) {
            if (navigateHistory(1, event.currentTarget)) event.preventDefault()
            return
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
      }} /></div>
      <div className="chat-composer-toolbar"><div className="chat-composer-tools"><button type="button" className="chat-action" aria-label="Attach files or images" title="Attach files or images (20 MB each)" disabled={busy || voiceActive || uploading || !snapshot.sessionId} onClick={() => void contextRequest({ action: 'pick-files', sessionId: snapshot.sessionId! })}><Paperclip size={17} /></button><button type="button" className="chat-action" aria-label="Connect project folder" title="Authorize a local project; changes follow the selected permission mode" disabled={busy || voiceActive || uploading || !snapshot.sessionId} onClick={() => void contextRequest({ action: 'connect', sessionId: snapshot.sessionId! }).then((ok) => { if (ok) setProjectBrowser(true) })}><FolderOpen size={17} /></button><PushToTalk sessionId={snapshot.sessionId} toggle disabled={busy || pending || uploading || loading || !available || !isDesktop} onActive={setVoiceActive} onTranscript={(text, id) => {
        receiveTranscript(text, id)
      }} /></div><ConversationControls config={config} />{speechStatus.phase !== 'idle' && <button type="button" className="chat-action" aria-label="Stop speaking" title="Stop speaking" onClick={stopSpeaking}><VolumeX size={14} /></button>}{busy ? <button type="button" className="chat-send" aria-label="Stop generation" title="Stop generation" disabled={pending} onClick={() => void stop()}><Square size={16} fill="currentColor" /></button> : <button className="chat-send" type="submit" aria-label="Send message" title="Send message" disabled={voiceActive || pending || uploading || loading || !available || !input.trim()}><ArrowUp size={19} /></button>}</div>
    </form></div>
    <p className="chat-privacy-note">AI can make mistakes · History saved on this Mac · Requests use the provider chosen in Settings</p>
  </section>{sidebar && <ConversationSidebar />}</div>
}
