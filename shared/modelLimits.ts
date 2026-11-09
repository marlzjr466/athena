export interface ModelLimits { context: number; output: number; verified: boolean; nativeCompaction: boolean; inputPrice?: number; outputPrice?: number; longContext?: boolean }
// Verified against official model pages (2026-10-09). Never infer a new model's
// capacity/pricing from a broad gpt-* match; /models does not expose these fields.
const catalog: Record<string, Omit<ModelLimits, 'verified'>> = {
  'gpt-6-sol': { context: 1050000, output: 128000, nativeCompaction: false, inputPrice: 2, outputPrice: 10, longContext: true },
  'gpt-6.1-sol': { context: 1050000, output: 128000, nativeCompaction: false, inputPrice: 2, outputPrice: 10, longContext: true },
  'gpt-5.6-sol': { context: 1050000, output: 128000, nativeCompaction: true, inputPrice: 4, outputPrice: 20, longContext: true },
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
export function tokenCost(limits: ModelLimits, input: number, output: number): number | null {
  if (limits.inputPrice === undefined || limits.outputPrice === undefined) return null
  const long = limits.longContext && input > 272000
  return (input * limits.inputPrice * (long ? 2 : 1) + output * limits.outputPrice * (long ? 1.5 : 1)) / 1_000_000
}
