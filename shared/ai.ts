import { z } from 'zod'
import type { ReasoningEffort } from './conversations'
import type { CursorModelConfiguration } from './cursor'
import type { ModelCapability } from './modelCapabilities'

export const apiKeySchema = z.string().trim().min(20).max(512).regex(/^[!-~]+$/)
export const modelIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/)
export const aiKeyInputSchema = z.object({ apiKey: apiKeySchema }).strict()
export const aiModelInputSchema = z.object({ model: modelIdSchema }).strict()
export type AIConnectionState = 'not-tested' | 'successful' | 'invalid-key' | 'failed'
export interface AIStatus {
  provider: 'OpenAI' | 'ChatGPT Subscription' | 'Codex CLI' | 'Claude API' | 'Cursor Subscription' | 'GitHub Copilot Subscription'
  active: boolean
  hasKey: boolean
  model: string | null
  models: string[]
  modelLabels?: Record<string, string>
  modelFamilies?: Record<string, string>
  /** Authoritative reasoning controls returned by Codex app-server. */
  modelEfforts?: Record<string, ReasoningEffort[]>
  /** False only for provider adapters whose authenticated catalog could not be queried. */
  modelCatalogAvailable?: boolean
  cursorModelConfigurations?: CursorModelConfiguration[]
  /** Capabilities verified for the complete selected provider transport. */
  modelCapabilities?: Record<string, ModelCapability[]>
  lastVerifiedAt: number | null
  connection: AIConnectionState
}
export interface AIResult { ok: boolean; status: AIStatus; message: string }
export const emptyAIStatus = (): AIStatus => ({ provider: 'OpenAI', active: false, hasKey: false, model: null, models: [], lastVerifiedAt: null, connection: 'not-tested' })
