import { z } from 'zod'

export const contextSettingsSchema = z.object({
  automaticContinuation: z.boolean().default(true),
  automaticCompaction: z.boolean().default(true),
  contextSafetyMargin: z.number().min(0.05).max(0.4).default(0.15),
  modelContextWindows: z.record(z.string().max(600), z.number().int().min(2048).max(10_000_000)).default({}),
  stopOnRepeatedActions: z.boolean().default(true),
  stopOnNoProgress: z.boolean().default(true),
  taskCheckpoints: z.boolean().default(true),
  safeTaskRecovery: z.boolean().default(true),
  utilizationThreshold: z.number().min(0.3).max(0.85).default(0.7),
  maxToolOutputChars: z.number().int().min(2000).max(24000).default(8000),
  maxFileReadChars: z.number().int().min(1000).max(20000).default(12000),
  maxSearchResults: z.number().int().min(5).max(100).default(30),
  maxContinuations: z.number().int().min(0).max(32).default(3),
  maxAgentIterations: z.number().int().min(8).max(128).default(64),
  maxToolCalls: z.number().int().min(16).max(400).default(160),
  noProgressWindow: z.number().int().min(6).max(30).default(10),
  maxExecutionMinutes: z.number().int().min(2).max(60).default(30),
  acpInactivityMinutes: z.number().int().min(2).max(120).default(30),
  acpToolInactivityMinutes: z.number().int().min(2).max(120).default(30),
  socketConnectionSeconds: z.number().int().min(5).max(120).default(30),
  responseConnectionSeconds: z.number().int().min(10).max(300).default(60),
  responseFirstEventSeconds: z.number().int().min(30).max(600).default(180),
  streamInactivitySeconds: z.number().int().min(30).max(600).default(120),
  maxStreamRecoveries: z.number().int().min(0).max(4).default(2),
  allowProjectDeletion: z.boolean().default(true),
  allowProjectCommands: z.boolean().default(true),
  taskSpendLimitUsd: z.number().min(0.01).max(100).nullable().default(null),
  showUsage: z.boolean().default(true),
})
export type ContextSettings = z.infer<typeof contextSettingsSchema>
export const contextDefaults = (): ContextSettings => contextSettingsSchema.parse({})
export const contextModelKey = (model: string, route?: { provider: string; accountId: string }): string => JSON.stringify([route?.provider ?? 'configured-provider', route?.accountId ?? '', model])
export const promptBudgetSchema = z.object({
  routeKey: z.string().max(1000).optional(), configured: z.number().optional(), effective: z.number(),
  documented: z.number().optional(), safeInput: z.number(), prompt: z.number(), output: z.number(),
  system: z.number(), developer: z.number(), project: z.number(), tools: z.number(), history: z.number(),
  registered: z.number().optional(), loaded: z.number().optional(), reason: z.string().max(400),
})
export type PromptBudget = z.infer<typeof promptBudgetSchema>

export const contextUsageSchema = z.object({
  inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative(),
  contextTokens: z.number().nonnegative(), contextWindow: z.number().positive(), remainingTokens: z.number().nonnegative(),
  toolTokens: z.number().nonnegative(), estimated: z.boolean(), contextEstimated: z.boolean(), modelLimitsVerified: z.boolean(),
  estimatedCostUsd: z.number().nonnegative().nullable(), compactions: z.number().int().nonnegative(),
  reasoningTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(), requestCount: z.number().int().nonnegative().optional(),
  lastResponse: z.object({ inputTokens: z.number(), cachedInputTokens: z.number().nonnegative().optional(), outputTokens: z.number(), reasoningTokens: z.number().nullable(), toolArgumentChars: z.number(), outputBudget: z.number(), estimated: z.boolean().optional(), incompleteReason: z.string().optional() }).optional(),
  status: z.enum(['ready', 'optimizing', 'compacted']), show: z.boolean(),
})
export type ContextUsage = z.infer<typeof contextUsageSchema>

// Private model memory, never substituted for the original conversation or permissions.
export const contextCheckpointSchema = z.object({
  fingerprint: z.string().length(64), coveredThrough: z.string(), savedAt: z.number(),
  input: z.array(z.record(z.string(), z.unknown())).max(2000),
}).refine((entry) => JSON.stringify(entry.input).length <= 2_000_000)
export type ContextCheckpoint = z.infer<typeof contextCheckpointSchema>
