import type { SubagentRun, SubagentSettings, SubagentBudget } from '../../../shared/subagents'
import { ChatError, type ModelRequestBudget, type ModelResponseUsage } from './AIProvider'

/** Reservations are outstanding request capacity, never completed consumption. */
export class SubagentBudgetLedger {
  readonly state: SubagentBudget
  constructor(private run: SubagentRun, settings: SubagentSettings) {
    const previous = run.budget
    this.state = run.budget = {
      version: 2, configuredTokens: settings.tokenBudget, requestedTokens: run.request.tokenBudget ?? null,
      effectiveTokens: Math.min(settings.tokenBudget, run.request.tokenBudget ?? settings.tokenBudget, previous?.effectiveTokens ?? Infinity),
      configuredContext: settings.contextTokens, requestedContext: run.request.contextTokens ?? null,
      effectiveContext: Math.min(settings.contextTokens, run.request.contextTokens ?? settings.contextTokens),
      modelContext: null, modelMaxOutput: null, modelLimitsVerified: false, outputLimitEnforced: false,
      measuredInput: previous?.measuredInput ?? 0, measuredOutput: previous?.measuredOutput ?? 0,
      estimatedInput: previous?.estimatedInput ?? run.inputTokens, estimatedOutput: previous?.estimatedOutput ?? run.outputTokens,
      reasoningTokens: previous?.reasoningTokens ?? 0, legacyEstimate: previous?.legacyEstimate ?? (run.inputTokens + run.outputTokens > 0),
      reservedInput: previous?.reservedInput ?? 0, reservedOutput: previous?.reservedOutput ?? 0,
      consumedTokens: 0, remainingTokens: 0, availableTokens: 0,
      settledRequests: previous?.settledRequests ?? 0, unknownRequests: previous?.unknownRequests ?? 0,
    }
    // A crash may have left a request in flight. Its usage is unknown, not free.
    this.interrupted()
    this.sync()
  }
  private sync(): void {
    const b = this.state
    this.run.inputTokens = b.measuredInput + b.estimatedInput
    this.run.outputTokens = b.measuredOutput + b.estimatedOutput
    b.consumedTokens = this.run.inputTokens + this.run.outputTokens
    b.remainingTokens = Math.max(0, b.effectiveTokens - b.consumedTokens)
    b.availableTokens = Math.max(0, b.remainingTokens - b.reservedInput - b.reservedOutput)
  }
  stop(code: NonNullable<SubagentBudget['termination']>['code'], message: string): never {
    this.state.termination = { code, message }
    throw new ChatError(message)
  }
  reserve(contextBytes: number, outputTokens: number, metadata?: ModelRequestBudget): void {
    this.interrupted() // An unreported failed attempt retains its reservation exactly once.
    const b = this.state
    const inputTokens = metadata?.inputTokens ?? Math.ceil(contextBytes / 3)
    if (![inputTokens, outputTokens].every(value => Number.isFinite(value) && value >= 0)) throw new ChatError('Provider returned invalid token-budget metadata. No request was started.')
    if (metadata) {
      b.modelContext = metadata.contextWindow; b.modelMaxOutput = metadata.maxOutputTokens
      b.modelLimitsVerified = metadata.limitsVerified; b.outputLimitEnforced = metadata.outputLimitEnforced
      b.effectiveContext = Math.min(b.configuredContext, b.requestedContext ?? b.configuredContext, metadata.contextWindow)
    }
    b.lastRequest = { inputTokens, outputTokens, requiredTokens: inputTokens + outputTokens, remainingBefore: b.remainingTokens, inputEstimated: metadata?.inputEstimated ?? true }
    if (inputTokens + outputTokens > b.effectiveContext) this.stop('context', `Sub-agent context limit reached: next request needs ${inputTokens} input + ${outputTokens} output reserve, exceeding the ${b.effectiveContext} per-request limit. Total task budget is separate (${b.effectiveTokens}). Saved observations remain available.`)
    if (inputTokens + outputTokens > b.remainingTokens) this.stop('total_tokens', `Sub-agent token budget reached: ${b.consumedTokens} consumed, ${b.remainingTokens} remaining of ${b.effectiveTokens} effective tokens (Settings ${b.configuredTokens}${b.requestedTokens !== null ? `; child allocation ${b.requestedTokens}` : ''}). Next request needs ${inputTokens} input + ${outputTokens} output reserve. Saved observations remain available.`)
    b.reservedInput = inputTokens; b.reservedOutput = outputTokens
    this.sync()
  }
  settle(usage: ModelResponseUsage): void {
    const b = this.state
    if (!b.reservedInput && !b.reservedOutput) return // Ignore duplicate/no-request usage notifications.
    if (![usage.inputTokens, usage.outputTokens].every(value => Number.isFinite(value) && value >= 0)) return
    if (usage.estimated) {
      // Without official usage, hidden reasoning may be missing from visible output.
      b.estimatedInput += Math.max(b.reservedInput, usage.inputTokens)
      b.estimatedOutput += Math.max(b.reservedOutput, usage.outputTokens)
      b.unknownRequests++
    } else {
      b.measuredInput += usage.inputTokens; b.measuredOutput += usage.outputTokens
      b.reasoningTokens += Number.isFinite(usage.reasoningTokens) ? Math.min(usage.outputTokens, Math.max(0, usage.reasoningTokens!)) : 0
    }
    b.reservedInput = 0; b.reservedOutput = 0; b.settledRequests++
    this.sync()
    if (b.consumedTokens > b.effectiveTokens) this.stop('total_tokens', `Sub-agent token budget reached: provider-reported usage brought consumption to ${b.consumedTokens}, above the ${b.effectiveTokens} effective limit. No further request or tool was started. Completed operations are preserved.`)
  }
  interrupted(): void {
    const b = this.state
    if (b.reservedInput || b.reservedOutput) {
      b.estimatedInput += b.reservedInput; b.estimatedOutput += b.reservedOutput
      b.reservedInput = 0; b.reservedOutput = 0; b.unknownRequests++
    }
    this.sync()
  }
}
