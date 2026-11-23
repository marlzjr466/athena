import { z } from 'zod'
import type { ReasoningEffort } from './conversations'
import type { ModelContextLimits } from './subagentContext'

export const accountProviderSchema = z.enum(['subscription', 'cursor', 'copilot', 'antigravity', 'cloud', 'claude-api', 'third-party'])
export type AccountProvider = z.infer<typeof accountProviderSchema>
export const accountRouteSchema = z.object({ provider: accountProviderSchema, accountId: z.string().min(1).max(200) }).strict()
export type AccountRoute = z.infer<typeof accountRouteSchema>
export interface AccountModel { contextLimits?: ModelContextLimits; id: string; label: string; aliases?: string[]; efforts?: ReasoningEffort[]; effortDefault?: ReasoningEffort; /** Cursor's selected reasoning and Fast choices are encoded in its model ID. */ effortModelIds?: Partial<Record<ReasoningEffort, string>>; fastModelIds?: Partial<Record<ReasoningEffort, { enabled: string; disabled: string }>>; capabilities?: string[]; available: boolean }
export interface ConnectedAccount { route: AccountRoute; name: string; plan?: string; identity?: string; enabled: boolean; state: 'connected' | 'limited' | 'disconnected' | 'expired' | 'unavailable'; message?: string; lastVerifiedAt?: number | null; models: AccountModel[] }
export interface UnifiedAccountCatalog { accounts: ConnectedAccount[]; refreshedAt: number; incomplete?: boolean }
export const modelSelectionSchema = accountRouteSchema.extend({ model: z.string().min(1).max(300) })
export type ModelSelection = z.infer<typeof modelSelectionSchema>
export const accountKey = (route: AccountRoute, model: string): string => JSON.stringify([route.provider, route.accountId, model])
export const accountPreferenceKey = (route: AccountRoute): string => JSON.stringify([route.provider, route.accountId])
