import { z } from 'zod'

export const aiOwnershipSchema = z.object({
  origin: z.enum(['online-chat', 'athena-local', 'athena-avatar', 'athena-training']),
  sessionId: z.string().uuid(),
  correlationId: z.string().uuid(),
}).strict()
export type AIOwnership = z.infer<typeof aiOwnershipSchema>
export type ConversationOrigin = 'online-chat' | 'athena-local'

export function isLocalOwnership(owner: AIOwnership | undefined): owner is AIOwnership {
  return owner?.origin === 'athena-local'
}
