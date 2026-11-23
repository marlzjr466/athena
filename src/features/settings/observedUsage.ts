import type { ChatMessage } from '../../../shared/chat'
import type { UsageMetric } from '../../../shared/usage'

export function observedConversationUsage(messages: ChatMessage[], providerIds: string[], accountId?: string | null): { metrics: UsageMetric[]; updatedAt: number | null; turns: number; incompleteRequests: number; estimated: boolean } {
  const relevant = messages.filter(message => message.role === 'assistant' && providerIds.includes(message.execution?.providerId ?? '')
    && (!accountId || message.execution?.accountId === accountId))
  const responses = relevant.filter(message => message.status === 'complete' || message.status === 'error' || message.status === 'stopped')
  const receipts = relevant.flatMap(message => message.execution?.providerUsage ? [{ modelId: message.execution.modelId ?? 'Model unavailable', usage: message.execution.providerUsage }] : [])
  const totals = receipts.reduce((sum, entry) => ({
    inputTokens: sum.inputTokens + entry.usage.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + (entry.usage.cachedInputTokens ?? 0),
    cacheCreationInputTokens: sum.cacheCreationInputTokens + (entry.usage.cacheCreationInputTokens ?? 0),
    outputTokens: sum.outputTokens + entry.usage.outputTokens,
    reasoningTokens: sum.reasoningTokens + (entry.usage.reasoningTokens ?? 0),
    requestCount: sum.requestCount + entry.usage.requestCount,
    incompleteRequests: sum.incompleteRequests + (entry.usage.incompleteRequests ?? 0),
    estimated: sum.estimated || entry.usage.estimated,
    updatedAt: Math.max(sum.updatedAt, entry.usage.updatedAt),
  }), { inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, reasoningTokens: 0, requestCount: 0, incompleteRequests: 0, estimated: false, updatedAt: 0 })
  const metrics: UsageMetric[] = []
  if (responses.length) metrics.push({ id: 'conversation-responses', label: 'Assistant responses in this conversation', value: responses.length, unit: 'count', period: 'Current conversation' })
  if (totals.requestCount) metrics.push({ id: 'provider-requests', label: 'Model response receipts', value: totals.requestCount, unit: 'requests', period: 'Current conversation', detail: 'Reported by the provider runtime for completed model responses' })
  if (totals.inputTokens) metrics.push({ id: 'input-tokens', label: 'Input tokens', value: totals.inputTokens, unit: 'tokens', period: 'Current conversation', detail: totals.estimated ? 'Includes runtime estimates; not a billing receipt' : 'Provider-reported response usage' })
  if (totals.cachedInputTokens) metrics.push({ id: 'cached-input-tokens', label: 'Cached input tokens', value: totals.cachedInputTokens, unit: 'tokens', period: 'Current conversation', detail: 'Subset of input tokens reported as cached' })
  if (totals.cacheCreationInputTokens) metrics.push({ id: 'cache-creation-tokens', label: 'Cache creation tokens', value: totals.cacheCreationInputTokens, unit: 'tokens', period: 'Current conversation', detail: 'Reported by Anthropic response usage' })
  if (totals.outputTokens) metrics.push({ id: 'output-tokens', label: 'Output tokens', value: totals.outputTokens, unit: 'tokens', period: 'Current conversation', detail: totals.estimated ? 'Includes runtime estimates; not a billing receipt' : 'Provider-reported response usage' })
  if (totals.reasoningTokens) metrics.push({ id: 'reasoning-tokens', label: 'Reasoning tokens', value: totals.reasoningTokens, unit: 'tokens', period: 'Current conversation', detail: 'Included within output tokens' })
  if (totals.incompleteRequests) metrics.push({ id: 'unresolved-requests', label: 'Requests without a final usage receipt', value: totals.incompleteRequests, unit: 'requests', period: 'Current conversation', detail: 'The provider may have billed interrupted requests; their token usage is unknown.' })
  const byModel = new Map<string, { input: number; output: number; requests: number }>()
  for (const { modelId, usage } of receipts) {
    const entry = byModel.get(modelId) ?? { input: 0, output: 0, requests: 0 }
    entry.input += usage.inputTokens; entry.output += usage.outputTokens; entry.requests += usage.requestCount; byModel.set(modelId, entry)
  }
  for (const [model, usage] of byModel) metrics.push({ id: `model-${model}`, label: `${model} usage`, value: usage.input + usage.output, unit: 'tokens', period: 'Current conversation', detail: `${usage.input.toLocaleString()} input · ${usage.output.toLocaleString()} output · ${usage.requests} model response${usage.requests === 1 ? '' : 's'}` })
  return { metrics, updatedAt: totals.updatedAt || null, turns: responses.length, incompleteRequests: totals.incompleteRequests, estimated: totals.estimated }
}
