import { z } from 'zod'
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses'
import { ChatError, type ProjectTools } from './AIProvider'
import { limitToolOutput } from './toolOutput'
import { log } from '../logger'
import type { ContinuationController } from './continuationController'
import { classifyOperation } from './operationRisk'

const callEnvelope = z.object({
  call_id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  arguments: z.string(),
  status: z.literal('completed').optional(),
})
const failure = (code: string, message: string) => JSON.stringify({ ok: false, error: { code, message } })

// One instance per request, retained across tool rounds and context recovery.
// Domain executors still own Zod argument schemas, permissions and approvals.
export class ToolCallSession {
  private seen = new Set<string>()
  private deferred = new Set<string>()
  private attemptedOperations = new Set<string>()
  private recoveryGuard = false
  private count = 0
  constructor(private tools: ProjectTools, private signal: AbortSignal, readonly limit: number, private control?: ContinuationController) {}
  get exhausted(): boolean { return this.count >= this.limit }
  get used(): number { return this.count }
  get remaining(): number { return Math.max(0, this.limit - this.count) }
  guardRecovery(): void { this.recoveryGuard = true }
  endRecoveryGuard(): void { this.recoveryGuard = false }

  validateBatch(calls: ResponseFunctionToolCall[]): void {
    const ids = new Set<string>()
    for (const call of calls) {
      if (!callEnvelope.safeParse(call).success) throw new ChatError('The provider returned invalid or unfinished tool arguments. No tools from this response were executed.')
      if (ids.has(call.call_id) || this.seen.has(call.call_id)) throw new ChatError('The provider repeated a tool call identifier. Execution stopped to avoid repeating actions. Earlier completed results are preserved.')
      ids.add(call.call_id)
    }
    if (calls.length > this.remaining) {
      if (!this.tools.executionBudget) throw new ChatError(`The provider requested ${calls.length} tools with only ${this.remaining} remaining. No tool from this batch was executed; continue from recorded results.`)
      // Only a wholly independent read-only batch may be partially dispatched.
      // Never partially execute dependent edits/commands. Return one explicit
      // result for EVERY call, including deferred calls, to keep protocol order.
      const count = calls.every(call => this.tools.definitions.some(tool => tool.name === call.name) && this.tools.parallelSafe?.(call.name)) ? this.remaining : 0
      for (const call of calls.slice(count)) this.deferred.add(call.call_id)
      this.tools.executionBudget.batchLimited(calls.length, count)
    }
    for (const id of ids) this.seen.add(id)
    this.control?.batch()
  }

  async executeBatch(calls: ResponseFunctionToolCall[], maxOutputChars: number): Promise<string[]> {
    this.validateBatch(calls)
    const execute = (call: ResponseFunctionToolCall) => this.execute(call, maxOutputChars)
    if (calls.length < 2 || !calls.every((call) => this.tools.parallelSafe?.(call.name))) {
      const results: string[] = []
      for (const call of calls) results.push(await execute(call))
      return results
    }
    const results: string[] = []
    // Only the executor's explicit read-only allowlist can reach this path.
    // Keep concurrency bounded and preserve provider order in the returned array.
    for (let start = 0; start < calls.length; start += 4) {
      results.push(...await Promise.all(calls.slice(start, start + 4).map(execute)))
    }
    return results
  }

  private checkAccess(): void {
    if (this.signal.aborted) {
      const timedOut = this.signal.reason instanceof Error && this.signal.reason.name === 'TimeoutError'
      throw new ChatError(timedOut
        ? 'The chat request exceeded its time limit. Completed actions are preserved; retry or continue after reviewing Activity.'
        : 'Tool execution was cancelled. Completed actions are preserved.')
    }
    this.tools.assertAccess()
  }

  async execute(call: ResponseFunctionToolCall, maxOutputChars: number): Promise<string> {
    this.checkAccess()
    if (this.deferred.has(call.call_id)) return failure('tool_budget_deferred', 'This call was NOT executed because it did not fit the remaining budget. Finish from collected evidence; report missing evidence as incomplete. Do not retry this batch.')
    if (this.count >= this.limit) return failure('tool_limit', 'Tool limit reached. Finish using existing evidence; do not claim remaining actions completed.')
    this.tools.executionBudget?.toolAttempt()
    this.count++
    const finish = (output: string) => {
      const bounded = limitToolOutput(output, maxOutputChars)
      this.tools.executionBudget?.toolResult(call.name, call.arguments, bounded)
      return bounded
    }
    if (!this.tools.definitions.some((tool) => tool.name === call.name)) {
      log('automation.tool_dispatch', { stage: 'tool-not-registered', toolName: call.name })
      return finish(failure('unknown_tool', 'This tool is not available for the current request. No action was performed.'))
    }
    let args: unknown
    try {
      if (Buffer.byteLength(call.arguments, 'utf8') > (this.tools.maxArgumentBytes ?? 8000)) throw new Error()
      args = JSON.parse(call.arguments)
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error()
    } catch {
      log('automation.tool_dispatch', { stage: 'invalid-arguments', toolName: call.name })
      return finish(failure('invalid_arguments', 'Arguments must be a complete JSON object within the tool size limit. No action was performed.'))
    }
    const operationKey = `${call.name}:${JSON.stringify(args)}`
    const risk = classifyOperation(this.tools, call.name, args), readOnly = risk === 'read-only'
    if (!this.tools.executionTrackedByHost && !readOnly && this.control?.isReplay(call.name, args)) {
      return finish(failure('uncertain_replay', 'This mutation or command was already attempted in the saved task. It was NOT replayed. Inspect current files and results first. Request explicit approval for a repeat in a new user instruction if the same non-idempotent operation is necessary.'))
    }
    if (this.recoveryGuard && !readOnly && this.attemptedOperations.has(operationKey)) {
      return finish(failure('uncertain_replay', 'This exact command or mutation was attempted before recovery. It was NOT replayed. Inspect current file/Git state and use a new, evidence-based action only if still needed.'))
    }
    if (!readOnly) this.attemptedOperations.add(operationKey)
    let result: string
    const receipt = !this.tools.executionTrackedByHost ? this.control?.operationStarted(call.name, args, risk) : undefined
    try {
      // This guard is intentionally immediately before the executor, not just
      // before the API request: a user can revoke access during generation.
      this.checkAccess()
      result = await this.tools.execute(call.name, args, this.signal)
    } catch (error) {
      this.checkAccess()
      if (error instanceof ChatError) { log('automation.tool_dispatch', { stage: 'handler-failed', toolName: call.name, classification: /permission|denied|not approved/i.test(error.userMessage) ? 'permission-denied' : 'action-error' }); throw error }
      result = failure('execution_failed', 'The tool failed without a confirmed result. Do not claim success or blindly repeat an action that may have taken effect.')
    }
    this.checkAccess()
    if (receipt) this.control?.operationFinished(receipt, result)
    return finish(result)
  }
}
