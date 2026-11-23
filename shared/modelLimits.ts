export interface ModelLimits { context: number; maxInput?: number; toolSearch?: boolean; output: number; verified: boolean; nativeCompaction: boolean; inputPrice?: number; outputPrice?: number; longContext?: boolean }
// Verified against official model pages (2026-10-09). Never infer a new model's
// capacity/pricing from a broad gpt-* match; /models does not expose these fields.
const catalog: Record<string, Omit<ModelLimits, 'verified'>> = {
  // https://developers.openai.com/api/docs/models/gpt-6.2-{astra,sol}
  'gpt-6.2-astra': { context: 1_050_000, maxInput: 922_000, output: 128_000, toolSearch: true, nativeCompaction: false, inputPrice: 8, outputPrice: 40, longContext: true },
  'gpt-6.2-sol': { context: 1_050_000, maxInput: 922_000, output: 128_000, toolSearch: true, nativeCompaction: false, inputPrice: 2, outputPrice: 10, longContext: true },
  'gpt-6-sol': { context: 1050000, output: 128000, nativeCompaction: false, inputPrice: 2, outputPrice: 10, longContext: true },
  'gpt-6.1-sol': { context: 1050000, output: 128000, nativeCompaction: false, inputPrice: 2, outputPrice: 10, longContext: true },
  'gpt-5.6-sol': { context: 1050000, output: 128000, nativeCompaction: true, inputPrice: 4, outputPrice: 20, longContext: true },
  // Official model metadata verified 2026-11-23:
  // https://developers.openai.com/api/docs/models/gpt-5.6-terra
  'gpt-5.6-terra': { context: 1050000, output: 128000, nativeCompaction: false, inputPrice: 2, outputPrice: 12, longContext: true },
  'gpt-5.6': { context: 1050000, output: 128000, nativeCompaction: true, inputPrice: 4, outputPrice: 20, longContext: true },
  'gpt-5.6-luna': { context: 1050000, output: 128000, nativeCompaction: true, inputPrice: 0.2, outputPrice: 1.2, longContext: true },
  'gpt-5.5': { context: 1050000, output: 128000, nativeCompaction: true, inputPrice: 5, outputPrice: 30, longContext: true },
  'gpt-5.4': { context: 1050000, output: 128000, nativeCompaction: true, inputPrice: 2.5, outputPrice: 15, longContext: true },
  'gpt-5.4-pro': { context: 1050000, output: 128000, nativeCompaction: true, inputPrice: 30, outputPrice: 180, longContext: true },
  'gpt-5.3-codex': { context: 400000, output: 128000, nativeCompaction: true, inputPrice: 1.75, outputPrice: 14 },
  'gpt-5.1': { context: 400000, output: 128000, nativeCompaction: false, inputPrice: 1.25, outputPrice: 10 },
  'gpt-5.1-chat-latest': { context: 128000, output: 16384, nativeCompaction: false, inputPrice: 1.25, outputPrice: 10 },
  'gpt-6-astra': { context: 1050000, output: 128000, nativeCompaction: true, inputPrice: 10, outputPrice: 50, longContext: true },
  'gpt-5.2': { context: 400000, output: 128000, nativeCompaction: true, inputPrice: 1.75, outputPrice: 14 },
  'gpt-5.2-codex': { context: 400000, output: 128000, nativeCompaction: true },
  'gpt-5.2-pro': { context: 400000, output: 128000, nativeCompaction: true, inputPrice: 21, outputPrice: 168 },
  'gpt-5.2-chat-latest': { context: 128000, output: 16384, nativeCompaction: false, inputPrice: 1.75, outputPrice: 14 },
  'gpt-4.1': { context: 1047576, output: 32768, nativeCompaction: false, inputPrice: 2, outputPrice: 8 },
  'gpt-4.1-mini': { context: 1047576, output: 32768, nativeCompaction: false, inputPrice: 0.4, outputPrice: 1.6 },
}
export function modelLimits(model: string): ModelLimits {
  const entry = catalog[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')]
  return entry ? { ...entry, verified: true } : { context: 16384, output: 4096, nativeCompaction: false, verified: false }
}
/** Direct API documentation is an upper bound, never an account entitlement.
 * The signed-in model catalog may omit capacity. Preserve that uncertainty. */
export function openAIContext(model: string, subscription: boolean, reported?: number, configured?: number) {
  const documented = modelLimits(model)
  const advertised = Number.isSafeInteger(reported) && reported! > 0 ? reported : undefined
  const fallback = !advertised && (subscription || !documented.verified)
  const routeWindow = Math.min(advertised ?? (fallback ? 16_384 : documented.context), documented.verified ? documented.context : Infinity)
  const context = Math.min(routeWindow, configured ?? Infinity)
  const source = fallback ? 'fallback' : advertised ? 'reported' : 'documented'
  const limits = { ...documented, context, output: Math.min(documented.verified || advertised ? documented.output : 4096, fallback ? 4096 : Infinity),
    verified: !fallback, nativeCompaction: !subscription && documented.nativeCompaction }
  return { limits, source, documentedWindow: documented.verified ? documented.context : undefined,
    reason: context < routeWindow ? 'Configured conversation cap' : fallback ? 'Conservative fallback. This integration has not reported its context window.' :
      advertised && advertised <= (documented.verified ? documented.context : Infinity) ? 'Account model catalog' : 'Documented API model limit' } as const
}
export function tokenCost(limits: ModelLimits, input: number, output: number): number | null {
  if (limits.inputPrice === undefined || limits.outputPrice === undefined) return null
  const long = limits.longContext && input > 272000
  return (input * limits.inputPrice * (long ? 2 : 1) + output * limits.outputPrice * (long ? 1.5 : 1)) / 1_000_000
}
