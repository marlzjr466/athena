import type { ReasoningEffort } from './conversations'

export type AntigravityAuthState = 'authenticated' | 'unauthenticated' | 'unknown'
export interface AntigravityModel { id: string; name: string }
/** Quota values returned by Antigravity's documented structured `/usage` command. */
export interface AntigravityUsageBucket {
  id: string
  name: string
  window: string
  remainingFraction: number | null
  resetAt: string | null
  description?: string
}
export interface AntigravityUsageGroup { id: string; name: string; description?: string; buckets: AntigravityUsageBucket[] }
export interface AntigravityUsageSnapshot {
  fetchedAt: number
  groups: AntigravityUsageGroup[]
  /** Null means the documented CLI did not expose a balance. Zero is a valid balance. */
  creditsRemaining: number | null
  /** Read-only value from the CLI's documented `/config` JSON output. */
  useG1Credits: boolean | null
}
export interface AntigravityStatus {
  installed: boolean
  version: string | null
  authState: AntigravityAuthState
  /** Only the native Antigravity personal OAuth method is supported. */
  authMethod?: 'oauth-personal' | null
  /** Google does not expose personal-account identity through the documented ACP surface. */
  identity: null
  models: AntigravityModel[]
  /** Exact effort values advertised by ACP for each eligible model. */
  modelEfforts: Record<string, ReasoningEffort[]>
  /** ACP-reported current/default effort for each model when available. */
  modelEffortDefaults: Record<string, ReasoningEffort>
  modelCatalogAvailable: boolean
  /** Account-bound quota snapshot from the documented CLI. Persisted without credentials. */
  usage: AntigravityUsageSnapshot | null
  usageError: string | null
  message: string
  /** Last successful CLI installation or ACP identity check. */
  lastCheckedAt?: number | null
}
export type AntigravityCommand = { action: 'status' | 'refresh' | 'usage' | 'login' | 'logout' }
import { z } from 'zod'

export const antigravityCommandSchema = z.object({ action: z.enum(['status', 'refresh', 'usage', 'login', 'logout']) }).strict()
