import type { RememberedPermissions } from '../permissions/rememberedPermissions'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { chatInputSchema, emptyChatSnapshot, MAX_RESPONSE_LENGTH, stripTrailingSourcesSection, type ChatMessage, type ChatPhase, type ChatResult, type ChatSnapshot } from '../../../shared/chat'
import { modelCapabilities, sessionCommandSchema, type Attachment, type ConversationConfig, type WorkspaceReference } from '../../../shared/conversations'
import { newConversation, type Conversation, type ConversationLibrary, type ConversationStorage } from './conversationRepository'
import { recentContext } from './contextBudget'
import type { DeterministicActionResult, PreparedContext } from './AIProvider'
import { ChatError, type AIProvider } from './AIProvider'
import { log } from '../logger'
import type { AgentActivity, AgentApproval, ChangePreview } from '../../../shared/agent'
import type { ResponseInput } from 'openai/resources/responses/responses'
import type { ActionSpeechEvent } from '../voice/actionNarrator'
import { handsFreeReplySchema, type LocalInferenceTrace } from '../../../shared/handsFree'
import type { SlashCommandMeta } from '../../../shared/slashCommands'
import { contextDefaults } from '../../../shared/context'
import { voiceReasoningEffort } from '../../../shared/voiceResponse'
import type { SubagentRun } from '../../../shared/subagents'
import { workflowSubagentRequirements } from './subagentWorkflow'
import type { AIOwnership, ConversationOrigin } from '../../../shared/aiOwnership'
import type { AutomationProgress } from '../../../shared/automation'
import { localInferenceSlots } from './localInferenceSlots'

function contextFingerprint(session: Conversation, messages: ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify({ model: session.config.model, effort: session.config.effort, mode: session.config.agentMode, workspaces: session.workspaces, messages: messages.map(({ id, content, attachments }) => ({ id, content, attachments })) })).digest('hex')
}

interface ChatHooks {
  rememberedPermissions?: RememberedPermissions
  origin?: ConversationOrigin
  provider(config: ConversationConfig, options?: { isolated: boolean; coding: boolean }): Promise<AIProvider>
  accountIdentity?(): Promise<string | null>
  useCheckpoint?(): boolean
  effectiveModel?(): string | null
  modelSupportsEffort?(model: string | null, effort: ConversationConfig['effort']): boolean | undefined
  prepare?(session: Conversation, messages: ChatMessage[], signal: AbortSignal, voiceOnly?: boolean): Promise<PreparedContext>
  resolveVoiceCommand?(session: Conversation, request: string, requestId: string, signal: AbortSignal): Promise<DeterministicActionResult>
  authorized?(id: string): boolean
  changed(snapshot: ChatSnapshot): void
  phase(phase: ChatPhase, ownership?: AIOwnership): void
  beforeAction?(event: ActionSpeechEvent): Promise<string | undefined>
  taskEnded?(sessionId: string, message: ChatMessage): void
  voiceTimeoutMs?(): number
  adaptiveVoiceReasoning?(): boolean
  resolveCommand?(session: Conversation, command: SlashCommandMeta, text: string, signal: AbortSignal): Promise<string>
  maxConcurrent?(): number
  resource?: 'local' | 'remote'
  isViewed?(sessionId: string): boolean
  executionEnded?(event: { sessionId: string; title: string; executionId: string; status: 'complete' | 'failed'; unreadCount: number }): void
  approvalChanged?(event: { sessionId: string; title: string; approvalId: string; action: 'required' | 'resolved'; summary?: string; projectId?: string; projectName?: string; taskId?: string }): void
  unreadChanged?(count: number): void
  storeArtifact?(input: { name: string; mimeType: string; bytes: Uint8Array; provider?: string }): Promise<import('../../../shared/chat').GeneratedArtifact>
}
interface Generation { id: string; abort: AbortController; timeout?: ReturnType<typeof setTimeout>; queued: boolean; controllerReserved?: boolean; releaseResource?: () => void; startedAt: number }
export class ChatController {
  private readonly executionScope = new AsyncLocalStorage<string>()
  private readonly states = new Map<string, ChatSnapshot>()
  private readonly generations = new Map<string, Generation>()
  private readonly publishTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly approvals = new Map<string, { id: string; resolve(allow: boolean, remember?: boolean): void }>()
  private readonly queue: Array<{ id: string; start(): void }> = []
  private revision = 0
  private running = 0
  private drainingPaused = false
  private get scopedId(): string { return this.executionScope.getStore() ?? this.library.activeId }
  private get state(): ChatSnapshot {
    const id = this.scopedId
    let state = this.states.get(id)
    if (!state) { state = { ...emptyChatSnapshot(), messages: this.getSession(id)?.messages ?? [] }; this.states.set(id, state) }
    return state
  }
  private get generation(): Generation | undefined { return this.generations.get(this.scopedId) }
  private set generation(value: Generation | undefined) { if (value) this.generations.set(this.scopedId, value); else this.generations.delete(this.scopedId) }
  private get approval() { return this.approvals.get(this.scopedId) }
  private set approval(value: { id: string; resolve(allow: boolean, remember?: boolean): void } | undefined) { if (value) this.approvals.set(this.scopedId, value); else this.approvals.delete(this.scopedId) }
  private get publishTimer() { return this.publishTimers.get(this.scopedId) }
  private set publishTimer(value: ReturnType<typeof setTimeout> | undefined) { if (value) this.publishTimers.set(this.scopedId, value); else this.publishTimers.delete(this.scopedId) }
  private disposed = false
  private voiceMessages: ChatMessage[] = []
  private voiceSearchPreview?: { sessionId: string; message: ChatMessage }
  private cursorModelNotice?: string
  private voiceAbort?: AbortController
  private voiceOwnership?: AIOwnership
  private library: ConversationLibrary
  private pageSize = 60
  private saveTimer?: ReturnType<typeof setTimeout>
  private storageFailed = false
  private childCancellations = new Map<string, { sessionId: string; cancel(): void }>()
  async childProvider(config: ConversationConfig, accountId: string | null): Promise<AIProvider> {
    if ((await this.hooks.accountIdentity?.() ?? null) !== accountId) throw new ChatError('The selected account changed. Continue with the original account before launching a sub-agent.')
    return this.hooks.provider(config, { isolated: true, coding: true })
  }
  activeExecution(): ChatMessage | undefined { return this.state.messages.find((entry) => entry.id === this.generation?.id) }
  subagentRecords(sessionId: string): Array<{ activityId: string; run: SubagentRun }> {
    return this.getSession(sessionId)?.messages.flatMap((message) => message.execution?.activities.flatMap((activity) => activity.subagent ? [{ activityId: activity.id, run: activity.subagent }] : []) ?? []) ?? []
  }
  registerChildCancellation(id: string, sessionId: string, cancel: () => void): () => void {
    this.childCancellations.set(id, { sessionId, cancel })
    return () => { this.childCancellations.delete(id) }
  }
  updateSubagent(activityId: string, run: SubagentRun): void {
    const activity = this.library.sessions.flatMap((session) => session.messages).flatMap((message) => message.execution?.activities ?? []).find((entry) => entry.id === activityId)
    if (!activity) return
    activity.subagent = run
    activity.summary = run.result?.summary ?? run.error ?? run.progress ?? 'Queued for isolated execution.'
    activity.status = ['queued', 'running'].includes(run.status) ? 'running' : run.status === 'completed' ? 'complete' : run.status === 'cancelled' ? 'cancelled' : 'error'
    activity.finishedAt = run.finishedAt
    this.publish(); this.save()
  }
  async beforeAction(tool: string, input: unknown, signal: AbortSignal): Promise<void> {
    const generation = this.generation
    signal.throwIfAborted()
    if (!generation) return
    let text: string | undefined
    try { text = await this.hooks.beforeAction?.({ sessionId: this.current().id, messageId: generation.id, tool, input, signal, ownership: this.activeExecution()?.ownership }) }
    catch { /* Speech availability must not turn an authorized action into a failure. */ }
    signal.throwIfAborted()
    if (this.generation !== generation) throw new ChatError('This task is no longer active.')
    if (text) {
      const execution = this.state.messages.find((message) => message.id === generation.id)?.execution
      if (execution && execution.activities.length < 98) {
        execution.activities.push({ id: randomUUID(), tool: 'voice_acknowledgment', label: text, summary: 'Spoken acknowledgment started.', startedAt: Date.now(), finishedAt: Date.now(), status: 'complete' })
        this.publish()
      }
    }
  }
  private checkpointTask(reply: ChatMessage, session: Conversation): void {
    const execution = reply.execution
    if (!execution?.taskCheckpoint) return
    const checkpoint = execution.taskCheckpoint
    checkpoint.updatedAt = Date.now()
    checkpoint.completedOperationIds = execution.activities.filter((activity) => activity.status === 'complete').map((activity) => activity.id)
    checkpoint.modifiedFiles = [...new Set(execution.activities.flatMap((activity) => activity.changes?.filter((change) => change.status === 'applied').map((change) => change.path) ?? []))]
    checkpoint.verificationOperationIds = execution.activities.filter((activity) => /^(run_|execute_command|inspect_errors)/.test(activity.tool)).map((activity) => activity.id)
    const latest = (predicate: (tool: string, label: string) => boolean) => [...execution.activities].reverse().find((activity) => predicate(activity.tool, activity.label))
    const gate = <Success extends string>(activity: typeof execution.activities[number] | undefined, success: Success): 'not-run' | 'running' | 'failed' | 'blocked' | Success => {
      if (!activity) return 'not-run'
      if (activity.status === 'running') return 'running'
      if (activity.status === 'complete') return success
      return /permission|not authorized|disabled|blocked|EPERM|EACCES|declined/i.test(activity.summary ?? '') ? 'blocked' : 'failed'
    }
    checkpoint.verificationGates = {
      productionBuild: gate(latest((tool, label) => tool === 'run_build' || (tool === 'execute_command' && /\b(?:npm|pnpm|yarn)\s+run\s+build(?:\s|$)/i.test(label))), 'passed'),
      developmentServer: gate(latest((tool) => tool === 'start_dev_server'), 'ready'),
      browserVerification: gate(latest((tool) => tool === 'verify_local_app'), 'passed'),
    }
    const gitStatus = [...execution.activities].reverse().find((activity) => activity.tool === 'git_status' && activity.status === 'complete' && activity.fullOutput)
    if (gitStatus?.fullOutput) {
      try {
        const output = JSON.parse(gitStatus.fullOutput)?.output
        const branch = typeof output === 'string' ? /^## ([A-Za-z0-9._/-]{1,200})(?:\s|$)/.exec(output)?.[1] : undefined
        if (branch) checkpoint.lastKnownBranch = branch
      } catch { /* Older activity records may not have structured Git output. */ }
    }
    checkpoint.requiredApprovalId = execution.approval?.id
    checkpoint.continuationAttempts = execution.recovery?.attempts ?? 0
    checkpoint.workspaceIds = session.workspaces.map((workspace) => workspace.id)
  }
  private timeline(reply: ChatMessage, kind: 'started' | 'text' | 'activity' | 'status', text?: string, activityId?: string): void {
    const entries = reply.execution?.timeline
    if (!entries || entries.length >= 1100) return
    if (kind === 'text' && entries.at(-1)?.kind === 'text') {
      entries[entries.length - 1].text = (entries.at(-1)?.text ?? '') + (text ?? '')
      return
    }
    entries.push({ id: randomUUID(), kind, createdAt: Date.now(), ...(text ? { text } : {}), ...(activityId ? { activityId } : {}) })
  }
  activity(tool: string, label: string, parentActivityId?: string): string {
    const reply = this.state.messages.find((entry) => entry.id === this.generation?.id)
    const execution = reply?.execution
    if (!execution || execution.activities.length >= 500) throw new ChatError('Agent activity safety limit reached. Continue only after reviewing the saved results.')
    const id = randomUUID()
    execution.activities.push({ id, tool, label, startedAt: Date.now(), status: 'running', ...(parentActivityId ? { parentActivityId } : {}) })
    if (tool === 'wait_subagents') execution.streamPhase = 'waiting-subagents'
    if (reply && !parentActivityId) this.timeline(reply, 'activity', undefined, id)
    execution.updatedAt = Date.now(); this.phase('thinking'); this.publish(); return id
  }
  updateActivityOutput(id: string, output: string): void {
    const activity = this.state.messages.find((entry) => entry.id === this.generation?.id)?.execution?.activities.find((entry) => entry.id === id)
    if (!activity || activity.status !== 'running') return
    activity.fullOutput = output.slice(0, 70_000)
    if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 120)
  }
  updateActivityLabel(id: string, label: string): void {
    const activity = this.state.messages.find((entry) => entry.id === this.generation?.id)?.execution?.activities.find((entry) => entry.id === id)
    if (!activity || activity.status !== 'running') return
    activity.label = label.slice(0, 300)
    this.publish()
  }
  finishActivity(id: string, result: Pick<AgentActivity, 'status' | 'summary' | 'changes' | 'fullOutput'>): void {
    const session = this.library.sessions.find((entry) => entry.messages.some((message) => message.execution?.activities.some((activity) => activity.id === id)))
    const reply = session?.messages.find((message) => message.execution?.activities.some((activity) => activity.id === id))
    const execution = reply?.execution
    const activity = execution?.activities.find((entry) => entry.id === id)
    if (activity && execution) { Object.assign(activity, result, { finishedAt: Date.now() }); if (activity.tool === 'wait_subagents' && execution.streamPhase === 'waiting-subagents') execution.streamPhase = 'running-tools'; if (!execution.finishedAt) execution.updatedAt = Date.now(); if (reply && session) this.checkpointTask(reply, session); this.publish() }
  }
  stageChanges(id: string, changes: ChangePreview[]): void {
    const execution = this.state.messages.find((entry) => entry.id === this.generation?.id)?.execution
    const activity = execution?.activities.find((entry) => entry.id === id)
    if (activity) { activity.changes = changes; this.publish(); this.save() }
  }
  approve(request: Omit<AgentApproval, 'id'>, signal: AbortSignal): Promise<boolean> {
    const session = this.current()
    const execution = session.messages.find((entry) => entry.id === this.generation?.id)?.execution
    if (!execution || signal.aborted || this.approval) return Promise.resolve(false)
    const rememberScope = this.hooks.rememberedPermissions?.eligible(request.rememberScope)
    if (rememberScope && this.hooks.rememberedPermissions?.allows(rememberScope, { sessionId: session.id, origin: this.hooks.origin, taskId: this.generation?.id })) return Promise.resolve(true)
    const id = randomUUID(); execution.approval = { ...request, rememberScope, id }; execution.updatedAt = Date.now()
    this.hooks.approvalChanged?.({ sessionId: session.id, title: session.title, approvalId: id, action: 'required', summary: request.title, projectId: session.workspaces[0]?.id, projectName: session.workspaces[0]?.name, taskId: this.generation?.id })
    return new Promise((resolve) => {
      let settled = false
      const finish = (allow: boolean, remember = false) => {
        if (settled) return
        if (allow && remember) {
          if (!rememberScope || !this.hooks.rememberedPermissions || signal.aborted) throw new Error('This permission cannot be remembered.')
          const current = this.hooks.rememberedPermissions.eligible(rememberScope)
          if (JSON.stringify(current) !== JSON.stringify(rememberScope)) throw new Error('Permission scope changed. Deny this request and retry.')
          this.hooks.rememberedPermissions.grant(rememberScope)
        }
        settled = true
        signal.removeEventListener('abort', cancelled); if (this.approval?.id === id) this.approval = undefined; execution.approval = undefined; this.hooks.approvalChanged?.({ sessionId: session.id, title: session.title, approvalId: id, action: 'resolved' }); this.publish(); resolve(allow) }
      const cancelled = () => finish(false)
      this.approval = { id, resolve: finish }; signal.addEventListener('abort', cancelled, { once: true }); this.publish()
    })
  }
  changeReverted(change: ChangePreview): void {
    for (const message of this.current().messages) for (const activity of message.execution?.activities ?? []) {
      const stored = activity.changes?.find((entry) => entry.id === change.id)
      if (stored) Object.assign(stored, change)
    }
    this.publish()
  }
  constructor(private hooks: ChatHooks, private storage?: ConversationStorage) {
    const session = newConversation()
    this.library = { version: 1, activeId: session.id, sessions: [session] }
    try { if (storage) this.library = storage.load() }
    catch { this.storageFailed = true; this.state.error = 'Conversation history could not be read. Your saved data has not been overwritten. Restore conversations.json from a backup before restarting.' }
    this.state.messages = this.current().messages
  }
  current(): Conversation { return this.library.sessions.find((session) => session.id === this.scopedId)! }
  selectedSessionId(): string { return this.library.activeId }
  hasActiveExecutions(): boolean { return this.generations.size > 0 }
  getSession(id: string): Conversation | undefined { return this.library.sessions.find((session) => session.id === id) }
  pendingApprovals(): Array<{ sessionId: string; title: string; approvalId: string; summary: string; projectId?: string; projectName?: string; taskId?: string }> {
    return this.library.sessions.flatMap(session => session.messages.flatMap(message => { const approval = message.execution?.approval; return approval && this.approvals.get(session.id)?.id === approval.id ? [{ sessionId: session.id, title: session.title, approvalId: approval.id, summary: approval.title, projectId: session.workspaces[0]?.id, projectName: session.workspaces[0]?.name, taskId: message.id }] : [] }))
  }
  workspaceReferences(): WorkspaceReference[] {
    const unique = new Map<string, WorkspaceReference>()
    for (const workspace of this.library.sessions.flatMap((session) => session.workspaces)) if (!unique.has(workspace.id)) unique.set(workspace.id, workspace)
    return [...unique.values()]
  }
  search(query: string): string[] {
    const term = query.toLowerCase()
    return this.library.sessions.filter((session) => session.title.toLowerCase().includes(term) || session.messages.some((message) => message.content.toLowerCase().includes(term))).map((session) => session.id)
  }
  initializeModel(model: string | null): void { if (!this.current().config.model && model) { this.current().config.model = model; this.publish() } }
  selectCursorModel(model: string | null, notice?: string): void {
    const session = this.current()
    session.config.model = model
    session.config.cursorModel = model
    delete session.config.cursorPendingModel
    session.config.effort = 'auto'
    this.cursorModelNotice = notice
    this.publish()
  }
  setCursorModelNotice(notice?: string): void { this.cursorModelNotice = notice; this.publish() }
  queueCursorModel(model: string): void {
    this.current().config.cursorPendingModel = model
    this.publish()
  }
  setAutomationProgress(progress?: AutomationProgress): void {
    this.state.automationProgress = progress ? structuredClone(progress) : undefined
    this.publish(true)
  }
  private applyPendingCursorModel(): void {
    const pending = this.current().config.cursorPendingModel
    if (pending) this.selectCursorModel(pending)
  }
  snapshot(): ChatSnapshot {
    const session = this.getSession(this.library.activeId)!
    const state = this.states.get(session.id) ?? { ...emptyChatSnapshot(), messages: session.messages }
    return structuredClone({ ...state, revision: this.revision, error: this.storageFailed ? 'Saved history is unreadable. New changes cannot be saved until conversations.json is restored from a backup and Athena is restarted.' : state.error, cursorModelNotice: this.cursorModelNotice, messages: session.messages.slice(-this.pageSize), sessionId: session.id, config: session.config, draft: session.draft,
      attachments: session.attachments, workspaces: session.workspaces.map((workspace) => ({ ...workspace, authorized: this.hooks.authorized?.(workspace.id) ?? false })),
      sessions: this.library.sessions.map(({ id, title, createdAt, updatedAt, config, workspaces, unreadCompletion, messages }) => { const approval = [...messages].reverse().find((message) => message.execution?.approval)?.execution?.approval; return { id, title, createdAt, updatedAt, config, project: workspaces[0], executionStatus: approval ? 'waiting-approval' as const : this.generations.get(id)?.queued ? 'queued' as const : this.generations.has(id) ? 'running' as const : messages.at(-1)?.execution?.status === 'waiting-auth' || /Request interrupted when Athena closed/.test(messages.at(-1)?.error ?? '') ? 'paused' as const : undefined, ...(approval ? { pendingApprovalId: approval.id } : {}), unreadCompletion } }).sort((a, b) => b.updatedAt - a.updatedAt), hasMore: session.messages.length > this.pageSize,
      voiceSearchPreview: this.voiceSearchPreview?.sessionId === session.id ? this.voiceSearchPreview.message : undefined })
  }
  /** A transient voice-only turn using the selected provider, model, effort and project retrieval.
   * Voice messages never enter ConversationLibrary; cited search answers may be previewed in a snapshot. */
  async answerHandsFree(input: unknown, progress?: (event: { type: 'model-start' | 'text' | 'trace'; text?: string; trace?: LocalInferenceTrace }) => void): Promise<{ ok: boolean; text?: string; message?: string }> {
    const parsed = handsFreeReplySchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'I didn’t catch that. Please try again.' }
    if (this.disposed) return { ok: false, message: 'Voice conversation is unavailable.' }
    if (this.generation) return { ok: false, message: 'I’m in the middle of another task. Say “Athena, cancel the task” if you want me to stop it.' }
    if (this.voiceAbort) return { ok: false, message: 'I’m already responding to your last voice request.' }
    const session = this.current()
    const user: ChatMessage = { id: randomUUID(), role: 'user', content: parsed.data.text, status: 'complete', createdAt: Date.now() }
    const diagnosticDirect = parsed.data.diagnosticDirect === true
    const traceId = parsed.data.id ?? user.id
    const messages = diagnosticDirect ? [user] : [...this.voiceMessages, user]
    const abort = new AbortController()
    this.voiceAbort = abort
    const ownership: AIOwnership = { origin: this.hooks.origin ?? 'online-chat', sessionId: session.id, correlationId: user.id }
    this.voiceOwnership = ownership
    this.hooks.phase('thinking', ownership)
    let timedOut = false
    let releaseLocalInference: (() => void) | undefined
    const timeoutMs = Math.max(30_000, Math.min(600_000, this.hooks.voiceTimeoutMs?.() ?? 120_000))
    let timeout: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new ChatError('Voice response cancelled.'))
      abort.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => abort.signal.removeEventListener('abort', onAbort)
    })
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { timedOut = true; abort.abort(); reject(new ChatError('That voice response took too long. Please try again or increase the voice AI timeout in Settings → Voice.')) }, timeoutMs)
    })
    const run = async () => {
      if (!diagnosticDirect && this.hooks.resolveVoiceCommand) {
        const actionStarted = performance.now()
        log('voice.trace', { traceId, stage: 'deterministic-action-resolution-start' })
        const action = await this.hooks.resolveVoiceCommand(session, parsed.data.text, traceId, abort.signal)
        log('voice.trace', { traceId, stage: action.handled ? 'deterministic-action-resolution-complete' : 'deterministic-action-not-matched', action: action.action ?? 'none', durationMs: Math.round(performance.now() - actionStarted) })
        if (abort.signal.aborted || this.voiceAbort !== abort) throw new ChatError('Voice response cancelled.')
        if (action.handled) {
          const answer = action.text?.trim()
          if (!answer) throw new ChatError('The requested action did not return a verified result.')
          const assistant: ChatMessage = { id: randomUUID(), role: 'assistant', content: answer, status: 'complete', createdAt: Date.now() }
          this.voiceMessages = [...this.voiceMessages, user, assistant]
          while (this.voiceMessages.length > 20 || this.voiceMessages.reduce((total, message) => total + message.content.length, 0) > 16_000) this.voiceMessages.splice(0, 2)
          return { ok: true, text: answer }
        }
      }
      if (this.hooks.resource === 'local') {
        const waiting = performance.now()
        log('voice.trace', { traceId, stage: 'local-inference-slot-wait-start', mode: diagnosticDirect ? 'direct' : 'normal' })
        releaseLocalInference = await localInferenceSlots.acquire(abort.signal)
        log('voice.trace', { traceId, stage: 'local-inference-slot-ready', waitMs: Math.round(performance.now() - waiting) })
      }
      const providerStarted = performance.now()
      log('voice.trace', { traceId, stage: 'provider-initialization-start', mode: diagnosticDirect ? 'direct' : 'normal', model: session.config.model ?? this.hooks.effectiveModel?.() ?? 'selected-local-model' })
      const provider = await this.hooks.provider({ ...session.config }, { isolated: false, coding: false })
      if (abort.signal.aborted || this.voiceAbort !== abort) throw new ChatError('Voice response cancelled.')
      log('voice.trace', { traceId, stage: 'provider-initialization-complete', durationMs: Math.round(performance.now() - providerStarted), model: provider.modelId ?? session.config.model ?? 'selected-local-model' })
      let context: PreparedContext | undefined
      if (!diagnosticDirect) {
        const contextStarted = performance.now()
        log('voice.trace', { traceId, stage: 'context-preparation-start' })
        context = await this.hooks.prepare?.(session, messages, abort.signal, true)
        log('voice.trace', { traceId, stage: 'context-preparation-complete', durationMs: Math.round(performance.now() - contextStarted), tools: context?.projectTools?.definitions.length ?? 0, repositoryCharacters: context?.repositoryText.length ?? 0 })
      } else log('voice.trace', { traceId, stage: 'context-preparation-bypassed', mode: 'direct' })
      // The temporary voice turn keeps the selected provider/model, while a
      // simple greeting does not advertise tools it cannot possibly need.
      if (/^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening)|how are you|tell me a joke)[!?.\s]*$/i.test(parsed.data.text)) context && (context.projectTools = undefined)
      const effort = voiceReasoningEffort(parsed.data.text, provider.modelId ?? session.config.model ?? this.hooks.effectiveModel?.() ?? null, session.config.effort, this.hooks.adaptiveVoiceReasoning?.() ?? true)
      let text = '', complete = false
      progress?.({ type: 'model-start' })
      for await (const chunk of provider.streamMessage(messages, { signal: abort.signal, effort, context, contextSettings: session.config.contextSettings, voiceOnly: true,
        diagnosticDirect, traceId, onLocalInferenceTrace: event => {
          log('ai.local_inference_trace', { traceId, mode: diagnosticDirect ? 'direct' : 'normal', ...event })
          progress?.({ type: 'trace', trace: event })
        } })) {
        if (abort.signal.aborted || this.voiceAbort !== abort) throw new ChatError('Voice response cancelled.')
        if (chunk.type === 'done') { complete = true; break }
        if (chunk.type !== 'text') continue
        if (text.length + chunk.text.length > MAX_RESPONSE_LENGTH) throw new ChatError('That answer is too long for a voice reply. Ask me to make it shorter.')
        text += chunk.text
        if (chunk.text) progress?.({ type: 'text', text: chunk.text })
      }
      if (!complete || !text.trim()) throw new ChatError('I couldn’t finish that answer. Please try again.')
      const assistant: ChatMessage = { id: randomUUID(), role: 'assistant', content: text.trim(), status: 'complete', createdAt: Date.now() }
      this.voiceMessages = [...this.voiceMessages, user, assistant]
      if (context?.webSources?.length && !abort.signal.aborted && this.voiceAbort === abort) {
        this.voiceSearchPreview = { sessionId: session.id, message: assistant }
        this.publish()
      }
      while (this.voiceMessages.length > 20 || this.voiceMessages.reduce((total, message) => total + message.content.length, 0) > 16_000) this.voiceMessages.splice(0, 2)
      return { ok: true, text: assistant.content }
    }
    try {
      return await Promise.race([run(), deadline, cancelled])
    } catch (error) {
      if (timedOut) return { ok: false, message: 'That voice response took too long. Please try again or increase the voice AI timeout in Settings → Voice.' }
      return { ok: false, message: error instanceof ChatError ? error.userMessage : 'I couldn’t reach the selected AI provider. Please try again.' }
    } finally {
      if (timeout) clearTimeout(timeout)
      removeAbortListener()
      releaseLocalInference?.(); releaseLocalInference = undefined
      if (this.voiceAbort === abort) {
        this.voiceAbort = undefined
        this.hooks.phase('idle', ownership)
        this.voiceOwnership = undefined
      }
    }
  }
  cancelHandsFreeReply(): void {
    this.voiceAbort?.abort()
    this.voiceAbort = undefined
    if (this.voiceOwnership) this.hooks.phase('idle', this.voiceOwnership)
    this.voiceOwnership = undefined
  }
  clearHandsFreeContext(): void { this.cancelHandsFreeReply(); this.voiceMessages = [] }
  private save(): void {
    clearTimeout(this.saveTimer); this.saveTimer = undefined
    if (this.storageFailed) return
    for (const session of this.library.sessions) for (const reply of session.messages) if (reply.execution?.status === 'working') this.checkpointTask(reply, session)
    try { this.storage?.save(this.library) }
    catch { this.state.error = 'Could not save conversation history. Check disk space and folder permissions; keep Athena open and retry.' }
  }
  sessionChanged(): void { this.current().updatedAt = Date.now(); this.publish() }
  addAttachments(id: string, attachments: Attachment[]): void {
    const session = this.getSession(id)
    if (!session || (id === this.library.activeId && this.generation)) throw new ChatError('Wait for the response before attaching files.')
    if (session.attachments.length + attachments.length > 8) throw new ChatError('Attach up to 8 files per message.')
    session.attachments.push(...attachments); this.publish()
  }
  addWorkspace(id: string, workspace: WorkspaceReference): void {
    const session = this.getSession(id)
    if (!session) throw new ChatError('Conversation is no longer available.')
    for (const conversation of this.library.sessions) conversation.workspaces = conversation.workspaces.map((entry) => entry.id === workspace.id ? { ...workspace } : entry)
    if (!session.workspaces.some((entry) => entry.id === workspace.id)) { if (session.workspaces.length >= 8) throw new ChatError('Connect up to 8 projects per conversation.'); session.workspaces.push(workspace) }
    this.publish()
  }
  consolidateWorkspace(workspace: WorkspaceReference, legacyIds: string[]): void {
    const aliases = new Set([workspace.id, ...legacyIds])
    for (const session of this.library.sessions) {
      const matched = session.workspaces.some((entry) => aliases.has(entry.id))
      session.workspaces = session.workspaces.filter((entry) => !aliases.has(entry.id))
      if (matched) session.workspaces.unshift({ ...workspace })
    }
  }
  openWorkspace(workspace: WorkspaceReference, legacyIds: string[]): void {
    const activeId = this.library.activeId
    this.consolidateWorkspace(workspace, legacyIds)
    const active = this.getSession(activeId)
    const existing = active?.workspaces.some((entry) => entry.id === workspace.id)
      ? active
      : this.library.sessions
        .filter((session) => session.workspaces.some((entry) => entry.id === workspace.id))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (existing) {
      this.switchTo(existing.id)
    } else {
      const current = this.current()
      const reusable = current.title === 'New conversation' && !current.messages.length && !current.attachments.length && !current.draft && !current.workspaces.length
      if (reusable) {
        current.workspaces = [{ ...workspace }]
        current.config.agentMode = 'ask'
        this.switchTo(current.id)
      } else {
        if (this.library.sessions.length >= 500) throw new ChatError('Archive an old conversation before adding another project (500 conversations maximum).')
        const session = newConversation(current.config)
        session.config.agentMode = 'ask'
        session.workspaces = [{ ...workspace }]
        this.library.sessions.push(session)
        this.switchTo(session.id)
      }
    }
    this.publish()
  }
  renameProject(id: string, name: string): void {
    for (const session of this.library.sessions) session.workspaces = session.workspaces.map((workspace) => workspace.id === id ? { ...workspace, name } : workspace)
    this.publish()
  }
  removeProject(id: string): ChatResult {
    const removed = this.library.sessions.filter((session) => session.workspaces.some((workspace) => workspace.id === id))
    if (!removed.length) return { ok: false, message: 'Project no longer exists.' }
    const activeRemoved = removed.some((session) => session.id === this.library.activeId)
    for (const session of removed) this.stopSession(session.id, 'Project removed. Completed work remains recorded.')
    try { for (const session of removed) this.storage?.archive(session) }
    catch { return { ok: false, message: 'Could not archive every project conversation. Nothing was deleted.' } }
    this.library.sessions = this.library.sessions.filter((session) => !removed.some((entry) => entry.id === session.id))
    for (const session of removed) this.discardSessionState(session.id)
    if (!this.library.sessions.length) this.library.sessions.push(newConversation(removed.find((session) => session.id === this.library.activeId)?.config ?? removed[0].config))
    if (activeRemoved) {
      const next = [...this.library.sessions].sort((left, right) => right.updatedAt - left.updatedAt)[0]
      this.switchTo(next.id)
    }
    this.publish()
    this.hooks.unreadChanged?.(this.unreadCount())
    return { ok: true }
  }
  command(input: unknown, resolvedCommand?: SlashCommandMeta): ChatResult {
    const parsed = sessionCommandSchema.safeParse(input)
    if (!parsed.success || this.disposed) return { ok: false, message: 'Invalid conversation operation.' }
    const command = parsed.data
    if (command.action === 'create') {
      if (this.library.sessions.length >= 500) return { ok: false, message: 'Archive an old conversation before creating another (500 maximum).' }
      const project = command.workspaceId ? this.library.sessions.flatMap((session) => session.workspaces).find((workspace) => workspace.id === command.workspaceId) : undefined
      if (command.workspaceId && !project) return { ok: false, message: 'Project is no longer available. Select its folder again.' }
      const session = newConversation(this.current().config); if (project) session.workspaces.push({ ...project }); this.library.sessions.push(session); this.switchTo(session.id)
    } else {
      const session = this.getSession(command.id)
      if (!session) return { ok: false, message: 'Conversation no longer exists.' }
      if (command.action === 'cancel-subagent') {
        for (const [id, child] of this.childCancellations) if (child.sessionId === session.id && (!command.subagentId || command.subagentId === id)) child.cancel()
        return { ok: true }
      }
      if (command.action === 'agent-approval') {
        const approval = this.approvals.get(session.id)
        if (approval?.id !== command.approvalId) return { ok: false, message: 'This approval is no longer pending.' }
        try { approval.resolve(command.allow, command.remember); return { ok: true } }
        catch { return { ok: false, message: 'Permission could not be saved or its scope changed. No operation was approved. Retry, deny, or use Allow once.' } }
      }
      if (command.action === 'agent-mode') {
        if (this.generation) this.stop('Project permissions changed. The current request was stopped; completed operations remain recorded.')
        session.config.agentMode = command.mode
        if (command.mode === 'advanced') session.config.contextSettings = { ...(session.config.contextSettings ?? contextDefaults()), allowProjectCommands: true }
        session.contextCheckpoint = undefined
      }
      if (command.action === 'project-permissions') {
        if (!session.workspaces.length) return { ok: false, message: 'Connect a project before changing project permissions.' }
        if (this.generation) this.stop('Project permissions changed. Current execution stopped; completed operations remain recorded.')
        session.config.agentMode = command.mode
        session.config.contextSettings = { ...(session.config.contextSettings ?? contextDefaults()), allowProjectDeletion: command.allowDeletion, allowProjectCommands: command.allowCommands }
        session.contextCheckpoint = undefined
      }
      if (command.action === 'configure-context') {
        if (this.generation) return { ok: false, message: 'Stop the request before changing context limits.' }
        session.config.contextSettings = command.settings
      }
      if (command.action === 'switch') this.switchTo(command.id)
      if (command.action === 'rename') { session.title = command.title; session.updatedAt = Date.now() }
      if (command.action === 'delete') {
        if (this.generations.has(command.id)) {
          if (!command.confirmed) return { ok: false, message: 'This conversation still has a running task. Confirm that you want to stop it and delete the conversation.' }
          this.stopSession(command.id)
        }
        try { this.storage?.archive(session) } catch { return { ok: false, message: 'Could not archive the conversation. Nothing was deleted.' } }
        this.library.sessions = this.library.sessions.filter((entry) => entry.id !== command.id)
        this.discardSessionState(command.id)
        this.hooks.unreadChanged?.(this.unreadCount())
        if (!this.library.sessions.length) this.library.sessions.push(newConversation(session.config))
        if (this.library.activeId === command.id) this.switchTo(this.library.sessions[0].id)
      }
      if (command.action === 'configure') {
        if (this.generation && session.id === this.library.activeId) return { ok: false, message: 'Stop the response before switching models.' }
        session.config = { ...command.config, effort: (this.hooks.modelSupportsEffort?.(command.config.model, command.config.effort) ?? modelCapabilities(command.config.model).efforts.includes(command.config.effort)) ? command.config.effort : 'auto' }
      }
      if (command.action === 'configure-model') {
        if (this.generation && session.id === this.library.activeId) return { ok: false, message: 'Stop the response before switching models.' }
        session.config.model = command.model
        if (!(this.hooks.modelSupportsEffort?.(command.model, session.config.effort) ?? modelCapabilities(command.model).efforts.includes(session.config.effort))) session.config.effort = 'auto'
      }
      if (command.action === 'configure-effort') {
        if (this.generation && session.id === this.library.activeId) return { ok: false, message: 'Stop the response before changing reasoning effort.' }
        if (!(this.hooks.modelSupportsEffort?.(session.config.model, command.effort) ?? modelCapabilities(session.config.model).efforts.includes(command.effort))) return { ok: false, message: 'The selected model does not support that reasoning effort.' }
        session.config.effort = command.effort
      }
      if (command.action === 'draft') session.draft = command.text
      if (command.action === 'more' && session.id === this.library.activeId) this.pageSize += 60
      if (command.action === 'edit') {
        if (session.id !== this.library.activeId || this.generation) return { ok: false, message: 'Stop the response and select this conversation before editing.' }
        const index = session.messages.findIndex((message) => message.id === command.messageId && message.role === 'user')
        if (index < 0) return { ok: false, message: 'User message not found.' }
        if (session.messages.slice(index + 1).some((entry) => entry.execution?.activities.some((activity) => activity.changes?.length))) return { ok: false, message: 'This turn changed project files. Send a follow-up instead so its change history is preserved.' }
        session.messages[index].content = command.text
        session.messages[index].command = resolvedCommand
        session.contextCheckpoint = undefined
        session.messages.splice(index + 1); session.updatedAt = Date.now(); this.start(); return { ok: true }
      }
    }
    this.publish(); return { ok: true }
  }
  private switchTo(id: string): void {
    this.clearHandsFreeContext()
    this.library.activeId = id; this.pageSize = 60
    const session = this.current()
    if (session.unreadCompletion) { session.unreadCompletion = undefined; this.hooks.unreadChanged?.(this.unreadCount()) }
    this.state.messages = session.messages
    this.state.ownership = session.messages.at(-1)?.ownership
  }
  private discardSessionState(id: string): void {
    clearTimeout(this.publishTimers.get(id))
    this.publishTimers.delete(id)
    this.approvals.delete(id)
    this.states.delete(id)
  }
  private publish(forceBroadcast = false): void {
    clearTimeout(this.publishTimer); this.publishTimer = undefined
    this.revision++
    if (!this.generations.size) this.save()
    else if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 500)
    if (!this.disposed && (forceBroadcast || this.scopedId === this.library.activeId)) this.hooks.changed(this.snapshot())
  }
  private unreadCount(): number { return this.library.sessions.filter((session) => !!session.unreadCompletion).length }
  unreadCompletions(): number { return this.unreadCount() }
  markViewed(): void {
    const session = this.getSession(this.library.activeId)
    if (!session?.unreadCompletion) return
    session.unreadCompletion = undefined
    this.hooks.unreadChanged?.(this.unreadCount())
    this.publish()
  }
  private phase(phase: ChatPhase): void {
    this.state.phase = phase
    this.state.ownership = this.state.messages.at(-1)?.ownership
    this.hooks.phase(phase, this.state.ownership)
  }
  send(input: unknown, resolvedCommand?: SlashCommandMeta): ChatResult {
    const parsed = chatInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'Enter a message of 1–12,000 characters.' }
    if (parsed.data.sessionId && parsed.data.sessionId !== this.library.activeId) return { ok: false, message: 'Conversation changed. Review your message and send again.' }
    if (parsed.data.requestId && this.state.messages.some((entry) => entry.requestId === parsed.data.requestId)) return { ok: true }
    if (this.disposed || this.generation || this.voiceAbort) return { ok: false, message: 'Wait for Athena, or stop the current response first.' }
    if (this.state.messages.length >= 9998) return { ok: false, message: 'Start a new conversation to continue (10,000 message limit).' }
    const session = this.current()
    this.voiceSearchPreview = undefined
    if (!session.messages.length && session.title === 'New conversation') session.title = parsed.data.text.replace(/\s+/g, ' ').slice(0, 72)
    this.state.messages.push({ id: randomUUID(), role: 'user', content: parsed.data.text, status: 'complete', createdAt: Date.now(), attachments: session.attachments.splice(0), requestId: parsed.data.requestId, command: resolvedCommand })
    session.draft = ''; session.updatedAt = Date.now()
    this.start()
    return { ok: true }
  }
  retry(): ChatResult {
    if (this.disposed || this.generation) return { ok: false, message: 'Stop the current response before retrying.' }
    const last = this.state.messages.at(-1)
    if (!last || last.role !== 'assistant') return { ok: false, message: 'There is no response to retry.' }
    this.current().contextCheckpoint = undefined
    if (!last.execution?.activities.length) this.state.messages.pop()
    this.start(Boolean(last.execution?.activities.length))
    return { ok: true }
  }
  private start(resuming = false): void {
    const reply: ChatMessage = { id: randomUUID(), role: 'assistant', content: '', status: 'streaming', createdAt: Date.now() }
    reply.execution = { startedAt: reply.createdAt, updatedAt: reply.createdAt, status: 'working', activities: [], timeline: [] }
    const request = [...this.state.messages].reverse().find((entry) => entry.role === 'user')
    if (request?.command) this.timeline(reply, 'started', `${resuming ? 'Continuing' : 'Starting'} ${request.command.name}.`)
    else if (!resuming && this.current().workspaces.length && this.state.messages.filter((entry) => entry.role === 'user').length === 1) this.timeline(reply, 'started', 'I’ll inspect the authorized project and its current state before making changes.')
    reply.execution.taskCheckpoint = { taskId: reply.id, model: this.hooks.effectiveModel?.() ?? this.current().config.model ?? '', originalRequest: [...this.state.messages].reverse().find((entry) => entry.role === 'user')?.content ?? '', workspaceIds: this.current().workspaces.map((entry) => entry.id), instructionMessageIds: this.state.messages.filter((entry) => entry.role === 'user').map((entry) => entry.id), completedOperationIds: [], modifiedFiles: [], verificationOperationIds: [], verificationGates: { productionBuild: 'not-run', developmentServer: 'not-run', browserVerification: 'not-run' }, pendingActions: ['Complete the user request and applicable verification.'], updatedAt: reply.createdAt, continuationAttempts: 0 }
    const context = recentContext(this.state.messages, Infinity)
    const messages = context.messages
    this.state.contextNotice = undefined
    const abort = new AbortController()
    const generation: Generation = { id: reply.id, abort, queued: true, startedAt: performance.now() }
    this.generation = generation
    reply.ownership = { origin: this.hooks.origin ?? 'online-chat', sessionId: this.current().id, correlationId: reply.id }
    this.state.messages.push(reply)
    this.state.error = null
    this.publish()
    this.save()
    log('ai.request_started')
    const sessionId = this.current().id
    const launch = () => this.executionScope.run(sessionId, () => {
      if (this.generation !== generation || generation.abort.signal.aborted) return
      this.running++
      generation.controllerReserved = true
      const begin = async () => {
        try {
          if (this.hooks.resource === 'local') {
            const waiting = performance.now()
            log('ai.local_chat_pipeline', { traceId: reply.id, stage: 'local-inference-slot-wait-start' })
            generation.releaseResource = await localInferenceSlots.acquire(generation.abort.signal)
            log('ai.local_chat_pipeline', { traceId: reply.id, stage: 'local-inference-slot-ready', waitMs: Math.round(performance.now() - waiting) })
          }
        }
        catch (error) { if (this.generation === generation) this.stop(error instanceof ChatError ? error.userMessage : 'Local inference could not start.', true); return }
        if (this.generation !== generation || generation.abort.signal.aborted) { generation.releaseResource?.(); generation.releaseResource = undefined; return }
        generation.queued = false
        generation.timeout = setTimeout(() => this.stopSession(sessionId, 'The configured task deadline was reached. Review Activity for actual changes before continuing.', true), this.current().workspaces.length ? (this.current().config.contextSettings ?? contextDefaults()).maxExecutionMinutes * 60_000 : 120_000)
        this.phase('thinking'); this.publish(true)
        void this.generate(generation, reply, messages, resuming)
      }
      void begin()
    })
    if (this.running < this.maxConcurrent()) launch()
    else { this.queue.push({ id: sessionId, start: launch }); this.publish() }
  }
  private maxConcurrent(): number { return Math.max(1, Math.min(6, Math.floor(this.hooks.maxConcurrent?.() ?? 3))) }
  private drain(): void { while (!this.drainingPaused && this.running < this.maxConcurrent() && this.queue.length) this.queue.shift()?.start() }
  updateConcurrency(): void { this.drain() }
  private async generate(generation: Generation, reply: ChatMessage, messages: ChatMessage[], resuming = false): Promise<void> {
    try {
      const session = this.current()
      const accountId = await this.hooks.accountIdentity?.() ?? null
      if (this.generation !== generation) return
      if (resuming) {
        const previous = [...messages].reverse().find((entry) => entry.role === 'assistant' && entry.execution?.activities.length)
        if (previous?.execution?.accountId && previous.execution.accountId !== accountId) throw new ChatError('Reconnect and select the same ChatGPT account used for this unfinished task before continuing. Completed project changes are preserved.', 'auth-reconnect')
        const priorWorkspaces = previous?.execution?.taskCheckpoint?.workspaceIds
        if (priorWorkspaces && (priorWorkspaces.length !== session.workspaces.length || priorWorkspaces.some((id) => !session.workspaces.some((workspace) => workspace.id === id)))) throw new ChatError('The authorized project changed since this task paused. Reconnect the original project before continuing; completed changes remain preserved.')
      }
      if (accountId && reply.execution) reply.execution.accountId = accountId
      const completeMessages = messages
      const saved = session.contextCheckpoint
      const index = saved ? messages.findIndex((entry) => entry.id === saved.coveredThrough) : -1
      const workspaceAllowed = !session.workspaces.length || session.workspaces.every((workspace) => this.hooks.authorized?.(workspace.id))
      const checkpoint = this.hooks.useCheckpoint?.() !== false && saved && workspaceAllowed && index >= 0 && saved.fingerprint === contextFingerprint(session, messages.slice(0, index + 1)) ? saved.input as unknown as ResponseInput : undefined
      if (checkpoint) messages = messages.slice(index + 1)
      else session.contextCheckpoint = undefined
      const invoked = [...messages].reverse().find((entry) => entry.role === 'user')
      if (invoked?.command) {
        if (!this.hooks.resolveCommand) throw new ChatError('Slash command execution is unavailable.')
        const prompt = await this.hooks.resolveCommand(session, invoked.command, invoked.content, generation.abort.signal)
        if (reply.execution) reply.execution.subagentRequirements = workflowSubagentRequirements(prompt)
        log('ai.command_expanded', { command: invoked.command.name, model: session.config.model ?? 'provider-default', effort: session.config.effort, instructionBytes: Buffer.byteLength(prompt), historyMessages: messages.length })
        messages = messages.map((entry) => entry.id === invoked.id ? { ...entry, content: prompt } : entry)
      }
      if (resuming) {
        const previous = [...completeMessages].reverse().find((entry) => entry.role === 'assistant' && entry.execution?.activities.length)
        if (reply.execution && previous?.execution?.subagentRequirements?.length) reply.execution.subagentRequirements = previous.execution.subagentRequirements
        const activities = previous?.execution?.activities ?? []
        const task = previous?.execution?.taskCheckpoint
        const recent = activities.slice(-16).map((activity) => {
          const files = activity.changes?.filter((change) => change.status === 'applied').map((change) => change.path).slice(0, 8) ?? []
          return `${activity.status}: ${activity.tool}${files.length ? `; applied: ${files.join(', ')}` : ''}`
        }).join('\n').slice(0, 2400)
        const verified = activities.filter((activity) => task?.verificationOperationIds.includes(activity.id)).slice(-5)
          .map((activity) => `${activity.status}: ${activity.tool}; ${activity.summary?.slice(0, 200) ?? 'No result summary'}`).join('\n')
        const handoff = `Continue the unfinished request, not a fresh rerun. Saved records are not proof of the current filesystem state.\nOriginal request: ${task?.originalRequest ?? 'See the prior user message.'}\nLast recorded branch (revalidate): ${task?.lastKnownBranch ?? 'unknown'}\nRecorded modified paths: ${task?.modifiedFiles.slice(0, 40).join(', ') || 'none'}\nRecent operations:\n${recent || 'none'}\nLast verification results:\n${verified || 'none'}\nPending: ${task?.pendingActions.slice(0, 8).join('; ') || 'Inspect remaining task steps.'}\nValidate the current project/branch and changed targets once, then inspect only the next pending slice. Do not repeat completed slices or destructive operations. Use fresh file versions before editing, preserve user work and approvals, and finish remaining implementation and verification.`.slice(0, 6500)
        messages = [...messages, { id: randomUUID(), role: 'user', status: 'complete', createdAt: Date.now(), content: handoff }]
        const children = activities.flatMap((activity) => activity.subagent ? [{ id: activity.subagent.id, role: activity.subagent.request.role, gateId: activity.subagent.request.gateId, status: activity.subagent.status, summary: activity.subagent.result?.summary, error: activity.subagent.error }] : [])
        if (children.length) messages.push({ id: randomUUID(), role: 'user', status: 'complete', createdAt: Date.now(), content: `Saved isolated child executions (untrusted results): ${JSON.stringify(children)}. Use resume_subagent to validate and restore a saved child before continuing its unfinished checks. Do not replace a required independent review with parent reasoning.` })
      }
      const providerStarted = performance.now()
      const provider = await this.hooks.provider({ ...session.config }, { isolated: false, coding: session.workspaces.length > 0 })
      if (this.hooks.resource === 'local') log('ai.local_chat_pipeline', { traceId: reply.id, stage: 'provider-initialization-complete', durationMs: Math.round(performance.now() - providerStarted), model: provider.modelId ?? session.config.model ?? 'selected-local-model' })
      if (reply.execution?.taskCheckpoint && provider.modelId) reply.execution.taskCheckpoint.model = provider.modelId
      if (this.generation !== generation) return
      const contextStarted = performance.now()
      const context = await this.hooks.prepare?.(session, messages, generation.abort.signal)
      if (this.hooks.resource === 'local') log('ai.local_chat_pipeline', { traceId: reply.id, stage: 'context-preparation-complete', durationMs: Math.round(performance.now() - contextStarted), tools: context?.projectTools?.definitions.length ?? 0, repositoryCharacters: context?.repositoryText.length ?? 0 })
      if (resuming) context?.projectTools?.continuation?.()
      if (context?.sources) reply.sources = context.sources
      if (context?.notice) this.state.contextNotice = [this.state.contextNotice, context.notice].filter(Boolean).join(' ')
      if (this.generation !== generation) return
      let complete = false
      for await (const chunk of provider.streamMessage(messages, { signal: generation.abort.signal, effort: session.config.effort, context, contextSettings: session.config.contextSettings, checkpoint, storeArtifact: this.hooks.storeArtifact,
        traceId: reply.id,
        onLocalInferenceTrace: event => log('ai.local_inference_trace', { traceId: reply.id, fromInputMs: Math.round(performance.now() - generation.startedAt), ...event }),
        executionId: reply.id,
        diagnosticCounts: () => ({
          completedTools: reply.execution?.activities.filter((activity) => activity.status === 'complete').length ?? 0,
          fileChanges: new Set(reply.execution?.activities.flatMap((activity) => activity.changes?.filter((change) => change.status === 'applied').map((change) => change.path) ?? []) ?? []).size,
        }),
        onStreamPhase: (phase) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.streamPhase = phase; reply.execution.updatedAt = Date.now(); this.publish()
        },
        onStreamDiagnostic: (diagnostic) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.streamDiagnostics = [...(reply.execution.streamDiagnostics ?? []), diagnostic].slice(-20)
          reply.execution.updatedAt = Date.now(); this.save(); this.publish()
        },
        permissionMode: session.config.agentMode ?? 'ask',
        onBudget: (notice) => {
          if (this.generation !== generation || !reply.execution || reply.execution.budgetNotice === notice) return
          reply.execution.budgetNotice = notice; this.publish()
        },
        onBudgetSummary: (summary) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.budgetSummary = summary
          reply.execution.updatedAt = Date.now(); this.save(); this.publish()
        },
        requestApproval: (title, description, signal, changes, rememberScope) => this.approve({ title, description, changes, rememberScope }, signal),
        onUsage: (usage) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.contextUsage = usage; reply.execution.updatedAt = Date.now(); this.publish()
        },
        onRecovery: (recovery) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.recovery = recovery
          if (reply.execution.taskCheckpoint) reply.execution.taskCheckpoint.pendingActions = [...recovery.pendingTools.map((tool) => `Unexecuted interrupted request: ${tool}`), 'Finish the original request; review current files and verification before further changes.']
          this.checkpointTask(reply, session)
          reply.execution.updatedAt = Date.now(); this.phase('thinking'); this.save(); this.publish()
        },
        onCheckpoint: (input) => {
          if (this.generation !== generation || !completeMessages.length) return
          session.contextCheckpoint = { fingerprint: contextFingerprint(session, completeMessages), coveredThrough: completeMessages.at(-1)!.id, savedAt: Date.now(), input: input as unknown as Array<Record<string, unknown>> }
          this.save()
        },
      })) {
        if (this.generation !== generation) return
        if (chunk.type === 'done') { complete = true; break }
        if (chunk.type === 'activity') {
          const existing = reply.execution?.activities.find((activity) => activity.id === chunk.id)
          if (!existing && reply.execution && reply.execution.activities.length < 500) {
            reply.execution.activities.push({ id: chunk.id, tool: chunk.tool, label: chunk.label, status: chunk.status, startedAt: Date.now(), ...(chunk.status !== 'running' ? { finishedAt: Date.now() } : {}) })
            this.timeline(reply, 'activity', undefined, chunk.id)
          } else if (existing) {
            existing.tool = chunk.tool
            existing.label = chunk.label
            existing.status = chunk.status
            if (chunk.status !== 'running') existing.finishedAt ??= Date.now()
          }
          if (reply.execution) reply.execution.updatedAt = Date.now()
          if (chunk.status === 'running' && this.state.phase !== 'thinking') this.phase('thinking')
          if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 80)
          continue
        }
        if (chunk.type === 'artifact') {
          reply.artifacts = [...(reply.artifacts ?? []), chunk.artifact].slice(0, 32)
          if (reply.execution) reply.execution.updatedAt = Date.now()
          this.publish(true); this.save()
          continue
        }
        if (reply.content.length + chunk.text.length > MAX_RESPONSE_LENGTH) throw new ChatError('The response reached Athena’s display limit. Ask for a shorter answer.')
        reply.content += chunk.text
        this.timeline(reply, 'text', chunk.text)
        if (reply.execution) reply.execution.updatedAt = Date.now()
        if (this.state.phase !== 'speaking') this.phase('speaking')
        if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 40)
      }
      if (this.generation !== generation) return
      if (!complete) throw new ChatError('The response ended unexpectedly. Please retry.')
      await context?.projectTools?.validateCompletion?.()
      if (this.generation !== generation) return
      reply.content = stripTrailingSourcesSection(reply.content)
      const timeline = reply.execution?.timeline
      if (timeline?.length) {
        let trailingTextStart = timeline.length
        while (trailingTextStart > 0 && timeline[trailingTextStart - 1].kind === 'text') trailingTextStart--
        if (trailingTextStart < timeline.length) {
          const trailingText = timeline.slice(trailingTextStart)
          const combined = trailingText.map((event) => event.text ?? '').join('')
          const visible = stripTrailingSourcesSection(combined)
          if (visible !== combined) timeline.splice(trailingTextStart, trailingText.length, ...(visible ? [{ ...trailingText[0], text: visible }] : []))
        }
      }
      reply.status = 'complete'
      if (reply.execution) reply.execution.streamPhase = undefined
      if (reply.execution?.taskCheckpoint) reply.execution.taskCheckpoint.pendingActions = []
      log('ai.request_completed')
    } catch (error) {
      if (this.generation !== generation) return
      reply.status = 'error'
      if (reply.execution) reply.execution.streamPhase = 'paused'
      reply.error = error instanceof ChatError ? error.userMessage : 'Athena could not complete the request. Please retry.'
      if (error instanceof ChatError && error.code === 'auth-reconnect' && reply.execution) {
        reply.execution.status = 'waiting-auth'
        if (reply.execution.taskCheckpoint) reply.execution.taskCheckpoint.pendingActions = ['Reconnect the same ChatGPT account, inspect current project state, then continue unfinished work without repeating completed changes.']
        this.timeline(reply, 'status', 'ChatGPT authorization needs reconnection. Completed operations and file changes remain recorded.')
      } else if (error instanceof ChatError && error.code === 'auth-refreshed') this.timeline(reply, 'status', 'ChatGPT authorization was renewed. Continue the unfinished task from the recorded results.')
      if (reply.execution?.activities.length) {
        const finished = reply.execution.activities.filter((activity) => activity.status === 'complete').length
        const modified = new Set(reply.execution.activities.flatMap((activity) => activity.changes?.filter((change) => change.status === 'applied').map((change) => change.path) ?? [])).size
        reply.error += ` ${finished} completed operations; ${modified} recorded file change${modified === 1 ? '' : 's'}. See Activity for results and remaining verification before resuming.`
      }
      this.state.error = reply.error
      log('ai.request_failed')
    } finally {
      clearTimeout(generation.timeout)
      if (this.generation === generation) {
        if (reply.execution) { for (const activity of reply.execution.activities) if (activity.status === 'running') { activity.status = 'cancelled'; activity.finishedAt = Date.now(); activity.summary = 'The provider did not report a final status for this operation.' }; this.checkpointTask(reply, this.current()); if (reply.execution.recovery) reply.execution.recovery.continuing = false; reply.execution.finishedAt = Date.now(); if (reply.execution.status !== 'waiting-auth') reply.execution.status = reply.status === 'complete' ? 'complete' : 'error' }
        generation.abort.abort()
        generation.releaseResource?.(); generation.releaseResource = undefined
        this.generation = undefined
        this.applyPendingCursorModel()
        this.phase('idle'); this.publish(true)
        this.hooks.taskEnded?.(this.current().id, reply)
        const session = this.current()
        if (!(this.hooks.isViewed?.(session.id) ?? session.id === this.library.activeId)) {
          session.unreadCompletion = reply.status === 'complete' ? 'complete' : 'failed'
          const event = { sessionId: session.id, title: session.title, executionId: reply.id, status: session.unreadCompletion, unreadCount: this.unreadCount() }
          this.hooks.unreadChanged?.(event.unreadCount)
          this.hooks.executionEnded?.(event)
          this.publish(true)
          this.save()
        }
        if (generation.controllerReserved) this.running--
        this.drain()
      }
    }
  }
  stop(message?: string, failed = false): ChatResult {
    const generation = this.generation
    if (!generation) return { ok: true }
    this.generation = undefined
    generation.abort.abort(); clearTimeout(generation.timeout)
    generation.releaseResource?.(); generation.releaseResource = undefined
    if (generation.queued) {
      const index = this.queue.findIndex(entry => entry.id === this.current().id)
      if (index >= 0) this.queue.splice(index, 1)
    }
    const reply = this.state.messages.find((entry) => entry.id === generation.id)
    if (reply) { reply.status = failed ? 'error' : 'stopped'; reply.error = message }
    if (reply?.execution) {
      // Local providers share the guarded filesystem executor. Preserve the
      // same partial-change summary for Ollama and future local runtimes; the
      // model identifier must not decide whether cancellation is reported.
      const localExecution = this.hooks.resource === 'local' || this.hooks.origin === 'athena-local' || this.current().config.model?.startsWith('mlx:')
      if (!failed && localExecution && this.current().workspaces.length) {
        const applied = [...new Set(reply.execution.activities.flatMap(activity => (activity.changes ?? []).filter(change => change.status === 'applied').map(change => change.path)))]
        const summary = applied.length
          ? `Partially completed; remaining operations cancelled. Applied file changes: ${applied.slice(0, 12).join(', ')}${applied.length > 12 ? ' (see Activity for all changes)' : ''}. Review Activity for verification results; completed work is preserved.`
          : 'Cancelled. Pending operations were stopped. No completed file changes are recorded in Activity.'
        reply.content = [reply.content.trimEnd(), summary].filter(Boolean).join('\n\n')
      }
      this.checkpointTask(reply, this.current())
      if (reply.execution.recovery) reply.execution.recovery.continuing = false
      reply.execution.finishedAt = Date.now(); reply.execution.status = failed ? 'error' : 'cancelled'; reply.execution.streamPhase = 'paused'; reply.execution.approval = undefined
      for (const activity of reply.execution.activities) if (activity.status === 'running') { activity.status = 'cancelled'; activity.finishedAt = Date.now() }
    }
    this.state.error = message ?? null
    this.applyPendingCursorModel()
    this.phase('idle'); this.publish(true)
    if (reply) this.hooks.taskEnded?.(this.current().id, reply)
    if (generation.controllerReserved) { this.running--; this.drain() }
    log('ai.request_stopped')
    return { ok: true }
  }
  stopSession(id: string, message?: string, failed = false): ChatResult { return this.executionScope.run(id, () => this.stop(message, failed)) }
  stopAll(message?: string): void {
    this.drainingPaused = true
    try { for (const id of [...this.generations.keys()]) this.stopSession(id, message) }
    finally { this.drainingPaused = false; this.drain() }
  }
  clear(): ChatResult {
    this.clearHandsFreeContext()
    this.stop()
    this.current().messages = []; this.current().contextCheckpoint = undefined; this.state.messages = this.current().messages; this.current().attachments = []; this.current().draft = ''; this.state.error = null
    this.publish()
    return { ok: true }
  }
  dispose(): void {
    this.disposed = true
    this.cancelHandsFreeReply()
    this.stopAll()
    for (const timer of this.publishTimers.values()) clearTimeout(timer)
    this.publishTimers.clear()
    this.save()
    this.state.messages = []
  }
}
