import { z } from 'zod'

export const generationSettingsSchema = z.object({
  outputTokens: z.number().int().min(1024).max(128000).nullable().default(null),
  maxOutputContinuations: z.number().int().min(0).max(8).default(3),
})
export type GenerationSettings = z.infer<typeof generationSettingsSchema>
export const generationDefaults = (): GenerationSettings => generationSettingsSchema.parse({})

export const recoveryStateSchema = z.object({
  attempts: z.number().int().nonnegative(), continuing: z.boolean(),
  reason: z.enum(['max_output_tokens', 'stream_interrupted']), outputBudget: z.number().int().positive(),
  effort: z.enum(['auto', 'low', 'medium', 'high', 'xhigh']),
  pendingTools: z.array(z.string().max(100)).max(100),
})
export type RecoveryState = z.infer<typeof recoveryStateSchema>
export const verificationGateSchema = z.object({
  productionBuild: z.enum(['not-run', 'running', 'passed', 'failed', 'blocked']).default('not-run'),
  developmentServer: z.enum(['not-run', 'running', 'ready', 'failed', 'blocked']).default('not-run'),
  browserVerification: z.enum(['not-run', 'running', 'passed', 'failed', 'blocked']).default('not-run'),
})
export type VerificationGates = z.infer<typeof verificationGateSchema>
export const taskCheckpointSchema = z.object({
  taskId: z.string(), model: z.string(), originalRequest: z.string().max(12000),
  workspaceIds: z.array(z.string()), instructionMessageIds: z.array(z.string()).max(10000),
  completedOperationIds: z.array(z.string()).max(500), modifiedFiles: z.array(z.string()).max(2000),
  verificationOperationIds: z.array(z.string()).max(500), pendingActions: z.array(z.string()).max(100),
  verificationGates: verificationGateSchema.default({ productionBuild: 'not-run', developmentServer: 'not-run', browserVerification: 'not-run' }),
  lastKnownBranch: z.string().max(200).optional(),
  requiredApprovalId: z.string().optional(), updatedAt: z.number(), continuationAttempts: z.number().int().nonnegative(),
})
