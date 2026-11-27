import { z } from 'zod'
import { searchAttemptSchema } from './searchOutcome'

export const generationSettingsSchema = z.object({
  outputTokens: z.number().int().min(1024).max(128000).nullable().default(null),
  maxOutputContinuations: z.number().int().min(0).max(32).default(3),
})
export type GenerationSettings = z.infer<typeof generationSettingsSchema>
export const generationDefaults = (): GenerationSettings => generationSettingsSchema.parse({})

export const recoveryStateSchema = z.object({
  attempts: z.number().int().nonnegative(), continuing: z.boolean(),
  reason: z.enum(['max_output_tokens', 'stream_interrupted']), outputBudget: z.number().int().positive(),
  effort: z.enum(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  pendingTools: z.array(z.string().max(100)).max(100),
})
export type RecoveryState = z.infer<typeof recoveryStateSchema>
export const verificationGateSchema = z.object({
  productionBuild: z.enum(['not-run', 'running', 'passed', 'failed', 'blocked']).default('not-run'),
  developmentServer: z.enum(['not-run', 'running', 'ready', 'failed', 'blocked']).default('not-run'),
  browserVerification: z.enum(['not-run', 'running', 'passed', 'failed', 'blocked']).default('not-run'),
})
export type VerificationGates = z.infer<typeof verificationGateSchema>
export const operationRiskSchema = z.enum(['read-only', 'idempotent', 'non-idempotent', 'destructive', 'unknown'])
export type OperationRisk = z.infer<typeof operationRiskSchema>
export const taskControlStateSchema = z.object({
  transportRecoveries: z.number().int().nonnegative().default(0),
  continuations: z.number().int().nonnegative(), compactions: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(), toolRounds: z.number().int().nonnegative(),
  contextTokens: z.number().nonnegative().optional(), contextWindow: z.number().positive().optional(),
  status: z.enum(['running', 'compacting', 'waiting-tool', 'waiting-permission', 'waiting-user', 'responded', 'resumable', 'cancelled', 'blocked']),
  stopReason: z.string().max(120).optional(),
  operations: z.array(z.object({ key: z.string().length(64), tool: z.string().max(128), readOnly: z.boolean(), risk: operationRiskSchema.optional(), status: z.enum(['started', 'complete', 'failed']), at: z.number(),
    id: z.string().optional(), runId: z.string().optional(), finishedAt: z.number().optional(),
    outcome: z.enum(['success', 'permission-denied', 'timeout', 'cancelled', 'missing-input', 'conflict', 'not-found', 'failed']).optional(),
    credentialSource: z.object({ file: z.string().max(1000), names: z.array(z.string().max(90)).max(12) }).optional(),
    exitCode: z.number().int().nullable().optional() })).max(1000),
})
export type TaskControlState = z.infer<typeof taskControlStateSchema>
export const taskCheckpointSchema = z.object({
  searchAttempts: z.array(searchAttemptSchema).max(24).optional(),
  taskId: z.string(), model: z.string(), originalRequest: z.string().max(48000),
  conversationId: z.string().optional(), provider: z.string().optional(), effort: z.string().optional(),
  accountRoute: z.string().optional(), permissionMode: z.string().optional(), workspaceRoots: z.array(z.string()).optional(),
  control: taskControlStateSchema.optional(), recoveryAttempts: z.number().int().nonnegative().optional(),
  parentTaskId: z.string().optional(), resumable: z.boolean().optional(),
  migration: z.object({ fromTaskId: z.string(), fromProvider: z.string().optional(), fromModel: z.string(), authorized: z.boolean() }).optional(),
  requestedModel: z.string().max(200).optional(),
  repositoryRef: z.string().max(2048).optional(), responseModel: z.string().max(200).optional(),
  nativeSessionId: z.string().max(256).optional(),
  workspaceIds: z.array(z.string()), instructionMessageIds: z.array(z.string()).max(10000),
  completedOperationIds: z.array(z.string()).max(500), modifiedFiles: z.array(z.string()).max(2000),
  verificationOperationIds: z.array(z.string()).max(500), pendingActions: z.array(z.string()).max(100),
  verificationGates: verificationGateSchema.default({ productionBuild: 'not-run', developmentServer: 'not-run', browserVerification: 'not-run' }),
  lastKnownBranch: z.string().max(200).optional(),
  requiredApprovalId: z.string().optional(), updatedAt: z.number(), continuationAttempts: z.number().int().nonnegative(),
})
