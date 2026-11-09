import { z } from 'zod'
export const copilotCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('cli-manage') }).strict(),
  z.object({ action: z.literal('cli-check') }).strict(),
  z.object({ action: z.literal('cli-login'), flow: z.enum(['browser','device']) }).strict(),
  z.object({ action: z.literal('connect-cli') }).strict(),
  z.object({ action: z.literal('login'), clientId: z.string().trim().regex(/^[a-zA-Z0-9_.-]{8,100}$/) }).strict(),
  z.object({ action: z.literal('poll') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('select'), id: z.string().max(100) }).strict(),
  z.object({ action: z.literal('remove'), id: z.string().max(100) }).strict(),
  z.object({ action: z.literal('enable'), id: z.string().max(100), enabled: z.boolean() }).strict(),
])
export type CopilotCommand = z.infer<typeof copilotCommandSchema>
export interface CopilotStatus {
  accounts: { id: string; login: string; enabled: boolean; kind: 'oauth' | 'cli' }[]
  activeId: string | null
  message: string
  cli?: CopilotCLIStatus
  managing?: boolean
  requestsActive?: boolean
  device?: { code: string; url: string; expiresAt: number; interval: number }
}

export interface CopilotCLIStatus {
  installed: boolean
  version: string | null
  phase: 'idle'|'starting'|'waiting'|'verifying'|'connected'|'failed'|'cancelled'|'expired'
  message: string
  code?: string
  url?: string
}
