import { createHash } from 'node:crypto'
import { contextDefaults, type ContextSettings } from '../../../shared/context'
import type { TaskControlState, OperationRisk } from '../../../shared/generation'
import { ChatError, type StreamOptions } from './AIProvider'
import { log } from '../logger'

export const CONTINUE_TASK = 'Continue only the unfinished part of the original request. Completed tool results remain authoritative records of execution, not proof of current file state. Do not replay completed or uncertain mutations. Incomplete tool calls were not executed. Read current versions before further changes. Return a final answer when the requested work is complete or explain the actual blocker.'

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')

/** One controller per host execution. Native runtimes never receive automatic
 * prompt resubmissions from this controller. Protocol adapters explicitly opt in
 * only for an unfinished, fully received provider response. */
export class ContinuationController {
  readonly settings: ContextSettings
  readonly state: TaskControlState
  private previousCompaction?: string
  private stagnant = 0
  private observations = new Set<string>()
  private resumedOperations: Set<string>
  private responses = new Map<string, number>()
  constructor(settings: Partial<ContextSettings> = {}, private publish: (state: TaskControlState) => void = () => {}, previous?: TaskControlState, private identity: Record<string, string> = {}) {
    this.settings = { ...contextDefaults(), ...settings }
    this.state = { continuations: 0, compactions: 0, transportRecoveries: 0, toolCalls: 0, toolRounds: 0, status: 'running', operations: [...(previous?.operations ?? [])] }
    // The current executor reclassifies the exact requested arguments. Saved
    // readOnly flags may be legacy/misclassified and are not authorization.
    this.resumedOperations = new Set(this.state.operations.map(item => item.key))
  }
  private emit() { this.publish(structuredClone(this.state)) }
  stop(reason: string, message: string): never {
    this.state.status = 'resumable'; this.state.stopReason = reason; this.emit()
    log('ai.task_stopped', { ...this.identity, reason, continuations: this.state.continuations, compactions: this.state.compactions, toolCalls: this.state.toolCalls })
    throw new ChatError(message)
  }
  canContinue(): boolean { return this.settings.automaticContinuation && this.state.continuations < this.settings.maxContinuations }
  recoverTransport(): boolean {
    if (!this.settings.safeTaskRecovery || this.state.transportRecoveries >= this.settings.maxStreamRecoveries * 4) return false
    this.state.transportRecoveries++; this.emit(); return true
  }
  continue(reason: string, response: unknown): void {
    if (!this.canContinue()) this.stop('continuation-allowance', `Athena's automatic continuation allowance was reached (${this.state.continuations}/${this.settings.maxContinuations}). The task is unfinished; completed operations are saved. Resume Task after reviewing Activity, or adjust Automatic Continuation & Context Management. Context compactions and successful tool rounds do not consume this allowance.`)
    const key = hash(response), repeats = (this.responses.get(key) ?? 0) + 1
    this.responses.set(key, repeats)
    if (this.settings.stopOnNoProgress && repeats >= 3) this.stop('repeated-incomplete-response', 'The provider repeated the same incomplete response three times without progress. Completed work is saved; review the provider output limit before resuming.')
    this.state.continuations++; this.state.status = 'running'; this.emit()
    log('ai.task_continuation', { ...this.identity, reason, round: this.state.continuations, allowance: this.settings.maxContinuations })
  }
  beginCompaction(input: unknown): void {
    if (!this.settings.automaticCompaction) this.stop('compaction-disabled', 'Application context limit reached with automatic compaction disabled. Enable automatic compaction; original history and completed changes are preserved.')
    const digest = hash(input)
    if (digest === this.previousCompaction) this.stop('compaction-no-progress', 'Context compaction repeated without reducing the request. Original history is preserved. Reduce attachments or configure the correct model context window before resuming.')
    // Separate finite budget: no arbitrary three-compaction lifetime cap.
    if (this.state.compactions >= this.settings.maxAgentIterations * 2) this.stop('compaction-budget', 'The bounded context-compaction budget was reached. Completed operations are saved; review Activity before resuming.')
    this.previousCompaction = digest; this.state.compactions++; this.state.status = 'compacting'; this.emit()
  }
  context(tokens: number, window: number) { this.state.contextTokens = tokens; this.state.contextWindow = window; this.state.status = 'running'; this.emit() }
  batch(): void { this.state.toolRounds++; this.emit() }
  operationKey(tool: string, input: unknown): string { return hash({ tool, input }) }
  isReplay(tool: string, input: unknown): boolean { return this.resumedOperations.has(this.operationKey(tool, input)) }
  operationStarted(tool: string, input: unknown, classification: OperationRisk | boolean): string {
    const risk = typeof classification === 'boolean' ? classification ? 'read-only' : 'unknown' : classification
    const key = this.operationKey(tool, input)
    this.state.toolCalls++; this.state.status = 'waiting-tool'
    this.state.operations = [...this.state.operations, { key, tool, risk, readOnly: risk === 'read-only', status: 'started' as const, at: Date.now() }].slice(-1000)
    this.emit() // persisted BEFORE a side effect, including uncertain failures
    return key
  }
  operationFinished(key: string, output: string) {
    const operation = [...this.state.operations].reverse().find(item => item.key === key)
    let failed = false
    try { const data = JSON.parse(output); const result = data.result ?? data; failed = Boolean(data.error || result.error || result.ok === false || typeof result.exitCode === 'number' && result.exitCode !== 0) } catch { /* Text tools may have valid plain text output. */ }
    if (operation) operation.status = failed ? 'failed' : 'complete'
    const digest = hash({ key, output }), repeated = this.observations.has(digest)
    this.observations.add(digest)
    // A changed result (including a rerun after an edit) is new evidence.
    if (!failed && !repeated) { this.stagnant = 0; this.responses.clear() }
    else this.stagnant++
    this.state.status = 'running'; this.emit()
    if ((this.settings.stopOnNoProgress && failed || this.settings.stopOnRepeatedActions && repeated) && this.stagnant >= this.settings.noProgressWindow) this.stop('no-progress', `The last ${this.stagnant} repeated unsuccessful or unchanged operations produced no new evidence or verified changes. Completed work is saved. Inspect the blocker before resuming; no operation was retried automatically.`)
  }
}

export function continuationFor(options: StreamOptions): ContinuationController {
  return options.continuation ??= new ContinuationController(options.contextSettings ?? (options.generationSettings ? { maxContinuations: options.generationSettings.maxOutputContinuations } : undefined), undefined, undefined, { taskId: options.executionId ?? 'isolated', conversationId: options.conversationId ?? 'isolated' })
}
