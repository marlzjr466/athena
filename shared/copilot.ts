import { z } from 'zod'
export const copilotCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('verify') }).strict(),
  z.object({ action: z.literal('usage') }).strict(),
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
  lastVerifiedAt?: number | null
  modelCount?: number
  models?: { id: string; name: string }[]
  usage?: CopilotUsageSnapshot | null
  usageError?: string | null
}

export interface CopilotUsageQuota {
  id: string
  name: string
  isUnlimitedEntitlement: boolean | null
  entitlementRequests: number | null
  usedRequests: number | null
  remainingPercentage: number | null
  resetDate: string | null
  usageAllowedWithExhaustedQuota: boolean | null
  overage: number | null
  overageAllowedWithExhaustedQuota: boolean | null
}
export interface CopilotUsageSnapshot { accountId: string; fetchedAt: number; quotas: CopilotUsageQuota[] }

export interface CopilotCLIStatus {
  installed: boolean
  version: string | null
  phase: 'idle'|'starting'|'waiting'|'verifying'|'connected'|'failed'|'cancelled'|'expired'
  message: string
  code?: string
  url?: string
}
