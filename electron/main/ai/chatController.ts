import type { RememberedPermissions } from '../permissions/rememberedPermissions'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { chatInputSchema, emptyChatSnapshot, MAX_RESPONSE_LENGTH, stripTrailingSourcesSection, type ChatMessage, type ChatPhase, type ChatResult, type ChatSnapshot } from '../../../shared/chat'
import { modelCapabilities, sessionCommandSchema, type Attachment, type ConversationConfig, type WorkspaceReference } from '../../../shared/conversations'
import { newConversation, type Conversation, type ConversationLibrary, type ConversationStorage } from './conversationRepository'
import { fitConversationHistory, recentContext } from './contextBudget'
import type { DeterministicActionResult, PreparedContext } from './AIProvider'
import { ChatError, type AIProvider } from './AIProvider'
import { log } from '../logger'
import type { AgentActivity, AgentApproval, ChangePreview } from '../../../shared/agent'
import type { ResponseInput } from 'openai/resources/responses/responses'
import type { ActionSpeechEvent } from '../voice/actionNarrator'
import { handsFreeReplySchema, type LocalInferenceTrace } from '../../../shared/handsFree'
import type { SlashCommandMeta } from '../../../shared/slashCommands'
import { contextDefaults, contextModelKey, type ContextSettings } from '../../../shared/context'
import { voiceReasoningEffort } from '../../../shared/voiceResponse'
import type { SubagentRun } from '../../../shared/subagents'
import { workflowSubagentRequirements } from './subagentWorkflow'
import type { AIOwnership, ConversationOrigin } from '../../../shared/aiOwnership'
import type { AutomationProgress } from '../../../shared/automation'
import { localInferenceSlots } from './localInferenceSlots'
import { choiceInteractionSchema, parseChoiceInteraction } from '../../../shared/chatInteraction'
import { ContinuationController } from './continuationController'
import { classifyOperation } from './operationRisk'
import { StreamFault } from './streamRecovery'
import type { StreamFailureKind } from '../../../shared/streamDiagnostics'

function thirdPartyEffortKey(config: ConversationConfig): string | null {
  return config.accountRoute?.provider === 'third-party' && config.model ? `${config.accountRoute.accountId}:${config.model}` : null
}

function rememberThirdPartyEffort(config: ConversationConfig): void {
  const key = thirdPartyEffortKey(config)
  if (key) config.thirdPartyEfforts = { ...config.thirdPartyEfforts, [key]: config.effort }
}

function contextFingerprint(session: Conversation, messages: ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify({ model: session.config.model, accountRoute: session.config.accountRoute, effort: session.config.effort, mode: session.config.agentMode, workspaces: session.workspaces, messages: messages.map(({ id, content, attachments }) => ({ id, content, attachments })) })).digest('hex')
}

import { z } from 'zod'
import { isVideoOperation, mediaOperations, type MediaCommand } from '../../../shared/mediaGeneration'
import { MediaService, type MediaCreate } from '../media/mediaService'
import { MediaFailure } from '../media/protocols'
import type { ProjectTools } from './AIProvider'

interface ChatHooks {
  contextDefaults?(): ContextSettings
  rememberedPermissions?: RememberedPermissions
  origin?: ConversationOrigin
  provider(config: ConversationConfig, options?: { isolated: boolean; coding: boolean; purpose?: 'voice-planning' }): Promise<AIProvider>
  usageProviderId?(provider: AIProvider): string
  childModel?(config: ConversationConfig): import('../../../shared/unifiedAccounts').AccountModel | undefined
  accountIdentity?(): Promise<string | null>
  useCheckpoint?(): boolean
  effectiveModel?(): string | null
  modelSupportsEffort?(model: string | null, effort: ConversationConfig['effort'], route?: ConversationConfig['accountRoute']): boolean | undefined
  nativeExecution?(session:Conversation):boolean
  nativeHistory?(session:Conversation):Promise<Array<{turn:import('./codexProtocol/v2/Turn').Turn;items:import('./codexProtocol/v2/ThreadItemEntry').ThreadItemEntry[]}>>
  prepareNative?(session: Conversation, messages: ChatMessage[], signal: AbortSignal): Promise<{cwd:string;writableRoots:string[];computer?:ProjectTools;context:PreparedContext}>
  prepare?(session: Conversation, messages: ChatMessage[], signal: AbortSignal, voiceOnly?: boolean): Promise<PreparedContext>
  voiceApproval?(request: Omit<AgentApproval, 'id'>, signal: AbortSignal): Promise<boolean>
  voiceActionAudit?(tool: string, status: 'started' | 'completed' | 'failed' | 'cancelled', durationMs?: number): void
  resolveVoiceCommand?(session: Conversation, request: string, requestId: string, signal: AbortSignal): Promise<DeterministicActionResult>
  resolveComputerCommand?(session: Conversation, request: string, requestId: string, signal: AbortSignal): Promise<DeterministicActionResult>
  authorized?(id: string): boolean
  workspaceRoot?(id: string): Promise<string>
  workspaceOnly?(): boolean
  changed(snapshot: ChatSnapshot): void
  phase(phase: ChatPhase, ownership?: AIOwnership, source?: 'floating-voice'): void
  beforeAction?(event: ActionSpeechEvent): Promise<string | undefined>
  taskEnded?(sessionId: string, message: ChatMessage): void
  voiceTimeoutMs?(): number
  adaptiveVoiceReasoning?(): boolean
  resolveCommand?(session: Conversation, command: SlashCommandMeta, text: string, signal: AbortSignal): Promise<string>
  maxConcurrent?(): number
  resource?: 'local' | 'remote'
  isViewed?(sessionId: string): boolean
  mediaChanged?(job: import('../../../shared/mediaGeneration').MediaJob):void
  executionEnded?(event: { sessionId: string; title: string; executionId: string; status: 'complete' | 'failed'; unreadCount: number }): void
  approvalChanged?(event: { sessionId: string; title: string; approvalId: string; action: 'required' | 'resolved'; summary?: string; projectId?: string; projectName?: string; taskId?: string }): void
  unreadChanged?(count: number): void
  storeArtifact?(input: { name: string; mimeType: string; bytes: Uint8Array; provider?: string }): Promise<import('../../../shared/chat').GeneratedArtifact>
}
interface Generation { nativeConfig?: ConversationConfig; id: string; abort: AbortController; timeout?: ReturnType<typeof setTimeout>; queued: boolean; controllerReserved?: boolean; releaseResource?: () => void; startedAt: number; activityTimeout?: boolean; resumeTimeout?: () => void }
export class ChatController {
  private contextPolicy(session = this.current()): ContextSettings { return { ...contextDefaults(), ...this.hooks.contextDefaults?.(), ...session.config.contextSettings } }
  private readonly executionScope = new AsyncLocalStorage<string>()
  private readonly states = new Map<string, ChatSnapshot>()
  private readonly generations = new Map<string, Generation>()
  private readonly publishTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly approvals = new Map<string, { id: string; settled: Promise<void>; resolve(allow: boolean, remember?: boolean): void }>()
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
  private set approval(value: { id: string; settled: Promise<void>; resolve(allow: boolean, remember?: boolean): void } | undefined) { if (value) this.approvals.set(this.scopedId, value); else this.approvals.delete(this.scopedId) }
  private get publishTimer() { return this.publishTimers.get(this.scopedId) }
  private set publishTimer(value: ReturnType<typeof setTimeout> | undefined) { if (value) this.publishTimers.set(this.scopedId, value); else this.publishTimers.delete(this.scopedId) }
  private disposed = false
  private voiceMessages: ChatMessage[] = []
  private voiceSearchPreview?: { sessionId: string; message: ChatMessage }
  private cursorModelNotice?: string
  private voiceActivities = new Map<string, { tool: string; startedAt: number }>()
  private voiceAbort?: AbortController
  private voicePause?:{wait:Promise<void>;release:()=>void}
  setVoicePaused(paused:boolean) {
    if(!this.voiceAbort || this.voiceAbort.signal.aborted)return false
    if(paused && !this.voicePause){
      let release!:()=>void
      const wait=new Promise<void>(resolve=>{release=resolve})
      this.voicePause={wait,release}
    }else if(!paused){this.voicePause?.release();this.voicePause=undefined}
    return true
  }
  async beforeVoiceStep(signal:AbortSignal) {
    signal.throwIfAborted()
    const pause = this.voicePause
    if (pause) await new Promise<void>((resolve, reject) => {
      const cancelled = () => reject(new ChatError('Voice response cancelled.'))
      signal.addEventListener('abort', cancelled, {once:true})
      pause.wait.then(() => { signal.removeEventListener('abort', cancelled); resolve() })
      if (signal.aborted) cancelled()
    })
    signal.throwIfAborted()
  }
  private voiceOwnership?: AIOwnership
  private library: ConversationLibrary
  private mediaFocus?: { sessionId: string; messageId: string; requestedAt: number }
  focusMedia(messageId: string): boolean {
    const session = this.getSession(this.library.activeId)
    const index = session?.messages.findIndex(m=>m.id===messageId && (m.mediaJob || m.artifacts?.length))
    if (!session || index === undefined || index < 0) return false
    this.pageSize = Math.max(this.pageSize,session.messages.length-index)
    this.mediaFocus = { sessionId:session.id, messageId, requestedAt:Date.now() }
    this.publish(true)
    return true
  }
  private pageSize = 60
  private saveTimer?: ReturnType<typeof setTimeout>
  private storageFailed = false
  private childCancellations = new Map<string, { sessionId: string; cancel(): void }>()
  private permissionVersions = new Map<string, number>()
  childModel(config: ConversationConfig) { return this.hooks.childModel?.(config) }
  async childProvider(config: ConversationConfig, accountId: string | null): Promise<AIProvider> {
    if (this.hooks.resource === 'local' && config.accountRoute) throw new ChatError('This local conversation cannot launch an online account through its local runtime. Choose Inherit parent model for local workers, or start the worker from an online conversation.')
    if ((await this.hooks.accountIdentity?.() ?? null) !== accountId) throw new ChatError('The selected account changed. Continue with the original account before launching a sub-agent.')
    return this.hooks.provider(config, { isolated: true, coding: true })
  }
  activeExecution(): ChatMessage | undefined { return this.state.messages.find((entry) => entry.id === this.generation?.id) }
  recordSearchAttempts(attempts: import('../../../shared/searchOutcome').SearchAttempt[]): void {
    const checkpoint = this.activeExecution()?.execution?.taskCheckpoint
    if (!checkpoint) return
    checkpoint.searchAttempts = attempts.slice(-24)
    checkpoint.updatedAt = Date.now()
    this.save()
  }
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
    this.publish()
    if (activity.status !== 'running') this.save()
  }
  async beforeAction(tool: string, input: unknown, signal: AbortSignal): Promise<void> {
    const generation = this.generation
    signal.throwIfAborted()
    if (!generation) {await this.beforeVoiceStep(signal);return}
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
    checkpoint.verificationOperationIds = execution.activities.filter((activity) => activity.status === 'complete' && /^(run_|execute_command|inspect_errors)/.test(activity.tool)).map((activity) => activity.id)
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
        const branch = typeof output === 'string' ? /^## ([A-Za-z0-9._/-]{1,200})(?:\s|$)/.exec(output)?.[1]?.split('...')[0] : undefined
        if (branch) checkpoint.lastKnownBranch = branch
      } catch { /* Older activity records may not have structured Git output. */ }
    }
    checkpoint.requiredApprovalId = execution.approval?.id
    checkpoint.continuationAttempts = Math.max(checkpoint.control?.continuations ?? 0, execution.recovery?.reason === 'max_output_tokens' ? execution.recovery.attempts : 0)
    checkpoint.provider = execution.providerId
    checkpoint.model = execution.modelId ?? checkpoint.model
    checkpoint.resumable = this.contextPolicy(session).safeTaskRecovery && (reply.status !== 'complete' || checkpoint.control?.status === 'blocked' || checkpoint.control?.status === 'waiting-user') && checkpoint.pendingActions.length > 0
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
    if (this.voiceAbort && !this.generation) {
      this.voiceAbort.signal.throwIfAborted()
      const id = randomUUID(), startedAt = Date.now()
      this.voiceActivities.set(id, { tool, startedAt })
      const progress = this.state.automationProgress ?? { id: this.voiceOwnership?.correlationId ?? randomUUID(), task: 'Voice automation', phase: 'running' as const, cancelTarget: 'voice' as const, startedAt, updatedAt: startedAt, steps: [] }
      if (progress.steps.length >= 64) throw new ChatError('Voice automation reached its activity limit. Review completed actions before continuing.')
      progress.steps.push({ id, label: tool.replaceAll('_', ' '), status: 'running', startedAt })
      progress.phase = 'running'; progress.updatedAt = startedAt
      this.setAutomationProgress(progress)
      this.hooks.voiceActionAudit?.(tool, 'started')
      return id
    }
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
    const bounded = output.slice(0, 70_000)
    if (activity.fullOutput === bounded) return
    activity.fullOutput = bounded
    this.generation?.resumeTimeout?.()
    if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 120)
  }
  updateActivityLabel(id: string, label: string): void {
    const activity = this.state.messages.find((entry) => entry.id === this.generation?.id)?.execution?.activities.find((entry) => entry.id === id)
    if (!activity || activity.status !== 'running') return
    activity.label = label.slice(0, 300)
    this.publish()
  }
  finishActivity(id: string, result: Pick<AgentActivity, 'status' | 'summary' | 'changes' | 'fullOutput'>): void {
    const voice = this.voiceActivities.get(id)
    if (voice) {
      const progress = this.state.automationProgress, step = progress?.steps.find(item => item.id === id)
      const status = result.status === 'complete' ? 'complete' : result.status === 'cancelled' ? 'cancelled' : 'failed'
      if (progress && step) { step.status = status; step.finishedAt = Date.now(); step.message = status === 'complete' ? 'Verified tool result received.' : 'Operation did not complete. Review the returned error.'; progress.phase = progress.steps.some(item => item.status === 'running') ? 'running' : status; progress.updatedAt = Date.now(); this.setAutomationProgress(progress) }
      this.hooks.voiceActionAudit?.(voice.tool, status === 'complete' ? 'completed' : status, Date.now() - voice.startedAt)
      this.voiceActivities.delete(id)
      return
    }
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
  private fullAccessApprovalAllowed(request: Omit<AgentApproval, 'id'>): boolean {
    const session = this.current(), workspace = session.workspaces[0]
    return request.fullAccessEligible !== false && !!workspace && session.config.agentMode === 'full-access' && session.config.fullAccessWorkspaceId === workspace.id && this.hooks.authorized?.(workspace.id) === true && this.hooks.workspaceOnly?.() === true
  }
  async approveVoiceOperation(request: Omit<AgentApproval, 'id'>, signal: AbortSignal, manual: () => Promise<boolean>): Promise<boolean> {
    signal.throwIfAborted()
    if (this.generation) return false
    if (this.fullAccessApprovalAllowed(request)) { log('permission.automatic_approval', { sessionId: this.current().id, mode: 'full-access', source: 'voice' }); return true }
    const accepted = await manual()
    return accepted && !signal.aborted
  }
  approve(request: Omit<AgentApproval, 'id'>, signal: AbortSignal): Promise<boolean> {
    const session = this.current()
    const execution = session.messages.find((entry) => entry.id === this.generation?.id)?.execution
    if (signal.aborted) return Promise.resolve(false)
    const pending = this.approval
    if (pending) {
      const owner = this.generation
      return new Promise(resolve => {
        const cancel = () => resolve(false)
        signal.addEventListener('abort', cancel, { once: true })
        void pending.settled.then(() => {
          signal.removeEventListener('abort', cancel)
          resolve(!signal.aborted && this.generation === owner ? this.approve(request, signal) : false)
        })
      })
    }
    if (!execution) return this.voiceAbort && !this.voiceAbort.signal.aborted ? this.hooks.voiceApproval?.(request, signal) ?? Promise.resolve(false) : Promise.resolve(false)
    const workspace = session.workspaces[0]
    const record = (decision: 'automatic' | 'manual' | 'rejected') => {
      if ((execution.permissionDecisions?.length ?? 0) < 1000) {
        (execution.permissionDecisions ??= []).push({ id: randomUUID(), title: request.title.slice(0, 300), decision, at: Date.now(), ...(workspace ? { workspaceId: workspace.id } : {}) })
        execution.updatedAt = Date.now()
        this.publish(); this.save()
      }
    }
    const rememberScope = this.hooks.rememberedPermissions?.eligible(request.rememberScope)
    if (rememberScope && this.hooks.rememberedPermissions?.allows(rememberScope, { sessionId: session.id, origin: this.hooks.origin, taskId: this.generation?.id })) { record('automatic'); return Promise.resolve(true) }
    if (this.fullAccessApprovalAllowed(request)) {
      log('permission.automatic_approval', { sessionId: session.id, workspaceId: workspace!.id, operation: request.title, mode: 'full-access' })
      record('automatic')
      return Promise.resolve(true)
    }
    const id = randomUUID(); execution.approval = { ...request, rememberScope, id }; execution.updatedAt = Date.now()
    const generation = this.generation
    if (generation?.activityTimeout) clearTimeout(generation.timeout)
    this.hooks.approvalChanged?.({ sessionId: session.id, title: session.title, approvalId: id, action: 'required', summary: request.title, projectId: session.workspaces[0]?.id, projectName: session.workspaces[0]?.name, taskId: this.generation?.id })
    return new Promise((resolve) => {
      let settled = false
      let notify!: () => void
      const answered = new Promise<void>(done => { notify = done })
      const finish = (allow: boolean, remember = false) => {
        if (settled) return
        if (allow && remember) {
          if (!rememberScope || !this.hooks.rememberedPermissions || signal.aborted) throw new Error('This permission cannot be remembered.')
          const current = this.hooks.rememberedPermissions.eligible(rememberScope)
          if (JSON.stringify(current) !== JSON.stringify(rememberScope)) throw new Error('Permission scope changed. Deny this request and retry.')
          this.hooks.rememberedPermissions.grant(rememberScope)
        }
        settled = true
        signal.removeEventListener('abort', cancelled); if (this.approval?.id === id) this.approval = undefined; execution.approval = undefined; this.hooks.approvalChanged?.({ sessionId: session.id, title: session.title, approvalId: id, action: 'resolved' }); generation?.resumeTimeout?.(); if (!signal.aborted) record(allow ? 'manual' : 'rejected'); this.publish(); notify(); resolve(allow) }
      const cancelled = () => finish(false)
      this.approval = { id, settled: answered, resolve: finish }; signal.addEventListener('abort', cancelled, { once: true }); this.publish()
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
  private media?: MediaService
  private mediaHost = {
    session: (id: string) => this.getSession(id),
    persist: (session: Conversation, message: ChatMessage, notify?: boolean) => {
      message.ownership ??= {origin:this.hooks.origin??'online-chat',sessionId:session.id,correlationId:message.id}
      session.updatedAt = Date.now()
      if (notify && !(this.hooks.isViewed?.(session.id) ?? session.id === this.library.activeId)) {
        session.unreadCompletion = message.mediaJob?.status === 'ready' ? 'complete' : 'failed'
        const event = { mediaMessageId:message.id, sessionId: session.id, title: session.title, executionId: message.id, status: session.unreadCompletion, unreadCount: this.unreadCount() }
        this.hooks.unreadChanged?.(event.unreadCount)
        this.hooks.executionEnded?.(event)
      }
      if (!this.save()) throw new MediaFailure('Media state could not be saved. Check disk space before retrying.')
      if(message.mediaJob)this.hooks.mediaChanged?.(message.mediaJob)
      this.publish(true)
    },
  }
  attachMedia(service: MediaService): void {
    this.media = service
    for (const s of this.library.sessions) service.recover(this.mediaHost, s)
  }
  mediaIntent(text: string) { return this.media?.intent(this.current(), text) }
  async importMedia(sessionId:string,file:import('../media/protocols').MediaFile,name:string,parentId?:string){
    const session=this.getSession(sessionId)
    if(!this.media||!session||this.selectedSessionId()!==sessionId)throw new ChatError('Select the source conversation again.')
    await this.media.importSource(this.mediaHost,session,file,name,parentId)
    return {ok:true}
  }
  mediaCommand(command: MediaCommand) {
    if (!this.media) throw new ChatError('Media generation is unavailable.')
    if (command.action === 'catalog') return this.media.catalog(command.sessionId ? this.getSession(command.sessionId) ?? this.current() : this.current(),command.includedOnly).then(catalog => ({ ...catalog, history:this.library.sessions.flatMap(s=>s.messages.filter(m=>m.mediaJob).map(m=>({id:m.id,date:m.createdAt,provider:m.mediaJob!.provider??'Routing',status:m.mediaJob!.status}))).sort((a,b)=>b.date-a.date).slice(0,30) }))
    const session = this.getSession(command.sessionId)
    if (!session || command.sessionId !== this.selectedSessionId()) throw new ChatError('Switch to the target conversation first.')
    if (command.action === 'compose') {
      if (command.operation && command.mode && isVideoOperation(command.operation) !== (command.mode === 'video')) throw new ChatError('The requested operation does not match the generation mode.')
      if (command.parentId && !session.messages.some(m => m.artifacts?.some(a => a.id === command.parentId) || m.attachments?.some(a => a.id === command.parentId))) throw new ChatError('Source media is unavailable in this conversation.')
      session.config.mediaMode = command.mode
      session.config.mediaParentId = command.mode ? command.parentId : undefined
      session.config.mediaOperation = command.mode && command.operation && !['image','video'].includes(command.operation) ? command.operation as NonNullable<typeof session.config.mediaOperation> : undefined
      this.publish()
      return { ok: true }
    }
    if(command.action==='video-metadata')return this.media.videoMetadata(this.mediaHost,session,command).then(()=>({ok:true}))
    if(command.action==='frame')return this.importMedia(session.id,{bytes:command.bytes,mime:'image/png'},'Video frame.png',command.parentId)
    if(command.action==='remove-asset')return this.media.removeAsset(this.mediaHost,session,command.id).then(()=>({ok:true}))
    if(command.action==='import')throw new ChatError('Select a source file using the file picker.')
    if (command.action === 'generate') return this.createMediaMessage(session, command)
    const message = session.messages.find(m => m.id === command.messageId)
    if (!message) throw new ChatError('The media request no longer exists.')
    if(command.action==='cancel-provider')return this.media.cancelProvider(this.mediaHost,session,message).then(()=>({ok:true}))
    this.media.control(this.mediaHost, session, message, command.action, command.route)
    return { ok: true }
  }
  private createMediaMessage(session: Conversation, request: MediaCreate): ChatResult {
    if (!this.media || this.disposed || this.generation || session.messages.length >= 9998) return {ok:false,message:'Wait for the active response or open a new conversation.'}
    if (session.messages.some(m => m.requestId === request.requestId)) return {ok:true}
    const user: ChatMessage = { id: randomUUID(), requestId: request.requestId, role:'user', content:request.prompt, createdAt:Date.now(),status:'complete',attachments:session.attachments.splice(0) }
    session.messages.push(user)
    if (session.title === 'New conversation') session.title = request.prompt.slice(0,72)
    session.draft = ''
    try { this.media.create(this.mediaHost, session, request); return {ok:true} }
    catch(e){ session.messages.push({id:randomUUID(),role:'assistant',content:e instanceof MediaFailure?e.message:'Media generation could not start.',createdAt:Date.now(),status:'error'});this.publish();return {ok:true} }
  }
  mediaTools(session:Conversation,request:ChatMessage):ProjectTools|undefined {
    if(!this.media)return
    const schema=z.object({operation:z.enum(mediaOperations),prompt:z.string().trim().min(1).max(12000)}).strict()
    const { $schema, ...parameters }=z.toJSONSchema(schema)
    return {definitions:[{name:'generate_media',description:'Generate or edit an image, animated GIF, or video for this conversation. Returns a tracked generation request. Report completion only after a verified media artifact exists.',parameters}],
      assertAccess:()=>{if(!this.getSession(session.id))throw new ChatError('Conversation unavailable.')},parallelSafe:()=>false,
      execute:async(name,input,signal)=>{
        if(name!=='generate_media')throw new ChatError('Unknown media tool.')
        const args=schema.parse(input), target=this.getSession(session.id)
        if(!target||!target.messages.some(m=>m.id===request.id))throw new ChatError('The generation request is no longer active.')
        const previous=target.messages.find(m=>m.mediaJob?.requestId===request.id)
        if(previous)return JSON.stringify({messageId:previous.id,status:previous.mediaJob!.status})
        const allowed=await this.approve({title:'Generate media for this conversation?',description:args.prompt,fullAccessEligible:false},signal)
        if(!allowed)throw new ChatError('Media generation declined.')
        signal.throwIfAborted()
        const m=this.media!.create(this.mediaHost,target,{requestId:request.id,...args,options:{}})
        return JSON.stringify({messageId:m.id,status:m.mediaJob!.status})
      }}
  }
  selectedSessionId(): string { return this.library.activeId }
  hasActiveExecutions(): boolean { return this.generations.size > 0 }
  workspaceExecuting(workspaceId: string): boolean {
    return this.library.sessions.some(session => session.workspaces.some(workspace => workspace.id === workspaceId)
      && (this.generations.has(session.id) || [...this.childCancellations.values()].some(child => child.sessionId === session.id)))
  }
  invalidateWorkspaceContext(workspaceId: string): void {
    for (const session of this.library.sessions) if (session.workspaces.some(workspace => workspace.id === workspaceId)) session.contextCheckpoint = undefined
    this.save()
  }
  interruptWorkspace(workspaceId: string, message: string): void {
    this.drainingPaused = true
    try {
      for (const session of this.library.sessions) if (session.workspaces.some(workspace => workspace.id === workspaceId)) {
        for (const child of this.childCancellations.values()) if (child.sessionId === session.id) child.cancel()
        this.stopSession(session.id, message, true)
      }
      this.invalidateWorkspaceContext(workspaceId)
    } finally { this.drainingPaused = false; this.drain() }
  }
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
  async proposeComputerAction(prompt:string, signal:AbortSignal,format:{instructions:string;schema:Record<string,unknown>}):Promise<string> {
    const session=this.current()
    const provider=await this.hooks.provider(session.config,{isolated:true,coding:false,purpose:'voice-planning'})
    if(provider.nativeAgent)throw new ChatError('Select a model that supports planning without an autonomous coding environment, or use a local planning model.')
    const message:ChatMessage={id:randomUUID(),role:'user',status:'complete',createdAt:Date.now(),content:prompt}
    let output=''
    for await(const chunk of provider.streamMessage([message],{signal,effort:session.config.effort,structuredOutput:format.schema,
      context:{attachments:[],sources:[],repositoryText:'',realtimeInstructions:format.instructions}})){
      signal.throwIfAborted()
      if(chunk.type==='text')output+=chunk.text
      if(output.length>8000)throw new ChatError('The native planner exceeded its response limit.')
      if(chunk.type==='done')return output
    }
    throw new ChatError('The native planning response was interrupted.')
  }
  private applyPendingCursorModel(): void {
    const pending = this.current().config.cursorPendingModel
    if (pending) this.selectCursorModel(pending)
  }
  snapshot(): ChatSnapshot {
    const session = this.getSession(this.library.activeId)!
    const state = this.states.get(session.id) ?? { ...emptyChatSnapshot(), messages: session.messages }
    return structuredClone({ ...state, nativeCodex:session.nativeCodex, codexAccess:session.codexAccess, mediaFocus: this.mediaFocus?.sessionId===session.id && Date.now()-this.mediaFocus.requestedAt<15000 ? this.mediaFocus : undefined, revision: this.revision, error: this.storageFailed ? 'Saved history is unreadable. New changes cannot be saved until conversations.json is restored from a backup and Athena is restarted.' : state.error, cursorModelNotice: this.cursorModelNotice, messages: session.messages.slice(-this.pageSize), sessionId: session.id, config: session.config, draft: session.draft,
      attachments: session.attachments, workspaces: session.workspaces.map((workspace) => ({ ...workspace, authorized: this.hooks.authorized?.(workspace.id) ?? false })),
      sessions: this.library.sessions.map(({ id, title, createdAt, updatedAt, config, workspaces, unreadCompletion, messages }) => { const approval = [...messages].reverse().find((message) => message.execution?.approval)?.execution?.approval; return { id, title, createdAt, updatedAt, config, project: workspaces[0], executionStatus: approval ? 'waiting-approval' as const : this.generations.get(id)?.queued ? 'queued' as const : this.generations.has(id) ? 'running' as const : messages.at(-1)?.execution?.status === 'waiting-auth' || /Request interrupted when Athena closed/.test(messages.at(-1)?.error ?? '') ? 'paused' as const : undefined, ...(approval ? { pendingApprovalId: approval.id } : {}), unreadCompletion } }).sort((a, b) => b.updatedAt - a.updatedAt), hasMore: session.messages.length > this.pageSize,
      voiceSearchPreview: this.voiceSearchPreview?.sessionId === session.id ? this.voiceSearchPreview.message : undefined })
  }
  /** A transient voice-only turn using the selected provider, model, effort and project retrieval.
   * Voice messages never enter ConversationLibrary; cited search answers may be previewed in a snapshot. */
  async answerHandsFree(input: unknown, progress?: (event: { type: 'model-start' | 'text' | 'trace'; text?: string; trace?: LocalInferenceTrace }) => void, delegate?: (signal:AbortSignal) => Promise<{ok:boolean; text?:string; message?:string}>, prepareDelegatedContext?: (signal:AbortSignal)=>Promise<PreparedContext>): Promise<{ ok: boolean; text?: string; message?: string }> {
    const parsed = handsFreeReplySchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'I didn’t catch that. Please try again.' }
    if (this.disposed) return { ok: false, message: 'Voice conversation is unavailable.' }
    if (this.generation) return { ok: false, message: 'I’m in the middle of another task. Say “Athena, cancel the task” if you want me to stop it.' }
    if (this.voiceAbort) return { ok: false, message: 'I’m already responding to your last voice request.' }
    const session = this.current()
    const user: ChatMessage = { id: randomUUID(), role: 'user', content: parsed.data.text, status: 'complete', createdAt: Date.now() }
    const diagnosticDirect = parsed.data.diagnosticDirect === true
    this.setAutomationProgress(undefined)
    const traceId = parsed.data.id ?? user.id
    const messages = diagnosticDirect || prepareDelegatedContext ? [user] : [...this.voiceMessages, user]
    const abort = new AbortController()
    this.voiceAbort = abort
    const ownership: AIOwnership = { origin: this.hooks.origin ?? 'online-chat', sessionId: session.id, correlationId: user.id }
    this.voiceOwnership = ownership
    this.hooks.phase('thinking', ownership, 'floating-voice')
    let timedOut = false
    let releaseLocalInference: (() => void) | undefined
    let voiceTools: ProjectTools | undefined
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
          return action.success === false ? { ok: false, message: answer } : { ok: true, text: answer }
        }
      }
      if (delegate) return delegate(abort.signal)
      if (this.hooks.resource === 'local') {
        const waiting = performance.now()
        log('voice.trace', { traceId, stage: 'local-inference-slot-wait-start', mode: diagnosticDirect ? 'direct' : 'normal' })
        releaseLocalInference = await localInferenceSlots.acquire(abort.signal)
        log('voice.trace', { traceId, stage: 'local-inference-slot-ready', waitMs: Math.round(performance.now() - waiting) })
      }
      const providerStarted = performance.now()
      log('voice.trace', { traceId, stage: 'provider-initialization-start', mode: diagnosticDirect ? 'direct' : 'normal', model: session.config.model ?? this.hooks.effectiveModel?.() ?? 'selected-local-model' })
      const provider = await this.hooks.provider({ ...session.config }, { isolated: false, coding: false, purpose: 'voice-planning' })
      if (abort.signal.aborted || this.voiceAbort !== abort) throw new ChatError('Voice response cancelled.')
      log('voice.trace', { traceId, stage: 'provider-initialization-complete', durationMs: Math.round(performance.now() - providerStarted), model: provider.modelId ?? session.config.model ?? 'selected-local-model' })
      let context: PreparedContext | undefined
      if (!diagnosticDirect) {
        const contextStarted = performance.now()
        log('voice.trace', { traceId, stage: 'context-preparation-start' })
        context = prepareDelegatedContext ? await prepareDelegatedContext(abort.signal) : await this.hooks.prepare?.(session, messages, abort.signal, true)
        log('voice.trace', { traceId, stage: 'context-preparation-complete', durationMs: Math.round(performance.now() - contextStarted), tools: context?.projectTools?.definitions.length ?? 0, repositoryCharacters: context?.repositoryText.length ?? 0 })
      } else log('voice.trace', { traceId, stage: 'context-preparation-bypassed', mode: 'direct' })
      // The temporary voice turn keeps the selected provider/model, while a
      // simple greeting does not advertise tools it cannot possibly need.
      if (/^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening)|how are you|tell me a joke)[!?.\s]*$/i.test(parsed.data.text)) context && (context.projectTools = undefined)
      const requiresAction = !diagnosticDirect && /^(?:(?:hey )?athena[, ]+)?(?:(?:please|can you|could you|would you)\s+)*(?:open|switch|launch|click|scroll|inspect|send|submit|type|create|rename|delete|move|select|pause|play|press|change|set|search|upload|download|drag|navigate|attach|close|restore|minimize|maximize)\b/i.test(parsed.data.text.trim())
      const retrievedSearch = /^(?:(?:please|can you)\s+)*search\b/i.test(parsed.data.text.trim()) && Boolean(context?.webSources?.length)
      let completedCalls = 0, failure: string | undefined
      const nativeReceipts: string[] = []
      const executedTools = new Set<string>()
      if (context?.projectTools) {
        voiceTools = context.projectTools
        const base = voiceTools
        if (prepareDelegatedContext && provider.nativeAgent) throw new ChatError('This native agent runs its own tools. Choose a model supporting Athena-managed tools for voice planning.')
        context.projectTools = {...base, execute: async (name, input, signal) => {
          signal.throwIfAborted()
          await this.beforeVoiceStep(signal)
          const output = await base.execute(name, input, signal)
          signal.throwIfAborted()
          let receipt: {ok?:boolean; error?:unknown; message?:string; verified?:boolean} = {}
          try { receipt = JSON.parse(output) ?? {} } catch { /* Some read-only tools return plain text. */ }
          if (receipt.ok === false || receipt.error || receipt.verified === false) {
            failure = receipt.message || 'An automation step could not be verified. Inspect the target before retrying.'
          } else {
            completedCalls++
            executedTools.add(name)
            if ((name.startsWith('athena_') || name === 'point_at_window') && receipt.message) nativeReceipts.push(receipt.message)
          }
          return output
        }}
      }
      const effort = voiceReasoningEffort(parsed.data.text, provider.modelId ?? session.config.model ?? this.hooks.effectiveModel?.() ?? null, session.config.effort, this.hooks.adaptiveVoiceReasoning?.() ?? true)
      let text = '', complete = false
      progress?.({ type: 'model-start' })
      for await (const chunk of provider.streamMessage(messages, { signal: abort.signal, effort, context, contextSettings: this.contextPolicy(session), voiceOnly: true,
        diagnosticDirect, traceId, onLocalInferenceTrace: event => {
          log('ai.local_inference_trace', { traceId, mode: diagnosticDirect ? 'direct' : 'normal', ...event })
          progress?.({ type: 'trace', trace: event })
        } })) {
        if (abort.signal.aborted || this.voiceAbort !== abort) throw new ChatError('Voice response cancelled.')
        if (chunk.type === 'done') { complete = true; break }
        if (chunk.type !== 'text') continue
        if (text.length + chunk.text.length > MAX_RESPONSE_LENGTH) throw new ChatError('That answer is too long for a voice reply. Ask me to make it shorter.')
        text += chunk.text
        // Tool-capable turns speak only after execution receipts are checked.
        // Ordinary conversation can still stream speech with low latency.
        if (chunk.text && !requiresAction && !context?.projectTools?.definitions.length) progress?.({ type: 'text', text: chunk.text })
      }
      if (failure) return {ok:false,message:failure}
      if (requiresAction && !completedCalls && !retrievedSearch) return {ok:false,message:'No tool verified that action. Please identify the target or choose a model that supports Athena tools.'}
      if (requiresAction && nativeReceipts.length) text = nativeReceipts.slice(-3).join(' ')
      else if (requiresAction && completedCalls && !/^(?:(?:please|can you)\s+)*(?:inspect|search)\b/i.test(parsed.data.text.trim())) {
        text = 'Executed ' + Array.from(executedTools).slice(-3).map(name=>name.replaceAll('_',' ')).join(', ') + '. Check the result before continuing.'
      }
      if (!complete || !text.trim()) throw new ChatError('I couldn’t finish that answer. Please try again.')
      const assistant: ChatMessage = { id: randomUUID(), role: 'assistant', content: text.trim(), status: 'complete', createdAt: Date.now() }
      if (!prepareDelegatedContext) this.voiceMessages = [...this.voiceMessages, user, assistant]
      if (context?.webSources?.length && !abort.signal.aborted && this.voiceAbort === abort) {
        this.voiceSearchPreview = { sessionId: session.id, message: assistant }
        this.publish()
      }
      while (this.voiceMessages.length > 20 || this.voiceMessages.reduce((total, message) => total + message.content.length, 0) > 16_000) this.voiceMessages.splice(0, 2)
      const failed = this.state.automationProgress?.steps.find(step => step.status === 'failed' || step.status === 'cancelled')
      if (failed) return { ok: false, message: this.state.automationProgress?.message ?? 'An automation step did not complete. Completed actions are preserved; review the activity before continuing.' }
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
      await voiceTools?.dispose?.()
      for (const id of this.voiceActivities.keys()) this.finishActivity(id, { status: abort.signal.aborted ? 'cancelled' : 'error' })
      releaseLocalInference?.(); releaseLocalInference = undefined
      if (this.voiceAbort === abort) {
        this.voicePause?.release();this.voicePause=undefined
        this.voiceAbort = undefined
        this.hooks.phase('idle', ownership, 'floating-voice')
        this.voiceOwnership = undefined
      }
    }
  }
  cancelHandsFreeReply(): void {
    this.voicePause?.release();this.voicePause=undefined
    this.voiceAbort?.abort()
    this.voiceAbort = undefined
    if (this.voiceOwnership) this.hooks.phase('idle', this.voiceOwnership, 'floating-voice')
    this.voiceOwnership = undefined
  }
  clearHandsFreeContext(): void { this.cancelHandsFreeReply(); this.voiceMessages = [] }
  private save(): boolean {
    clearTimeout(this.saveTimer); this.saveTimer = undefined
    if (this.storageFailed) return false
    for (const session of this.library.sessions) for (const reply of session.messages) if (reply.execution?.status === 'working') this.checkpointTask(reply, session)
    try { this.storage?.save(this.library); return true }
    catch { this.state.error = 'Could not save conversation history. Check disk space and folder permissions; keep Athena open and retry.'; return false }
  }
  sessionChanged(): void { const session = this.current(); if (!this.hooks.nativeExecution?.(session) && session.config.agentMode === 'full-access' && session.config.fullAccessWorkspaceId !== session.workspaces[0]?.id) session.config.agentMode = 'ask'; session.updatedAt = Date.now(); this.publish() }
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
    if (!session.workspaces.some((entry) => entry.id === workspace.id)) { if (session.workspaces.length >= 8) throw new ChatError('Connect up to 8 projects per conversation.'); if (!this.hooks.nativeExecution?.(session) && !session.workspaces.length && session.config.agentMode === 'full-access') session.config.agentMode = 'ask'; session.workspaces.push(workspace) }
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
    for (const session of removed) { this.media?.release(session); this.discardSessionState(session.id) }
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
    if (command.action === 'codex-answer') {
      const pending=this.nativeAnswers.get(command.id)
      if(!pending || pending.requestId!==command.requestId)return {ok:false,message:'This Codex question is no longer pending.'}
      pending.resolve(command.answers)
      return {ok:true}
    }
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
        if (this.hooks.nativeExecution?.(session)) {
          if (command.mode === 'full-access' && !session.config.codexFullAccessConfirmed && command.confirmed !== true) return {ok:false,message:'Confirm unrestricted Codex Full Access in the composer before enabling it.'}
          session.config.agentMode = command.mode
          if (command.mode === 'full-access') session.config.codexFullAccessConfirmed = true
          // Leave the active generation and its native approval requests untouched.
          // The next submission captures this independently persisted selection.
        } else {
          const workspace = session.workspaces[0]
          if (command.mode === 'full-access') {
            if (!workspace || this.hooks.authorized?.(workspace.id) !== true) return { ok: false, message: 'Connect and authorize a project before enabling Full Access.' }
            if (this.hooks.workspaceOnly?.() !== true) return { ok: false, message: 'Full Access requires Project Only filesystem scope so automatic approvals cannot reach outside this workspace.' }
            if (session.config.fullAccessWorkspaceId !== workspace.id && command.confirmed !== true) return { ok: false, message: 'Confirm the Full Access warning for this conversation and project before enabling it.' }
          }
          if (session.config.agentMode === command.mode) return { ok: true }
          const wasRunning = this.generations.has(session.id)
          if (wasRunning) this.stopSession(session.id, `Project permission mode changed from ${session.config.agentMode ?? 'ask'} to ${command.mode}. The active request was stopped to prevent it from continuing with stale permissions; completed operations remain recorded.`)
          this.permissionVersions.set(session.id, (this.permissionVersions.get(session.id) ?? 0) + 1)
          log('ai.permission_mode_changed', { sessionId: session.id, previousMode: session.config.agentMode ?? 'ask', nextMode: command.mode, permissionStateVersion: this.permissionVersions.get(session.id)!, cancelledActiveRequest: wasRunning })
          session.config.agentMode = command.mode
          if (command.mode === 'full-access') session.config.fullAccessWorkspaceId = workspace!.id
          if (command.mode === 'advanced' || command.mode === 'full-access') session.config.contextSettings = { ...this.contextPolicy(session), allowProjectCommands: true, ...(command.mode === 'full-access' ? { allowProjectDeletion: true } : {}) }
          session.contextCheckpoint = undefined
        }
      }
      if (command.action === 'project-permissions') {
        if (command.mode === 'full-access') return { ok: false, message: 'Enable Full Access from the composer and confirm its warning.' }
        if (!session.workspaces.length) return { ok: false, message: 'Connect a project before changing project permissions.' }
        if (session.config.agentMode === command.mode && session.config.contextSettings?.allowProjectDeletion === command.allowDeletion && session.config.contextSettings?.allowProjectCommands === command.allowCommands) return { ok: true }
        const wasRunning = this.generations.has(session.id)
        if (wasRunning) this.stopSession(session.id, 'Project permissions were changed. The active request was stopped to prevent it from continuing with stale permissions; completed operations remain recorded.')
        this.permissionVersions.set(session.id, (this.permissionVersions.get(session.id) ?? 0) + 1)
        log('ai.project_permissions_changed', { sessionId: session.id, nextMode: command.mode, permissionStateVersion: this.permissionVersions.get(session.id)!, cancelledActiveRequest: wasRunning })
        session.config.agentMode = command.mode
        session.config.contextSettings = { ...this.contextPolicy(session), allowProjectDeletion: command.allowDeletion, allowProjectCommands: command.allowCommands }
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
        this.media?.release(session)
        this.library.sessions = this.library.sessions.filter((entry) => entry.id !== command.id)
        this.discardSessionState(command.id)
        this.hooks.unreadChanged?.(this.unreadCount())
        if (!this.library.sessions.length) this.library.sessions.push(newConversation(session.config))
        if (this.library.activeId === command.id) this.switchTo(this.library.sessions[0].id)
      }
      if (command.action === 'configure') {
        if (this.generation && session.id === this.library.activeId) return { ok: false, message: 'Stop the response before switching models.' }
        if (command.config.agentMode === 'full-access' && (this.hooks.nativeExecution?.({...session,config:command.config}) ? !session.config.codexFullAccessConfirmed : session.config.agentMode !== 'full-access' || session.config.fullAccessWorkspaceId !== session.workspaces[0]?.id)) return { ok: false, message: 'Enable Full Access from the composer and confirm its warning.' }
        rememberThirdPartyEffort(session.config)
        session.config = { ...command.config, thirdPartyEfforts: { ...session.config.thirdPartyEfforts, ...command.config.thirdPartyEfforts }, fullAccessWorkspaceId: session.config.fullAccessWorkspaceId, codexFullAccessConfirmed:session.config.codexFullAccessConfirmed, effort: (this.hooks.modelSupportsEffort?.(command.config.model, command.config.effort, command.config.accountRoute) ?? modelCapabilities(command.config.model).efforts.includes(command.config.effort)) ? command.config.effort : 'auto' }
      }
      if (command.action === 'configure-model') {
        if (this.generation && session.id === this.library.activeId) return { ok: false, message: 'Stop the response before switching models.' }
        rememberThirdPartyEffort(session.config)
        session.config.model = command.model
        const saved = thirdPartyEffortKey(session.config)
        if (saved) session.config.effort = session.config.thirdPartyEfforts?.[saved] ?? 'auto'
        if (!(this.hooks.modelSupportsEffort?.(command.model, session.config.effort, session.config.accountRoute) ?? modelCapabilities(command.model).efforts.includes(session.config.effort))) session.config.effort = 'auto'
      }
      if (command.action === 'select-account-model') {
        if (this.generations.has(session.id)) return { ok: false, message: 'Stop this conversation before switching its account or model.' }
        const leavingThirdParty = session.config.accountRoute?.provider === 'third-party'
        rememberThirdPartyEffort(session.config)
        session.config.accountRoute = command.route
        session.config.model = command.model
        delete session.config.cursorPendingModel
        session.config.cursorModel = command.route.provider === 'cursor' ? command.model : null
        const saved = thirdPartyEffortKey(session.config)
        if (saved) session.config.effort = session.config.thirdPartyEfforts?.[saved] ?? 'auto'
        else if (leavingThirdParty) session.config.effort = 'auto'
        if (!(this.hooks.modelSupportsEffort?.(command.model, session.config.effort, session.config.accountRoute) ?? modelCapabilities(command.model).efforts.includes(session.config.effort))) session.config.effort = 'auto'
        session.contextCheckpoint = undefined
      }
      if (command.action === 'configure-effort') {
        if (this.generation && session.id === this.library.activeId) return { ok: false, message: 'Stop the response before changing reasoning effort.' }
        if (!(this.hooks.modelSupportsEffort?.(session.config.model, command.effort, session.config.accountRoute) ?? modelCapabilities(session.config.model).efforts.includes(command.effort))) return { ok: false, message: 'The selected model does not support that reasoning effort.' }
        session.config.effort = command.effort
        rememberThirdPartyEffort(session.config)
      }
      if (command.action === 'draft') session.draft = command.text
      if (command.action === 'more' && session.id === this.library.activeId) this.pageSize += 60
      if (command.action === 'edit') {
        if (session.nativeCodex) return {ok:false,message:'Native Codex history cannot be rewritten here. Send a correction as a new message or create a new conversation.'}
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
    void this.refreshNativeHistory(id).catch(()=>{})
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
    // Ordinary Codex messages go to the native harness, including media intent.
    // Explicit media-mode commands remain a separately selected Athena feature.
    const op = resolvedCommand || this.hooks.nativeExecution?.(session) ? undefined : this.media?.intent(session, parsed.data.text)
    if (op) return this.createMediaMessage(session,{action:'generate',sessionId:session.id,requestId:parsed.data.requestId??randomUUID(),operation:op,prompt:parsed.data.text,parentId:session.attachments.some(a=>a.kind==='image'||a.kind==='video')?undefined:session.config.mediaParentId,options:{}})
    this.voiceSearchPreview = undefined
    if (!session.messages.length && session.title === 'New conversation') session.title = parsed.data.text.replace(/\s+/g, ' ').slice(0, 72)
    const userMessage: ChatMessage = { id: randomUUID(), role: 'user', content: parsed.data.text, status: 'complete', createdAt: Date.now(), attachments: session.attachments.splice(0), requestId: parsed.data.requestId, command: resolvedCommand }
    const prior = session.messages.at(-1)
    if (prior?.role === 'assistant' && prior.interaction && prior.interaction.status !== 'answered') {
      prior.interaction = { ...prior.interaction, status: 'answered', answerMessageId: userMessage.id, answer: userMessage.content }
    }
    this.state.messages.push(userMessage)
    session.draft = ''; session.updatedAt = Date.now()
    const continueTask = prior?.role === 'assistant' && prior.execution?.taskCheckpoint?.resumable === true && !resolvedCommand
      && (prior.interaction?.answerMessageId === userMessage.id || /^\s*(?:please\s+)?(?:continue|resume)(?: (?:the |this )?(?:unfinished |previous )?task)?[.!]?\s*$/i.test(userMessage.content))
    this.start(continueTask && this.contextPolicy().safeTaskRecovery)
    return { ok: true }
  }
  retry(): ChatResult {
    if (this.disposed || this.generation) return { ok: false, message: 'Stop the current response before retrying.' }
    const last = this.state.messages.at(-1)
    if (!last || last.role !== 'assistant') return { ok: false, message: 'There is no response to retry.' }
    if (last.mediaJob) return { ok: false, message: 'Use the media controls to track or explicitly generate another result.' }
    const native = this.current().nativeCodex
    const user = this.state.messages.findLast(message => message.role === 'user')
    if (this.hooks.nativeExecution?.(this.current()) && native?.turnId && native.lastMessageId === user?.id && native.submission !== 'pending' && last.status !== 'complete') {
      // An explicit continuation is new input on the same native thread. Reusing
      // the old client message ID only reconciles that already-submitted turn.
      // The adapter checks that the prior turn is idle before submitting this.
      return this.send({text:'Continue the unfinished task using the existing thread history. Check what has already completed before taking further action; do not repeat completed operations.'})
    }
    const resumable = last.execution?.taskCheckpoint?.resumable === true
    if (resumable && !this.contextPolicy().safeTaskRecovery) return { ok: false, message: 'Safe task recovery is disabled for this conversation.' }
    if (!resumable) this.current().contextCheckpoint = undefined
    if (!last.execution?.activities.length && !resumable) this.state.messages.pop()
    this.start(resumable || Boolean(last.execution?.activities.length))
    return { ok: true }
  }
  private start(resuming = false): void {
    const reply: ChatMessage = { id: randomUUID(), role: 'assistant', content: '', status: 'streaming', createdAt: Date.now() }
    reply.execution = { startedAt: reply.createdAt, updatedAt: reply.createdAt, status: 'working', activities: [], timeline: [] }
    const request = [...this.state.messages].reverse().find((entry) => entry.role === 'user')
    if (!this.hooks.nativeExecution?.(this.current())) {
      if (request?.command) this.timeline(reply, 'started', `${resuming ? 'Continuing' : 'Starting'} ${request.command.name}.`)
      else if (!resuming && this.current().workspaces.length && this.state.messages.filter((entry) => entry.role === 'user').length === 1) this.timeline(reply, 'started', 'I’ll inspect the authorized project and its current state before making changes.')
      reply.execution.taskCheckpoint = { taskId: reply.id, model: this.hooks.effectiveModel?.() ?? this.current().config.model ?? '', originalRequest: [...this.state.messages].reverse().find((entry) => entry.role === 'user')?.content ?? '', workspaceIds: this.current().workspaces.map((entry) => entry.id), instructionMessageIds: this.state.messages.filter((entry) => entry.role === 'user').map((entry) => entry.id), completedOperationIds: [], modifiedFiles: [], verificationOperationIds: [], verificationGates: { productionBuild: 'not-run', developmentServer: 'not-run', browserVerification: 'not-run' }, pendingActions: ['Complete the user request and applicable verification.'], updatedAt: reply.createdAt, continuationAttempts: 0 }
      const priorTask = resuming ? resumeEvidence(this.state.messages)?.execution?.taskCheckpoint : undefined
      if (priorTask) {
        reply.execution.taskCheckpoint.parentTaskId = priorTask.taskId
        reply.execution.taskCheckpoint.originalRequest = priorTask.originalRequest
      }
      Object.assign(reply.execution.taskCheckpoint, { conversationId: this.current().id, requestedModel: this.current().config.model ?? undefined, effort: this.current().config.effort, permissionMode: this.current().config.agentMode, accountRoute: JSON.stringify(this.current().config.accountRoute ?? null) })
      if (!this.contextPolicy().taskCheckpoints) reply.execution.taskCheckpoint = undefined
    }
    const context = recentContext(this.state.messages, Infinity)
    const messages = context.messages
    this.state.contextNotice = undefined
    const abort = new AbortController()
    const generation: Generation = { id: reply.id, abort, queued: true, startedAt: performance.now(), nativeConfig:this.hooks.nativeExecution?.(this.current()) ? structuredClone(this.current().config) : undefined }
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
        // Bound credential/runtime initialization independently of inference.
        // Once the provider is ready, the configured task deadline takes over.
        generation.timeout = setTimeout(() => this.stopSession(sessionId, 'Provider initialization timed out. Completed work is preserved; check the selected account and runtime before resuming.', true, 'request_initialization_timeout'), Math.max(120_000, this.contextPolicy().responseConnectionSeconds * 1000))
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
  private readonly nativeHistoryReadAt = new Map<string,number>()
  async refreshNativeHistory(id = this.library.activeId): Promise<void> {
    const session=this.getSession(id)
    if(!session?.nativeCodex || this.generations.has(id) || !this.hooks.nativeHistory || Date.now()-(this.nativeHistoryReadAt.get(id)??0)<10_000)return
    this.nativeHistoryReadAt.set(id,Date.now())
    const history=await this.hooks.nativeHistory(session)
    if(this.generations.has(id))return
    for(const {turn,items} of history.reverse()) {
      let reply=session.messages.find(m=>m.nativeTurnId===turn.id && m.role==='assistant')
      if(!reply) {
        // Do not import arbitrary external messages into an unrelated conversation.
        if(!session.messages.some(m=>m.role==='user' && items.some(e=>e.item.type==='userMessage' && e.item.clientId===m.id)))continue
        reply={id:randomUUID(),role:'assistant',content:'',createdAt:(turn.startedAt??Date.now()/1000)*1000,status:'stopped',nativeTurnId:turn.id}
        session.messages.push(reply)
      }
      reply.content=items.filter(e=>e.item.type==='agentMessage').map(e=>e.item.type==='agentMessage'?e.item.text:'').join('\n\n').slice(0,MAX_RESPONSE_LENGTH)
      reply.status=turn.status==='completed'?'complete':turn.status==='failed'?'error':'stopped'
      reply.error=turn.status==='completed'?undefined:turn.error?.message??'Codex has not reported a completed turn. No operation was replayed.'
      if(reply.execution){reply.execution.status=turn.status==='completed'?'complete':'error';reply.execution.finishedAt=(turn.completedAt??Date.now()/1000)*1000;reply.execution.timeline=undefined}
    }
    this.save();this.publish(true)
  }
  async steerNative(id:string,text:string):Promise<ChatResult> {
    const steer=this.nativeSteering.get(id),session=this.getSession(id)
    if(!steer || !session || !text.trim() || text.length>12000)return {ok:false,message:'This native Codex turn is not available for follow-up input.'}
    const message:ChatMessage={id:randomUUID(),role:'user',content:text,status:'complete',createdAt:Date.now()}
    try {await steer(text,message.id);session.messages.push(message);session.draft='';this.save();this.publish(true);return {ok:true}}
    catch {return {ok:false,message:'Codex did not confirm the follow-up. It was not automatically retried; check native history before sending it again.'}}
  }
  private readonly nativeAnswers = new Map<string, { requestId: string; resolve(answers: Record<string,{answers:string[]}>): void }>()
  private readonly nativeSteering = new Map<string, (text: string, id: string) => Promise<void>>()
  private async generateNative(provider: AIProvider, generation: Generation, reply: ChatMessage, messages: ChatMessage[]): Promise<void> {
    const session = this.current(), signal = generation.abort.signal
    const config = generation.nativeConfig ?? structuredClone(session.config)
    clearTimeout(generation.timeout)
    if (!this.hooks.prepareNative) throw new ChatError('Native Codex workspace configuration is unavailable.')
    if (reply.execution) {
      reply.execution.taskCheckpoint = undefined
      reply.execution.providerId = 'codex-subscription'
      reply.execution.modelId = provider.modelId
    }
    session.contextCheckpoint = undefined
    const prepared = await this.hooks.prepareNative({...session,config}, messages, signal)
    if (!session.nativeCodex && session.messages.some(m => m.role === 'assistant' && m.id !== reply.id)) {
      this.state.contextNotice = 'A new native Codex thread starts here. Earlier Athena messages remain visible but were not replayed. Include any previous requirements you want Codex to use.'
      this.timeline(reply, 'status', this.state.contextNotice)
    }
    let complete = false
    try {
    for await (const chunk of provider.streamMessage(messages, {
      signal, effort:config.effort, permissionMode:config.agentMode ?? 'ask', conversationId:session.id, executionId:reply.id,
      context:prepared.context,
      onModelResponse:usage=>{if(reply.execution){const previous=reply.execution.providerUsage;reply.execution.providerUsage={inputTokens:(previous?.inputTokens??0)+usage.inputTokens,cachedInputTokens:(previous?.cachedInputTokens??0)+(usage.cachedInputTokens??0),outputTokens:(previous?.outputTokens??0)+usage.outputTokens,reasoningTokens:(previous?.reasoningTokens??0)+(usage.reasoningTokens??0),estimated:!!(previous?.estimated||usage.estimated),requestCount:(previous?.requestCount??0)+1,updatedAt:Date.now()}}},
      nativeCodex:{ computerTools:prepared.computer, fullAccessConfirmed:config.codexFullAccessConfirmed, policyStatus:status=>{session.codexAccess=status;this.save();this.publish(true)}, ready:steer=>this.nativeSteering.set(session.id,steer),finalText:text=>{reply.content=text.slice(0,MAX_RESPONSE_LENGTH);if(reply.execution)reply.execution.timeline=undefined}, state:session.nativeCodex, cwd:prepared.cwd, writableRoots:prepared.writableRoots,
        persist: state => {
          session.nativeCodex = state
          reply.nativeTurnId = state.turnId
          if (!this.save()) throw new ChatError('Could not save the Codex thread association. No further turn was submitted.')
        },
        requestUserInput: (request, requestSignal) => this.executionScope.run(session.id,()=>new Promise(resolve => {
          reply.nativeCodexQuestion = request
          const finish = (answers:Record<string,{answers:string[]}>) => {
            requestSignal.removeEventListener('abort', cancelled)
            this.nativeAnswers.delete(session.id); reply.nativeCodexQuestion = undefined
            this.publish(true); resolve(answers)
          }
          const cancelled = () => finish({})
          this.nativeAnswers.set(session.id,{requestId:request.requestId,resolve:answers=>this.executionScope.run(session.id,()=>finish(answers))})
          requestSignal.addEventListener('abort',cancelled,{once:true})
          if (requestSignal.aborted) cancelled(); else this.publish(true)
        })),
      },
      requestApproval:(title,description,approvalSignal,changes) => this.executionScope.run(session.id,()=>this.approve({title,description,changes,fullAccessEligible:false},approvalSignal)),
    })) {
      if (this.generation !== generation || signal.aborted) return
      if (chunk.type === 'done') {complete=true;break}
      if (chunk.type === 'text') {
        // A display cap never aborts Codex or changes its authoritative history.
        const text = chunk.text.slice(0,Math.max(0,MAX_RESPONSE_LENGTH-reply.content.length))
        reply.content += text; this.timeline(reply,'text',text)
      } else if (chunk.type === 'activity' && reply.execution) {
        let activity = reply.execution.activities.find(a=>a.id===chunk.id)
        if (!activity && reply.execution.activities.length<500) {
          activity={id:chunk.id,tool:chunk.tool,label:chunk.label,status:chunk.status,startedAt:Date.now()}
          reply.execution.activities.push(activity);this.timeline(reply,'activity',undefined,chunk.id)
        }
        if (activity) {Object.assign(activity,chunk);if(chunk.status!=='running')activity.finishedAt=Date.now()}
      }
      if(reply.execution)reply.execution.updatedAt=Date.now()
      if(!this.publishTimer)this.publishTimer=setTimeout(()=>this.publish(),40)
    }
    if(!complete)throw new ChatError('Codex did not report successful turn completion. Native history is preserved.')
    reply.status='complete'
    if(reply.execution)reply.execution.streamPhase=undefined
    } finally { await prepared.computer?.dispose?.() }
  }
  private async generate(generation: Generation, reply: ChatMessage, messages: ChatMessage[], resuming = false): Promise<void> {
    let cursorNativeChanges = false
    try {
      const session = this.current()
      const providerStarted = performance.now()
      const provider = await this.hooks.provider({ ...(generation.nativeConfig ?? session.config), contextSettings: this.contextPolicy(session) }, { isolated: false, coding: session.workspaces.length > 0 })
      if (generation.abort.signal.aborted || this.generation !== generation) return
      if (provider.nativeCodex) { await this.generateNative(provider, generation, reply, messages); return }
      const accountId = await this.hooks.accountIdentity?.() ?? null
      if (this.generation !== generation) return
      const instruction=messages.findLast(message=>message.role==='user')
      if(this.hooks.resolveComputerCommand && instruction && !instruction.attachments?.length && !resuming){
        const result=await this.hooks.resolveComputerCommand(session,instruction.content,instruction.id,generation.abort.signal)
        if(this.generation!==generation || generation.abort.signal.aborted)return
        if(result.handled){
          if(result.success===false)throw new ChatError(result.text ?? 'The automation did not complete.')
          reply.content=result.text ?? 'The local action returned a verified receipt.'
          reply.status='complete'
          if(reply.execution){reply.execution.streamPhase=undefined;if(reply.execution.taskCheckpoint)reply.execution.taskCheckpoint.pendingActions=[]}
          return
        }
      }
      let migrationAuthorized = false
      if (resuming) {
        const previous = resumeEvidence(messages)
        const task = previous?.execution?.taskCheckpoint
        const accountChanged = Boolean(task?.accountRoute && task.accountRoute !== JSON.stringify(session.config.accountRoute ?? null) || previous?.execution?.accountId && previous.execution.accountId !== accountId)
        if (accountChanged) {
          migrationAuthorized = await this.approve({ title: 'Resume with the selected account', description: 'Send this task’s saved conversation, attachments, project context and verified results to the currently selected account/provider? Its own billing or subscription allowance applies. Credentials and native sessions will not be transferred.', fullAccessEligible: false }, generation.abort.signal)
          if (!migrationAuthorized) throw new ChatError('Task transfer was declined. Select the same ChatGPT account or explicitly approve the destination account before resuming. Completed work is preserved.')
        }
        const priorWorkspaces = previous?.execution?.taskCheckpoint?.workspaceIds
        if (priorWorkspaces && (priorWorkspaces.length !== session.workspaces.length || priorWorkspaces.some((id) => !session.workspaces.some((workspace) => workspace.id === id)))) throw new ChatError('The authorized project changed since this task paused. Reconnect the original project before continuing; completed changes remain preserved.')
      }
      if (accountId && reply.execution) reply.execution.accountId = accountId

      if (generation.abort.signal.aborted || this.generation !== generation) return
      clearTimeout(generation.timeout)
      generation.timeout = setTimeout(() => this.stopSession(session.id, 'The configured task deadline was reached. Review Activity for actual changes before continuing.', true, 'task_deadline'), this.contextPolicy(session).maxExecutionMinutes * 60_000)
      const completeMessages = messages
      const priorIdentity = resuming ? resumeEvidence(messages)?.execution?.taskCheckpoint : undefined
      const identityChanged = Boolean(priorIdentity && (priorIdentity.model !== (provider.modelId ?? session.config.model) || priorIdentity.accountRoute !== JSON.stringify(session.config.accountRoute ?? null) || priorIdentity.provider !== (this.hooks.usageProviderId?.(provider) ?? 'unknown')))
      const saved = identityChanged ? undefined : session.contextCheckpoint
      const index = saved ? messages.findIndex((entry) => entry.id === saved.coveredThrough) : -1
      const workspaceAllowed = !session.workspaces.length || session.workspaces.every((workspace) => this.hooks.authorized?.(workspace.id))
      if (resuming && !workspaceAllowed) throw new ChatError('Restore authorization for the original project before Resume Task. No operation was replayed.')
      if (workspaceAllowed && this.hooks.workspaceRoot && reply.execution?.taskCheckpoint) {
        const roots = await Promise.all(session.workspaces.map(workspace => this.hooks.workspaceRoot!(workspace.id)))
        const prior = resuming ? resumeEvidence(completeMessages)?.execution?.taskCheckpoint : undefined
        if (prior?.workspaceRoots && JSON.stringify(prior.workspaceRoots) !== JSON.stringify(roots)) throw new ChatError('The project directory changed since this task paused. Restore its original authorized workspace before resuming.')
        reply.execution.taskCheckpoint.workspaceRoots = roots
      }
      const checkpoint = provider.contextCheckpointFormat === 'openai-responses' && this.contextPolicy(session).taskCheckpoints && saved && workspaceAllowed && index >= 0 && saved.fingerprint === contextFingerprint(session, messages.slice(0, index + 1)) ? saved.input as unknown as ResponseInput : undefined
      if (checkpoint) messages = messages.slice(index + 1)
      else session.contextCheckpoint = undefined
      const originalUser = resuming ? completeMessages.findLast(entry => entry.role === 'user' && entry.content === priorIdentity?.originalRequest) : undefined
      const invoked = originalUser ?? [...messages].reverse().find((entry) => entry.role === 'user')
      let expandedRequest: string | undefined
      if (invoked?.command) {
        if (!this.hooks.resolveCommand) throw new ChatError('Slash command execution is unavailable.')
        const prompt = await this.hooks.resolveCommand(session, invoked.command, invoked.content, generation.abort.signal)
        expandedRequest = prompt
        if (reply.execution) reply.execution.subagentRequirements = workflowSubagentRequirements(prompt)
        log('ai.command_expanded', { command: invoked.command.name, model: session.config.model ?? 'provider-default', effort: session.config.effort, instructionBytes: Buffer.byteLength(prompt), historyMessages: messages.length })
        messages = messages.map((entry) => entry.id === invoked.id ? { ...entry, content: prompt } : entry)
      }
      if (resuming) {
        const previous = resumeEvidence(completeMessages)
        if (reply.execution && previous?.execution?.subagentRequirements?.length) reply.execution.subagentRequirements = previous.execution.subagentRequirements
        const activities = taskLineage(completeMessages, previous).flatMap(message => message.execution?.activities ?? [])
        const task = previous?.execution?.taskCheckpoint
        const recent = activities.slice(-16).map((activity) => {
          const files = activity.changes?.filter((change) => change.status === 'applied').map((change) => change.path).slice(0, 8) ?? []
          return `${activity.status}: ${activity.tool}${files.length ? `; applied: ${files.join(', ')}` : ''}`
        }).join('\n').slice(0, 2400)
        const verified = activities.filter((activity) => task?.verificationOperationIds.includes(activity.id)).slice(-5)
          .map((activity) => `${activity.status}: ${activity.tool}; ${activity.summary?.slice(0, 200) ?? 'No result summary'}`).join('\n')
        const children = [...new Map(activities.flatMap(a => a.subagent ? [[a.subagent.id, { id: a.subagent.id, taskKey: a.subagent.request.taskKey, status: a.subagent.status, role: a.subagent.request.role }] as const] : [])).values()]
        const answers = taskLineage(completeMessages, previous).filter(entry => entry.interaction?.status === 'answered').map(entry => ({question: entry.interaction!.question, answer: entry.interaction!.answer}))
        const credentialSources = new Set(task?.control?.operations.flatMap(op => op.credentialSource ? [JSON.stringify(op.credentialSource)] : []))
        const handoff = [
          'Continue the unfinished request. Do not repeat completed slices. Validate current targets before writes. Reuse verified results and existing child IDs.',
          `Original request: ${expandedRequest ?? task?.originalRequest ?? instruction?.content ?? ''}`,
          ...(instruction && originalUser?.id !== instruction.id ? [`Latest user instruction: ${instruction.content}`] : []),
          `Last recorded branch (revalidate): ${task?.lastKnownBranch ?? 'unknown'}`,
          `Recorded modified paths: ${[...new Set(activities.flatMap(a => a.changes?.filter(c => c.status === 'applied').map(c => c.path) ?? []))].join(', ') || 'none'}`,
          `Recent operations:\n${recent || 'none'}\nLast verification results:\n${verified || 'none'}`,
          `Pending: ${task?.pendingActions.join('; ') || 'Inspect remaining steps.'}`,
          ...(credentialSources.size ? [`Previous command credential references (ask again before use): ${[...credentialSources].join(', ')}`] : []),
          ...(answers.length ? [`Saved questions and user answers: ${JSON.stringify(answers)}`] : []),
          ...(children.length ? [`Saved child executions: ${JSON.stringify(children)}. Inspect or resume the existing ID before considering another assignment.`] : []),
        ].join('\n')
        // Put the original task attachments on the final request so provider history fitting keeps them.
        const attachments = [...new Map([...(originalUser?.attachments ?? []), ...(instruction?.attachments ?? [])].map(a => [a.id, a])).values()]
        const attached = new Set(attachments.map(a => a.id))
        messages = [...messages.map(m => m.attachments?.some(a => attached.has(a.id)) ? { ...m, attachments: m.attachments.filter(a => !attached.has(a.id)) } : m),
          { id: randomUUID(), role: 'user', status: 'complete', createdAt: Date.now(), content: handoff, attachments }]

      }
      if (reply.execution) {
        reply.execution.providerId = this.hooks.usageProviderId?.(provider) ?? (this.hooks.resource === 'local' || this.hooks.origin === 'athena-local' ? 'local-ai' : 'unknown')
        if (provider.modelId) reply.execution.modelId = provider.modelId.slice(0, 200)
        const prior = resuming ? resumeEvidence(completeMessages)?.execution?.taskCheckpoint : undefined
        if (prior?.provider && prior.provider !== reply.execution.providerId && !migrationAuthorized) {
          migrationAuthorized = await this.approve({ title: 'Resume with the selected provider', description: `Transfer saved task context from ${prior.provider} to ${reply.execution.providerId}? The selected provider's billing and data handling apply. No credentials or native session will be transferred.`, fullAccessEligible: false }, generation.abort.signal)
          if (!migrationAuthorized) throw new ChatError('Provider transfer was declined. Completed work remains saved.')
        }
        if (prior && reply.execution.taskCheckpoint) {
          reply.execution.taskCheckpoint.migration = { fromTaskId: prior.taskId, fromProvider: prior.provider, fromModel: prior.model, authorized: true }
          log('ai.task_migration', { taskId: reply.id, fromTaskId: prior.taskId, fromProvider: prior.provider ?? 'unknown', fromModel: prior.model, provider: reply.execution.providerId ?? 'unknown', model: provider.modelId ?? session.config.model ?? 'default', accountTransfer: migrationAuthorized })
        }
      }
      const historyFit = provider.promptHistoryLimitBytes && this.contextPolicy(session).automaticCompaction ? fitConversationHistory(messages, provider.promptHistoryLimitBytes) : undefined
      const historyLimitBytes = provider.promptHistoryLimitBytes ?? 0
      if (historyFit?.compacted) {
        messages = historyFit.messages
        const optimizedNotice = 'Conversation context optimized. Older turns were summarized for this provider; the full conversation and attachments remain saved.'
        if (reply.execution) reply.execution.budgetNotice = optimizedNotice
        log('ai.context_compacted', { provider: provider.constructor.name, model: provider.modelId ?? session.config.model ?? 'unknown', conversationId: session.id, executionId: reply.id,
          estimatedPromptTokens: Math.ceil(historyFit.finalBytes / 3), serializedPayloadBytes: historyFit.finalBytes, historyBytes: historyFit.originalBytes,
          projectContextBytes: 0, attachmentCount: 0, attachmentBytes: 0, compactionStatus: 'history-summary', estimatedContextRemaining: Math.max(0, historyLimitBytes - historyFit.finalBytes), safetyMarginBytes: Math.max(0, historyLimitBytes - historyFit.finalBytes) })
      }
      const activityTimeout = provider.executionTimeoutPolicy === 'activity'
      cursorNativeChanges = activityTimeout
      const progressTimed = activityTimeout || session.workspaces.length > 0
      generation.activityTimeout = progressTimed
      const policy = this.contextPolicy(session)
      const taskInactivityMs = policy.acpInactivityMinutes * 60_000
      // Native ACP tools use their own window, independent of prompt response
      // timing and of the non-ACP overall task deadline.
      const toolInactivityMs = policy.acpToolInactivityMinutes * 60_000
      const refreshTaskDeadline = () => {
        if (!progressTimed || this.generation !== generation || reply.execution?.approval) return
        clearTimeout(generation.timeout)
        const runningTool = reply.execution?.streamPhase === 'running-tools'
        if (!activityTimeout) {
          generation.timeout = setTimeout(() => this.stopSession(session.id, `No execution progress for ${policy.maxExecutionMinutes} minutes. Last active operation: ${reply.execution?.activities.findLast(a => a.status === 'running')?.tool ?? 'provider response'}. Inspect Activity before resuming.`, true, 'task_deadline'), policy.maxExecutionMinutes * 60_000)
          return
        }
        generation.timeout = setTimeout(() => this.stopSession(session.id, runningTool
          ? 'A provider tool did not complete within its execution window. Review Activity and the current project state before continuing.'
          : 'The provider made no meaningful progress within the configured inactivity window. Review Activity and the current project state before continuing.', true), runningTool ? toolInactivityMs : taskInactivityMs)
      }
      generation.resumeTimeout = refreshTaskDeadline
      refreshTaskDeadline()
      if (this.hooks.resource === 'local') log('ai.local_chat_pipeline', { traceId: reply.id, stage: 'provider-initialization-complete', durationMs: Math.round(performance.now() - providerStarted), model: provider.modelId ?? session.config.model ?? 'selected-local-model' })
      if (reply.execution?.taskCheckpoint && provider.modelId) reply.execution.taskCheckpoint.model = provider.modelId
      if (this.generation !== generation) return
      const contextStarted = performance.now()
      const context = await this.hooks.prepare?.({ ...session, config: { ...session.config, contextSettings: policy } }, messages, generation.abort.signal)
      if (this.hooks.resource === 'local') log('ai.local_chat_pipeline', { traceId: reply.id, stage: 'context-preparation-complete', durationMs: Math.round(performance.now() - contextStarted), tools: context?.projectTools?.definitions.length ?? 0, repositoryCharacters: context?.repositoryText.length ?? 0 })
      if (provider.constructor.name === 'AntigravityProvider') log('ai.antigravity_execution', { executionId: reply.id, model: provider.modelId ?? 'unselected', stage: 'context-prepared', durationMs: Math.round(performance.now() - contextStarted), attachmentCount: context?.attachments.length ?? 0, repositoryBytes: Buffer.byteLength(context?.repositoryText ?? '', 'utf8') })
      const preparedHistoryBytes = Buffer.byteLength(JSON.stringify(messages.map(({ role, content, attachments }) => ({ role, content, attachments }))), 'utf8')
      const preparedProjectBytes = Buffer.byteLength(context?.repositoryText ?? '', 'utf8')
      const preparedAttachmentBytes = (context?.attachments ?? []).reduce((sum, attachment) => sum + Buffer.byteLength(attachment.data, 'utf8'), 0)
      const preparedBytes = preparedHistoryBytes + preparedProjectBytes + preparedAttachmentBytes
      log('ai.context_prepared', { provider: provider.constructor.name, model: provider.modelId ?? session.config.model ?? 'unknown', conversationId: session.id, executionId: reply.id,
        estimatedPromptTokens: Math.ceil(preparedBytes / 3), serializedPayloadBytes: preparedBytes, historyBytes: preparedHistoryBytes,
        projectContextBytes: preparedProjectBytes, attachmentCount: context?.attachments.length ?? 0, attachmentBytes: preparedAttachmentBytes,
        compactionStatus: historyFit?.compacted ? 'structured-history-summary' : provider.promptHistoryLimitBytes ? 'within-history-budget' : 'provider-managed',
        estimatedContextRemaining: provider.promptHistoryLimitBytes ? Math.max(0, provider.promptHistoryLimitBytes - preparedHistoryBytes) : -1,
        safetyMarginBytes: provider.promptHistoryLimitBytes ? Math.max(0, provider.promptHistoryLimitBytes - preparedHistoryBytes) : -1 })
      if (resuming && session.workspaces.length && !context?.projectTools?.definitions.length && !provider.nativeAgent) throw new ChatError('The selected model has no verified project tool support. Choose an agent-capable model to resume this coding task. Completed work is preserved.')
      if (context?.repositoryRef && reply.execution?.taskCheckpoint) {
        if (priorIdentity?.repositoryRef && priorIdentity.repositoryRef !== context.repositoryRef) throw new ChatError(`The repository changed from ${priorIdentity.repositoryRef} to ${context.repositoryRef}. Resume on the original branch or start a new task for this branch.`)
        reply.execution.taskCheckpoint.repositoryRef = context.repositoryRef
      }
      if (resuming) {
        const verifiedFiles = new Map<string, string | null>()
        for (const msg of taskLineage(completeMessages, resumeEvidence(completeMessages))) for (const a of msg.execution?.activities ?? []) for (const change of a.changes ?? []) {
          // Earlier releases recorded paths without hashes. A later write to
          // such a path needs review even after the current file has been read.
          if (change.status === 'applied') verifiedFiles.set(change.path, change.afterHash ?? (change.beforeHash ? null : 'unverified'))
          else verifiedFiles.delete(change.path)
        }
        context?.projectTools?.continuation?.(verifiedFiles)
      }
      if (context?.sources) reply.sources = context.sources
      if (context?.notice) this.state.contextNotice = [this.state.contextNotice, context.notice].filter(Boolean).join(' ')
      if (this.generation !== generation) return
      let complete = false
      const previousTask = resuming ? resumeEvidence(completeMessages)?.execution?.taskCheckpoint : undefined
      if (reply.execution?.taskCheckpoint && previousTask) {
        reply.execution.taskCheckpoint.parentTaskId = previousTask.taskId
        reply.execution.taskCheckpoint.recoveryAttempts = (previousTask.recoveryAttempts ?? 0) + 1
      }
      const continuation = new ContinuationController(policy, (state, durable) => {
        if (this.generation !== generation || !reply.execution?.taskCheckpoint) return
        reply.execution.taskCheckpoint.control = state
        this.checkpointTask(reply, session)
        if (!durable && !this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 500)
        if (durable && !this.save()) throw new ChatError('The task checkpoint could not be saved. Execution stopped before the next operation to avoid losing recovery records. Check disk space and folder permissions; completed work is preserved.')
      }, previousTask?.control, { taskId: reply.id, conversationId: session.id, provider: reply.execution?.providerId ?? 'unknown', model: provider.modelId ?? session.config.model ?? 'default', effort: session.config.effort, mode: session.config.agentMode ?? 'ask' })
      if (reply.execution?.taskCheckpoint) reply.execution.taskCheckpoint.control = structuredClone(continuation.state)
      // Track the existing executor at its shared boundary. This also covers
      // native SDK/app-server adapters that do not use ToolCallSession.
      if (context?.projectTools) {
        const tools = context.projectTools
        context.projectTools = { ...tools, executionTrackedByHost: true, execute: async (name, input, signal) => {
          signal.throwIfAborted(); tools.assertAccess()
          const risk = classifyOperation(tools, name, input), readOnly = risk === 'read-only'
          if (continuation.isReplay(name, input)) log('ai.operation_replay', { executionId: reply.id, tool: name, risk, confirmationRequired: !readOnly })
          const prior = continuation.previousAttempt(name, input)
          if (!readOnly && prior && (continuation.isReplay(name, input) || risk === 'non-idempotent' || risk === 'destructive' || name === 'execute_command')) {
            const allowed = await this.approve({ title: 'Confirm repeat of a saved operation', description: `This ${name} operation was already attempted in this task. Its effects may already exist. Inspect current Activity and project state before allowing it again.`, fullAccessEligible: false }, signal)
            if (!allowed) {
              const rejection = JSON.stringify({ ok: false, error: { code: 'uncertain_replay', message: `Permission denied for the repeat of ${name}. The operation was not executed.` } })
              const guard = continuation.operationStarted('replay_guard', { tool: name, fingerprint: prior.key }, 'read-only')
              continuation.operationFinished(guard, rejection)
              return rejection
            }
          }
          signal.throwIfAborted(); tools.assertAccess()
          const key = continuation.operationStarted(name, input, risk)
          let output: string
          try { output = await tools.execute(name, input, signal) }
          catch (error) { continuation.operationFinished(key, JSON.stringify({ ok: false, error: signal.aborted ? 'Cancelled' : error instanceof ChatError ? error.userMessage : 'Unverified operation' })); throw error }
          continuation.operationFinished(key, output)
          refreshTaskDeadline()
          return output
        } }
      }
      for await (const chunk of provider.streamMessage(messages, { signal: generation.abort.signal, effort: session.config.effort, context, contextSettings: policy, checkpoint, storeArtifact: this.hooks.storeArtifact,
        continuation,
        reliabilityIdentity: { provider: session.config.accountRoute?.provider ?? this.hooks.usageProviderId?.(provider) ?? 'api', model: provider.modelId ?? session.config.model ?? 'configured-model' },
        runtimeCapacity: provider.contextLimits,
        modelContextWindow: policy.modelContextWindows[contextModelKey(provider.modelId ?? session.config.model ?? '', session.config.accountRoute)],
        onResponseModel: model => { if (this.generation === generation && reply.execution?.taskCheckpoint && /^[a-zA-Z0-9._:/-]{1,200}$/.test(model)) reply.execution.taskCheckpoint.responseModel = model },
        onNativeSession: id => { if (reply.execution?.taskCheckpoint && this.generation === generation) { reply.execution.taskCheckpoint.nativeSessionId = id.slice(0, 256); this.save() } },
        activeRequest: [...messages].reverse().find(message => message.role === 'user')?.content,
        onMeaningfulProgress: refreshTaskDeadline,
        traceId: reply.id,
        onLocalInferenceTrace: event => log('ai.local_inference_trace', { traceId: reply.id, fromInputMs: Math.round(performance.now() - generation.startedAt), ...event }),
        executionId: reply.id,
        conversationId: session.id,
        diagnosticCounts: () => ({
          completedTools: reply.execution?.activities.filter((activity) => activity.status === 'complete').length ?? 0,
          fileChanges: new Set(reply.execution?.activities.flatMap((activity) => activity.changes?.filter((change) => change.status === 'applied').map((change) => change.path) ?? []) ?? []).size,
        }),
        onStreamPhase: (phase) => {
          if (this.generation !== generation || !reply.execution) return
          if (reply.execution.streamPhase !== phase) { reply.execution.streamPhase = phase; reply.execution.updatedAt = Date.now(); refreshTaskDeadline(); this.publish() }
          if (reply.execution.taskCheckpoint?.control) reply.execution.taskCheckpoint.control.status = phase === 'waiting-approval' ? 'waiting-permission' : phase === 'running-tools' ? 'waiting-tool' : 'running'
        },
        onStreamDiagnostic: (diagnostic) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.streamDiagnostics = [...(reply.execution.streamDiagnostics ?? []), diagnostic].slice(-20)
          reply.execution.updatedAt = Date.now(); this.save(); this.publish()
        },
        permissionMode: session.config.agentMode ?? 'ask',
        permissionStateVersion: this.permissionVersions.get(session.id) ?? 0,
        onBudget: (notice) => {
          if (this.generation !== generation || !reply.execution || reply.execution.budgetNotice === notice) return
          reply.execution.budgetNotice = notice; this.publish()
        },
        onBudgetSummary: (summary) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.budgetSummary = summary
          reply.execution.updatedAt = Date.now(); this.save(); this.publish()
        },
        requestApproval: async (title, description, signal, changes, rememberScope, fullAccessEligible, operation) => {
          const input = { title, description }
          const risk = operation?.risk ?? 'unknown'
          const replay = risk !== 'read-only' && resuming && continuation.isReplay('native_permission', input)
          const allowed = await this.approve({ title: replay ? `Confirm repeat: ${title}` : title, description: replay ? `This native operation was already authorized during the saved task and may have taken effect. Inspect current state before repeating it.\n\n${description}` : description, changes, rememberScope: replay ? undefined : rememberScope, fullAccessEligible: replay ? false : fullAccessEligible }, signal)
          const grant = continuation.operationStarted('native_permission', input, risk)
          continuation.operationFinished(grant, JSON.stringify(allowed ? {ok:true} : {error:'Permission denied'}))
          return allowed
        },
        onPromptBudget: budget => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.promptBudget = { ...budget, routeKey: contextModelKey(provider.modelId ?? session.config.model ?? '', session.config.accountRoute) }
          this.publish()
        },
        onUsage: (usage) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.contextUsage = usage; reply.execution.updatedAt = Date.now(); this.publish()
        },
        onModelResponse: (usage) => {
          if (this.generation !== generation || !reply.execution) return
          const previous = reply.execution.providerUsage
          reply.execution.providerUsage = {
            inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
            cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
            cacheCreationInputTokens: (previous?.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
            outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
            reasoningTokens: (previous?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
            requestCount: (previous?.requestCount ?? 0) + 1,
            incompleteRequests: previous?.incompleteRequests,
            estimated: Boolean(previous?.estimated || usage.estimated), updatedAt: Date.now(),
          }
          reply.execution.updatedAt = Date.now(); this.publish()
        },
        onModelRequestUnresolved: () => {
          if (this.generation !== generation || !reply.execution) return
          const previous = reply.execution.providerUsage
          reply.execution.providerUsage = {
            inputTokens: previous?.inputTokens ?? 0, cachedInputTokens: previous?.cachedInputTokens ?? 0,
            cacheCreationInputTokens: previous?.cacheCreationInputTokens ?? 0, outputTokens: previous?.outputTokens ?? 0,
            reasoningTokens: previous?.reasoningTokens ?? 0, requestCount: previous?.requestCount ?? 0,
            incompleteRequests: (previous?.incompleteRequests ?? 0) + 1, estimated: true, updatedAt: Date.now(),
          }
          reply.execution.updatedAt = Date.now(); this.publish()
        },
        onRecovery: (recovery) => {
          if (this.generation !== generation || !reply.execution) return
          reply.execution.recovery = recovery
          if (reply.execution.taskCheckpoint) reply.execution.taskCheckpoint.pendingActions = [...recovery.pendingTools.map((tool) => `Unexecuted interrupted request: ${tool}`), 'Finish the original request; review current files and verification before further changes.']
          this.checkpointTask(reply, session)
          reply.execution.updatedAt = Date.now(); this.phase('thinking'); this.save(); this.publish()
        },
        onCheckpointUnavailable: () => {
          if (this.generation === generation && session.contextCheckpoint) { session.contextCheckpoint = undefined; this.save() }
        },
        onCheckpoint: (input) => {
          if (this.generation !== generation || !completeMessages.length || !policy.taskCheckpoints) return
          session.contextCheckpoint = { fingerprint: contextFingerprint(session, completeMessages), coveredThrough: completeMessages.at(-1)!.id, savedAt: Date.now(), input: input as unknown as Array<Record<string, unknown>> }
          this.save()
        },
      })) {
        if (this.generation !== generation) return
        if (chunk.type === 'done') { complete = true; break }
        if (chunk.type === 'interaction') {
          const parsed = choiceInteractionSchema.safeParse(chunk.interaction)
          if (parsed.success && parsed.data.conversationId === session.id && parsed.data.messageId === reply.id) {
            reply.interaction = parsed.data
            if (reply.execution) reply.execution.updatedAt = Date.now()
            this.publish()
          }
          continue
        }
        if (chunk.type === 'activity') {
          const existing = reply.execution?.activities.find((activity) => activity.id === chunk.id)
          if (!existing && reply.execution && reply.execution.activities.length < 500) {
            reply.execution.activities.push({ id: chunk.id, tool: chunk.tool, label: chunk.label, status: chunk.status, startedAt: Date.now(), ...(chunk.status !== 'running' ? { finishedAt: Date.now() } : {}), ...(chunk.changes?.length ? { changes: chunk.changes } : {}) })
            this.timeline(reply, 'activity', undefined, chunk.id)
          } else if (existing) {
            existing.tool = chunk.tool
            existing.label = chunk.label
            existing.status = chunk.status
            if (chunk.status !== 'running') existing.finishedAt ??= Date.now()
            if (chunk.changes?.length) {
              const changes = new Map((existing.changes ?? []).map((change) => [change.id, change]))
              for (const change of chunk.changes) changes.set(change.id, change)
              existing.changes = [...changes.values()]
            }
          }
          if (reply.execution) reply.execution.updatedAt = Date.now()
          if (activityTimeout && chunk.status !== 'running') { this.checkpointTask(reply, session); this.save() }
          if (activityTimeout && chunk.status !== 'running') refreshTaskDeadline()
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
        if (progressTimed && chunk.text.trim()) refreshTaskDeadline()
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
      reply.interaction ??= parseChoiceInteraction(reply.content, { conversationId: session.id, messageId: reply.id })?.interaction
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
      if (reply.execution?.taskCheckpoint) {
        // A normal provider turn end is not proof that a development objective
        // was verified. Preserve unresolved operations and interactive pauses.
        const latestByTool = new Map(reply.execution.activities.map(activity => [activity.tool, activity]))
        const latestByInput = new Map(continuation.state.operations.filter(op => op.runId === reply.id).map(op => [op.key, op]))
        const unresolvedCommand = [...latestByInput.values()].some(op => op.tool === 'execute_command' && op.status !== 'complete')
        const failed = unresolvedCommand || [...latestByTool.values()].some(activity => (activity.status === 'error' || activity.status === 'cancelled') && activity.summary !== 'This operation already succeeded in this request; do not duplicate it.')
        if (!failed && !reply.interaction) reply.execution.taskCheckpoint.pendingActions = []
        if (failed && !reply.interaction) reply.execution.taskCheckpoint.pendingActions = ['Review failed or unconfirmed operations in Activity and verify the remaining objective.']
        if (reply.execution.taskCheckpoint.control) reply.execution.taskCheckpoint.control.status = reply.interaction ? 'waiting-user' : failed ? 'blocked' : 'responded'
      }
      log('ai.request_completed')
      log('ai.task_outcome', { provider: reply.execution?.providerId ?? 'unknown', model: reply.execution?.modelId ?? session.config.model ?? 'default', effort: session.config.effort, taskId: reply.id, conversationId: session.id, durationMs: Date.now() - reply.createdAt, status: reply.execution?.taskCheckpoint?.control?.status ?? 'responded', continuations: continuation.state.continuations, compactions: continuation.state.compactions, toolCalls: reply.execution?.activities.length ?? continuation.state.toolCalls })
    } catch (error) {
      if (this.generation !== generation) return
      reply.status = 'error'
      if (reply.execution) reply.execution.streamPhase = 'paused'
      reply.error = error instanceof ChatError ? error.userMessage : 'Athena could not complete the request. Please retry.'
      if (reply.execution?.taskCheckpoint?.control) {
        reply.execution.taskCheckpoint.control.status = 'resumable'
        reply.execution.taskCheckpoint.control.stopReason ??= 'provider-or-tool-interrupted'
      }
      if (error instanceof ChatError && error.code === 'auth-reconnect' && reply.execution) {
        reply.execution.status = 'waiting-auth'
        if (reply.execution.taskCheckpoint) reply.execution.taskCheckpoint.pendingActions = ['Reconnect the same ChatGPT account, inspect current project state, then continue unfinished work without repeating completed changes.']
        this.timeline(reply, 'status', 'ChatGPT authorization needs reconnection. Completed operations and file changes remain recorded.')
      } else if (error instanceof ChatError && error.code === 'auth-refreshed') this.timeline(reply, 'status', 'ChatGPT authorization was renewed. Continue the unfinished task from the recorded results.')
      if (reply.execution?.activities.length) {
        const finished = reply.execution.activities.filter((activity) => activity.status === 'complete').length
        const modified = new Set(reply.execution.activities.flatMap((activity) => activity.changes?.filter((change) => change.status === 'applied').map((change) => change.path) ?? [])).size
        reply.error += modified || !cursorNativeChanges
          ? ` ${finished} completed operations; ${modified} recorded file change${modified === 1 ? '' : 's'}. See Activity for results and remaining verification before resuming.`
          : ` ${finished} completed operations. Athena has no verified file-change count for this turn; inspect the project before resuming.`
      }
      this.state.error = reply.error
      log('ai.request_failed')
    } finally {
      this.nativeSteering.delete(this.current().id)
      clearTimeout(generation.timeout)
      if (this.generation === generation) {
        if (reply.execution) { for (const activity of reply.execution.activities) if (activity.status === 'running') { activity.status = 'cancelled'; activity.finishedAt = Date.now(); activity.summary = 'The provider did not report a final status for this operation.' }; this.checkpointTask(reply, this.current()); if (reply.execution.recovery) reply.execution.recovery.continuing = false; reply.execution.finishedAt = Date.now(); if (reply.execution.status !== 'waiting-auth') reply.execution.status = reply.status === 'complete' && reply.execution.taskCheckpoint?.control?.status !== 'blocked' ? 'complete' : 'error' }
        generation.abort.abort()
        generation.releaseResource?.(); generation.releaseResource = undefined
        this.generation = undefined
        this.applyPendingCursorModel()
        this.phase('idle'); this.publish(true)
        this.hooks.taskEnded?.(this.current().id, reply)
        const session = this.current()
        if (!(this.hooks.isViewed?.(session.id) ?? session.id === this.library.activeId)) {
          session.unreadCompletion = reply.status === 'complete' && reply.execution?.status !== 'error' ? 'complete' : 'failed'
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
  stop(message?: string, failed = false, reason?: StreamFailureKind): ChatResult {
    const generation = this.generation
    if (!generation) return { ok: true }
    this.generation = undefined
    generation.abort.abort(reason ? new StreamFault(reason, message ?? 'Execution stopped.') : undefined); clearTimeout(generation.timeout)
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
      if (reply.execution.taskCheckpoint?.control) { reply.execution.taskCheckpoint.control.status = failed ? 'resumable' : 'cancelled'; reply.execution.taskCheckpoint.control.stopReason = reason ?? (failed ? 'execution-deadline-or-permission-change' : 'user-cancelled') }
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
  stopSession(id: string, message?: string, failed = false, reason?: StreamFailureKind): ChatResult { return this.executionScope.run(id, () => this.stop(message, failed, reason)) }
  stopAll(message?: string): void {
    this.drainingPaused = true
    try { for (const id of [...this.generations.keys()]) this.stopSession(id, message) }
    finally { this.drainingPaused = false; this.drain() }
  }
  clear(): ChatResult {
    this.clearHandsFreeContext()
    this.stop()
    this.media?.release(this.current())
    if(this.current().nativeCodex){this.storage?.archive(this.current());this.current().nativeCodex=undefined}
    this.current().messages = []; this.current().contextCheckpoint = undefined; this.state.messages = this.current().messages; this.current().attachments = []; this.current().draft = ''; this.state.error = null
    this.publish()
    return { ok: true }
  }
  dispose(): void {
    this.media?.dispose()
    this.disposed = true
    this.cancelHandsFreeReply()
    this.stopAll()
    for (const timer of this.publishTimers.values()) clearTimeout(timer)
    this.publishTimers.clear()
    this.save()
    this.state.messages = []
  }
}

function resumeEvidence(messages: ChatMessage[]): ChatMessage | undefined {
  const last = messages.findLast(message => message.role === 'assistant' && message.execution?.taskCheckpoint)
  if (!last) return undefined
  // A reconnect or initialization failure can have an empty control record.
  // Follow only this task’s parents, never take receipts from another user task.
  return taskLineage(messages, last).reverse().find(m => m.execution?.activities.length || m.execution?.taskCheckpoint?.control?.operations.length) ?? last
}

function taskLineage(messages: ChatMessage[], last?: ChatMessage): ChatMessage[] {
  const byId = new Map(messages.map(message => [message.id, message]))
  const result: ChatMessage[] = [], seen = new Set<string>()
  while (last && !seen.has(last.id)) {
    seen.add(last.id); result.push(last)
    last = byId.get(last.execution?.taskCheckpoint?.parentTaskId ?? '')
  }
  return result.reverse()
}
