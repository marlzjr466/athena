import { z } from 'zod'

export const projectEditorCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('open'), sessionId: z.string().uuid(), workspaceId: z.string().uuid() }).strict(),
])
export type ProjectEditorCommand = z.infer<typeof projectEditorCommandSchema>
export interface ProjectEditorResult { ok: boolean; available?: boolean; message?: string }
