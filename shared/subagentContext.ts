/** Capacity evidence belongs to a model and its runtime, not a name prefix. */
export interface ModelContextLimits {
  contextWindow?: number
  maxOutputTokens?: number
  runtimeContextWindow?: number
  maxRequestBytes?: number
  source: 'documented' | 'reported' | 'configured' | 'fallback'
}
export function subagentContextAllocation(configured: number, limits?: ModelContextLimits, safetyMargin = 0.15, requested?: number, frozen?: number) {
  const valid = (value?: number): value is number => value !== undefined && Number.isSafeInteger(value) && value > 0
  const known = valid(limits?.contextWindow)
  const window = known ? limits!.contextWindow! : 16_384
  const ceiling = Math.min(window, valid(limits?.runtimeContextWindow) ? limits!.runtimeContextWindow! : Infinity,
    valid(limits?.maxRequestBytes) ? Math.floor(limits!.maxRequestBytes! / 4) : Infinity)
  const safe = Math.floor(ceiling * (1 - safetyMargin))
  const effective = Math.min(configured, requested ?? Infinity, frozen ?? Infinity, safe)
  const reason = [!known || limits?.source === 'fallback' ? 'Context capacity is unverified; conservative fallback.' : `Context source: ${limits!.source}.`,
    `Safety margin ${Math.round(safetyMargin * 100)}%; output, instructions, tools and attachments must fit inside the allocation.`,
    ceiling < window ? 'A runtime or request-size limit is more restrictive.' : '',
    requested !== undefined && requested < configured ? 'Task-specific lower allocation.' : '',
    frozen !== undefined && frozen < configured ? 'Saved child allocation retained.' : ''].filter(Boolean).join(' ')
  return { configured, effective, modelContext: known ? window : null, safeMaximum: safe, reason,
    verified: known && (limits?.source === 'documented' || limits?.source === 'reported'), outputReserve: Math.min(4096, limits?.maxOutputTokens ?? 4096) }
}
