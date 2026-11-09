import { rememberedScopeSchema } from './permissions'
import { z } from 'zod'
import { contextUsageSchema } from './context'
import { recoveryStateSchema, taskCheckpointSchema } from './generation'
import { subagentRunSchema, subagentRequirementSchema } from './subagents'
import { streamDiagnosticSchema, streamPhaseSchema } from './streamDiagnostics'

export const agentModeSchema = z.enum(['read-only', 'ask', 'workspace-auto', 'advanced'])
export type AgentMode = z.infer<typeof agentModeSchema>
export const agentModes: Record<AgentMode, string> = { 'read-only': 'Read Only', ask: 'Ask Before Changes', 'workspace-auto': 'Workspace Auto Edit', advanced: 'Advanced Agent' }
export const reviewChunkSchema = z.object({ fileHash: z.string().regex(/^[a-f0-9]{64}$/), chunkHash: z.string().regex(/^[a-f0-9]{64}$/), index: z.number().int().positive(), total: z.number().int().positive(), status: z.enum(['complete', 'incomplete']) }).strict()
export const changePreviewSchema = z.object({ id: z.string(), path: z.string(), diff: z.string().max(60_000), status: z.enum(['proposed', 'applied', 'reverted', 'conflict']), reviewChunk: reviewChunkSchema.optional() })
export type ChangePreview = z.infer<typeof changePreviewSchema>
export const activitySchema = z.object({ id: z.string(), tool: z.string(), label: z.string(), startedAt: z.number(), finishedAt: z.number().optional(), status: z.enum(['running', 'complete', 'error', 'cancelled']), summary: z.string().max(8000).optional(), fullOutput: z.string().max(70000).optional(), changes: z.array(changePreviewSchema).optional(), parentActivityId: z.string().optional(), subagent: subagentRunSchema.optional() })
export type AgentActivity = z.infer<typeof activitySchema>
export const timelineEventSchema = z.object({ id: z.string(), kind: z.enum(['started', 'text', 'activity', 'status']), createdAt: z.number(), text: z.string().max(48_000).optional(), activityId: z.string().optional() })
export type TimelineEvent = z.infer<typeof timelineEventSchema>
export const approvalSchema = z.object({ id: z.string(), title: z.string(), description: z.string(), changes: z.array(changePreviewSchema).optional(), rememberScope: rememberedScopeSchema.optional() })
export type AgentApproval = z.infer<typeof approvalSchema>
const budgetPhaseSchema = z.object({ iterations: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), durationMs: z.number().nonnegative() })
export const agentBudgetSummarySchema = z.object({ iterations: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), phases: z.object({ exploration: budgetPhaseSchema, implementation: budgetPhaseSchema, verification: budgetPhaseSchema, other: budgetPhaseSchema }), repeatedReads: z.number().int().nonnegative(), repeatedSearches: z.number().int().nonnegative(), successfulModifications: z.number().int().nonnegative(), failedOperations: z.number().int().nonnegative(), compactionAttempts: z.number().int().nonnegative(), durationMs: z.number().nonnegative() })
/** ChatGPT accounts are UUIDs. Copilot and Codex store a prefixed account key. Either form must load, or one saved turn hides the whole history. */
export const executionAccountIdSchema = z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9:._@-]{0,179}$/)
export const executionSchema = z.object({ startedAt: z.number(), updatedAt: z.number(), finishedAt: z.number().optional(), status: z.enum(['working', 'waiting-auth', 'complete', 'error', 'cancelled']), accountId: executionAccountIdSchema.optional(), activities: z.array(activitySchema).max(500), timeline: z.array(timelineEventSchema).max(1100).optional(), budgetNotice: z.string().max(2000).optional(), budgetSummary: agentBudgetSummarySchema.optional(), approval: approvalSchema.optional(), contextUsage: contextUsageSchema.optional(), recovery: recoveryStateSchema.optional(), streamPhase: streamPhaseSchema.optional(), streamDiagnostics: z.array(streamDiagnosticSchema).max(20).optional(), taskCheckpoint: taskCheckpointSchema.optional(), subagentRequirements: z.array(subagentRequirementSchema).max(12).optional() })
export type AgentExecution = z.infer<typeof executionSchema>
export function elapsedLabel(start: number, end: number, live = false): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000)), minutes = Math.floor(seconds / 60)
  return `${live ? 'Working' : 'Worked'} for ${minutes ? `${minutes}m${seconds % 60 ? `${live ? ' ' : ' and '}${seconds % 60}s` : ''}` : `${seconds}s`}${live ? '…' : ''}`
}
export function fileDiff(path: string, before: string | null, after: string | null): string {
  const a = before?.split('\n') ?? [], b = after?.split('\n') ?? []
  let prefix = 0, suffix = 0
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++
  const context = Math.max(0, prefix - 3)
  const lines = [`--- ${before === null ? '/dev/null' : path}`, `+++ ${after === null ? '/dev/null' : path}`, `@@ -${context + 1},${a.length - context - suffix} +${context + 1},${b.length - context - suffix} @@`, ...a.slice(context, prefix).map((line) => ` ${line}`), ...a.slice(prefix, a.length - suffix).map((line) => `-${line}`), ...b.slice(prefix, b.length - suffix).map((line) => `+${line}`), ...a.slice(a.length - suffix, a.length - suffix + Math.min(3, suffix)).map((line) => ` ${line}`)]
  const text = lines.join('\n')
  return text.length > 59_000 ? text.slice(0, 59_000) + '\n[Preview truncated; reject and request a smaller change to review it fully.]' : text
}
