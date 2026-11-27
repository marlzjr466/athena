import type { ReasoningEffort } from './conversations'
import { z } from 'zod'

/** Last server-checked policy, distinct from the composer's next-turn selection. */
export const codexAccessStatusSchema = z.object({
  mode: z.enum(['read-only', 'ask', 'workspace-auto', 'advanced', 'full-access']),
  status: z.enum(['checking', 'verified', 'rejected']),
  sandbox: z.string().optional(), approvalPolicy: z.string().optional(), error: z.string().optional(),
})
export type CodexAccessStatus = z.infer<typeof codexAccessStatusSchema>

/** Durable association only. Codex owns the actual transcript and execution state. */
export const nativeCodexThreadSchema = z.object({
  threadId: z.string().min(1).max(256), account: z.string().max(300), cwd: z.string().max(4096),
  lastMessageId: z.string().optional(), turnId: z.string().optional(),
  submission: z.enum(['pending', 'accepted', 'completed', 'interrupted', 'failed']).optional(),
  model: z.string().optional(), effort: z.string().nullable().optional(),
  sandbox: z.string().optional(), approvalPolicy: z.string().optional(),
  computerToolsRegistered: z.boolean().optional(), cuaToolNames: z.boolean().optional(), voiceAutomation: z.boolean().optional(),
  instructionSources: z.array(z.string()).optional(),
})
export type NativeCodexThread = z.infer<typeof nativeCodexThreadSchema>
export const nativeCodexQuestionSchema = z.object({ requestId: z.string(), questions: z.array(z.object({ id: z.string(), question: z.string(), isSecret: z.boolean(), options: z.array(z.object({ label: z.string(), description: z.string() })).nullable() })) })
export type NativeCodexQuestion = z.infer<typeof nativeCodexQuestionSchema>
export interface CodexThreadSummary { id: string; title: string; cwd: string; model: string | null; updatedAt: number; status: string }

/** Safe, renderer-visible metadata only. Never contains Codex credentials or local auth paths. */
export interface CodexCLIModel {
  id: string
  displayName: string
  efforts: ReasoningEffort[]
  defaultEffort: ReasoningEffort | null
  isDefault: boolean
}

export interface CodexCLIStatus {
  installed: boolean
  authenticated: boolean
  version: string | null
  identity: string | null
  models: CodexCLIModel[]
  defaultModel: string | null
  checkedAt: number | null
  message: string
  plan?: string | null
}

export const emptyCodexCLIStatus = (): CodexCLIStatus => ({
  installed: false,
  authenticated: false,
  version: null,
  identity: null,
  models: [],
  defaultModel: null,
  checkedAt: null,
  message: 'Codex CLI has not been checked.',
})

