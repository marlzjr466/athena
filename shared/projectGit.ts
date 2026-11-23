import { z } from 'zod'

const target = { sessionId: z.string().uuid(), workspaceId: z.string().uuid() }
export const projectGitCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...target, action: z.literal('status') }).strict(),
  z.object({ ...target, action: z.literal('watch'), subscriptionId: z.string().uuid() }).strict(),
  z.object({ ...target, action: z.literal('unwatch'), subscriptionId: z.string().uuid() }).strict(),
  z.object({ ...target, action: z.enum(['switch', 'create']), branch: z.string().min(1).max(255), expectedHead: z.string().max(1100) }).strict(),
])
export type ProjectGitCommand = z.infer<typeof projectGitCommandSchema>
export interface ProjectGitState {
  repository: boolean
  root?: string
  branch?: string
  detached?: string
  head: string
  branches: string[]
  changedFiles?: number
  error?: string
  mutationBlocked?: string
}
export interface ProjectGitResult { ok: boolean; state?: ProjectGitState; message?: string }
export interface ProjectGitEvent extends ProjectGitResult { subscriptionId: string }
