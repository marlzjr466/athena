import { freemem, totalmem } from 'node:os'
import { allocationNotice, resolveLocalContext, type ContextDecision } from '../../../shared/contextEngine'
import type { LocalModel, LocalStatus } from '../../../shared/localAI'
import { ChatError } from './AIProvider'
import type { OllamaService } from './ollamaService'

export interface ContextConfirmation { model: string; tokens: number; confirmedAt: string; promptTokens: number; durationMs: number }

const confirmations = new Map<string, ContextConfirmation>()
let lastPromptUsage: LocalStatus['lastPromptUsage']

export function rememberPromptUsage(usage: NonNullable<LocalStatus['lastPromptUsage']>): void {
  lastPromptUsage = usage
}

export function latestPromptUsage(): LocalStatus['lastPromptUsage'] {
  return lastPromptUsage
}

export function contextConfirmations(): ContextConfirmation[] {
  return [...confirmations.values()]
}

export function confirmedTokensFor(model: string): number | undefined {
  return confirmations.get(model)?.tokens
}

export function rememberContextConfirmation(confirmation: ContextConfirmation): void {
  confirmations.set(confirmation.model, confirmation)
}

export function contextDecisionFor(model: LocalModel, requestedTokens: number, confirmedTokens = confirmedTokensFor(model.name)): ContextDecision {
  return resolveLocalContext({
    requestedTokens,
    reportedContextTokens: model.contextLength,
    rope: model.ropeScaling,
    engine: model.provider === 'mlx' ? 'mlx' : 'ollama',
    mlxAppliesYarn: false,
    architecture: model.architecture,
    weightBytes: model.size,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    confirmedTokens,
  })
}

export async function probeLocalContext(service: OllamaService, modelName: string, requestedTokens: number, signal?: AbortSignal): Promise<{ ok: boolean; message: string; decision: ContextDecision }> {
  const model = await service.modelDetails(modelName)
  const before = contextDecisionFor(model, requestedTokens, undefined)
  const notice = allocationNotice(before)
  if (!notice.measureAllowed) return { ok: false, message: notice.measureReason, decision: before }
  const started = Date.now()
  try {
    const response = await service.call('api/chat', {
      model: modelName,
      messages: [{ role: 'user', content: 'Reply with the single word ready.' }],
      stream: false,
      options: { num_ctx: requestedTokens, num_predict: 8, temperature: 0 },
    }, signal, 180_000)
    const body = await response.json() as { error?: string; prompt_eval_count?: number; message?: { content?: string } }
    if (typeof body.error === 'string') return { ok: false, message: `Ollama refused this context allocation: ${body.error}`, decision: before }
    const promptTokens = typeof body.prompt_eval_count === 'number' ? body.prompt_eval_count : 0
    const confirmation: ContextConfirmation = { model: modelName, tokens: requestedTokens, confirmedAt: new Date().toISOString(), promptTokens, durationMs: Date.now() - started }
    confirmations.set(modelName, confirmation)
    const decision = contextDecisionFor(model, requestedTokens, confirmation.tokens)
    return { ok: decision.allocationState === 'measured', message: decision.explanation, decision }
  } catch (error) {
    const message = error instanceof ChatError ? error.message : 'The context allocation did not finish. Athena kept the previous window.'
    return { ok: false, message, decision: before }
  }
}
