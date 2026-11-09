import { z } from 'zod'
import { streamDiagnosticSchema, streamPhaseSchema } from './streamDiagnostics'

const effort = z.enum(['inherit', 'auto', 'low', 'medium', 'high', 'xhigh'])
export const subagentSettingsSchema = z.object({
  enabled: z.boolean().default(true), maxConcurrent: z.number().int().min(1).max(4).default(2),
  defaultModel: z.string().max(200).nullable().default(null), defaultEffort: effort.default('inherit'),
  coldReadModel: z.string().max(200).nullable().default(null), coldReadEffort: effort.default('inherit'),
  maxIterations: z.number().int().min(2).max(48).default(24), maxToolCalls: z.number().int().min(2).max(100).default(40),
  timeoutMinutes: z.number().min(1).max(20).default(10), contextTokens: z.number().int().min(2000).max(64000).default(24000),
  tokenBudget: z.number().int().min(8000).max(1000000).default(250000),
  parallelReadOnly: z.boolean().default(true), requireWriteApproval: z.boolean().default(true),
}).strict()
export type SubagentSettings = z.infer<typeof subagentSettingsSchema>
export const subagentDefaults = (): SubagentSettings => subagentSettingsSchema.parse({})
export const subagentScopeSchema = z.enum(['filesystem-read', 'search', 'filesystem-write', 'terminal', 'git-read', 'git-write', 'browser', 'local-network'])
export const subagentRequestSchema = z.object({
  taskKey: z.string().min(1).max(100), role: z.string().min(1).max(100), task: z.string().min(1).max(6000),
  criteria: z.string().min(1).max(8000), mode: z.enum(['cold_read', 'scoped', 'shared']).default('cold_read'),
  files: z.array(z.string().min(1).max(1000)).min(1).max(30),
  toolScopes: z.array(subagentScopeSchema).max(8).default(['filesystem-read']),
  model: z.string().min(1).max(200).optional(), effort: effort.optional(),
  maxIterations: z.number().int().min(1).max(48).optional().describe('Optional LOWER lifetime model-request cap, including retries and the final assessment. OMIT to inherit current Settings. Do not invent a smaller allocation.'),
  maxToolCalls: z.number().int().min(1).max(100).optional().describe('Optional LOWER lifetime tool-attempt cap. OMIT to inherit current Settings. Each call in a batch counts separately; this is not a batch or iteration limit. Do not invent a smaller allocation.'),
  timeoutMinutes: z.number().min(0.01).max(20).optional(), contextTokens: z.number().int().min(1000).max(64000).optional().describe('Optional LOWER per-request context cap, including output. Omit to inherit Settings. This is not the total task budget.'),
  tokenBudget: z.number().int().min(1000).max(1000000).optional().describe('Optional LOWER TOTAL input + output token cap across ALL requests and retries. Omit to inherit Settings. Do not invent a small allocation or confuse this with max output tokens; repeated context and tool results consume input on each request.'), spendLimitUsd: z.number().positive().max(100).optional(),
  contextSummary: z.string().max(8000).optional(), messageIds: z.array(z.string().uuid()).max(4).optional(),
  required: z.boolean().default(false), gateId: z.string().max(100).optional(), parallelGroup: z.string().max(100).optional(),
}).strict()
export type SubagentRequest = z.infer<typeof subagentRequestSchema>
export const subagentResultSchema = z.object({
  status: z.enum(['completed', 'blocked']), assessment: z.enum(['PASS', 'FAIL', 'INCOMPLETE']).optional(), summary: z.string().min(1).max(1200),
  findings: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']), description: z.string().max(900), evidence: z.array(z.string().max(160)).max(4) }).strict()).max(30),
  blockers: z.array(z.string().max(1500)).max(20), evidence: z.array(z.string().max(1200)).max(40),
  filesReviewed: z.array(z.string().max(1000)).max(100), checksPerformed: z.array(z.string().max(1500)).max(40),
  limitations: z.array(z.string().max(1500)).max(20), nextActions: z.array(z.string().max(1500)).max(20),
}).strict()
export type SubagentResult = z.infer<typeof subagentResultSchema>
export const subagentResultDiagnosticsSchema = z.object({
  validationErrors: z.array(z.string().max(500)).max(20).default([]),
  missingFields: z.array(z.string().max(200)).max(20).default([]),
  candidateCount: z.number().int().nonnegative().default(0),
  terminationReason: z.string().max(1000),
}).strict()
export type SubagentResultDiagnostics = z.infer<typeof subagentResultDiagnosticsSchema>
export const subagentRequirementSchema = z.object({
  id: z.string().min(1).max(100), required: z.boolean().default(true), mode: z.enum(['cold_read', 'scoped', 'shared']).default('cold_read'),
  role: z.string().min(1).max(100), task: z.string().max(6000).optional(), criteria: z.string().max(8000).optional(),
  files: z.array(z.string().min(1).max(1000)).max(30).optional(), toolScopes: z.array(subagentScopeSchema).max(8).optional(),
  model: z.string().max(200).optional(), effort: effort.optional(), maxIterations: z.number().int().min(1).max(48).optional(),
  maxToolCalls: z.number().int().min(1).max(100).optional(), timeoutMinutes: z.number().min(0.01).max(20).optional(),
  parallelGroup: z.string().max(100).optional(), expectedResultSchema: z.literal('athena-review-v1').default('athena-review-v1'),
}).strict()
export type SubagentRequirement = z.infer<typeof subagentRequirementSchema>
export const subagentBudgetSchema = z.object({
  version: z.literal(2), configuredTokens: z.number(), requestedTokens: z.number().nullable(), effectiveTokens: z.number(),
  configuredContext: z.number(), requestedContext: z.number().nullable(), effectiveContext: z.number(),
  modelContext: z.number().nullable(), modelMaxOutput: z.number().nullable(), modelLimitsVerified: z.boolean(), outputLimitEnforced: z.boolean(),
  measuredInput: z.number(), measuredOutput: z.number(), estimatedInput: z.number(), estimatedOutput: z.number(),
  reasoningTokens: z.number(), legacyEstimate: z.boolean(),
  reservedInput: z.number(), reservedOutput: z.number(), consumedTokens: z.number(), remainingTokens: z.number(), availableTokens: z.number(),
  settledRequests: z.number().int(), unknownRequests: z.number().int(),
  lastRequest: z.object({ inputTokens: z.number(), outputTokens: z.number(), requiredTokens: z.number(), remainingBefore: z.number(), inputEstimated: z.boolean() }).optional(),
  termination: z.object({ code: z.enum(['total_tokens', 'context', 'iterations', 'tools', 'timeout', 'cancelled', 'provider_or_tool', 'output_limit', 'incomplete_review']), message: z.string().max(2000) }).optional(),
})
export type SubagentBudget = z.infer<typeof subagentBudgetSchema>
export const subagentExecutionBudgetSchema = z.object({
  configuredIterations: z.number().int(), requestedIterations: z.number().int().nullable(), effectiveIterations: z.number().int(),
  configuredToolCalls: z.number().int(), requestedToolCalls: z.number().int().nullable(), effectiveToolCalls: z.number().int(),
  remainingIterations: z.number().int(), remainingToolCalls: z.number().int(),
  deferredToolCalls: z.number().int().default(0), repeatedResults: z.number().int().default(0), noProgressCalls: z.number().int().default(0),
  finalization: z.object({ reason: z.enum(['tools', 'iterations', 'batch_limit', 'no_progress']), message: z.string().max(2000) }).optional(),
  lastBatch: z.object({ requested: z.number().int(), executed: z.number().int(), deferred: z.number().int() }).optional(),
})
export type SubagentExecutionBudget = z.infer<typeof subagentExecutionBudgetSchema>
export const subagentRunSchema = z.object({
  id: z.string().uuid(), parentExecutionId: z.string().uuid(), conversationId: z.string().uuid(), projectId: z.string(), taskId: z.string().uuid(),
  request: subagentRequestSchema, status: z.enum(['queued', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'interrupted']),
  model: z.string().nullable(), effort: z.enum(['auto', 'low', 'medium', 'high', 'xhigh']), accountId: z.string().nullable(),
  startedAt: z.number(), finishedAt: z.number().optional(), attempts: z.number().int(),
  elapsedMs: z.number().nonnegative().default(0),
  iterations: z.number().int(), toolCalls: z.number().int(), inputTokens: z.number(), outputTokens: z.number(), estimatedCostUsd: z.number().nullable(),
  budget: subagentBudgetSchema.optional(),
  executionBudget: subagentExecutionBudgetSchema.optional(),
  progress: z.string().max(1000).optional(), error: z.string().max(2000).optional(), result: subagentResultSchema.optional(),
  streamPhase: streamPhaseSchema.optional(), streamDiagnostics: z.array(streamDiagnosticSchema).max(20).optional(),
  rawResponse: z.string().max(48000).optional(), resultDiagnostics: subagentResultDiagnosticsSchema.optional(),
  observations: z.array(z.object({ tool: z.string(), input: z.string().max(6000), output: z.string().max(12000) })).max(100).default([]),
  fileVersions: z.record(z.string(), z.string()).default({}), selectedContext: z.string().max(12000).default(''),
  readCoverage: z.record(z.string(), z.object({ version: z.string(), total: z.number().int(), ranges: z.array(z.tuple([z.number().int(), z.number().int()])).max(100) })).default({}),
  reviewAccepted: z.boolean().default(false), reconciliation: z.string().max(4000).optional(),
})
export type SubagentRun = z.infer<typeof subagentRunSchema>
