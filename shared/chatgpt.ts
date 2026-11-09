import { z } from 'zod'
import { modelIdSchema } from './ai'

export const chatGPTModelSchema = z.object({ slug: modelIdSchema, displayName: z.string().min(1).max(200) })
export type ChatGPTModel = z.infer<typeof chatGPTModelSchema>
export interface ChatGPTStatus {
  connected: boolean
  planEnabled: boolean
  email: string | null
  model: string | null
  models: ChatGPTModel[]
  message: string
  accounts: ChatGPTAccountStatus[]
  activeAccountId: string | null
  pendingAccount: ChatGPTPendingAccount | null
}
export interface ChatGPTAccountStatus {
  id: string
  label: string
  email: string | null
  connected: boolean
  planEnabled: boolean
  enabled: boolean
  active: boolean
  model: string | null
  models: ChatGPTModel[]
  message: string
}
export interface ChatGPTPendingAccount {
  id: string
  label: string
  email: string | null
  planEnabled: boolean
  model: string | null
  models: ChatGPTModel[]
  sameIdentityAlreadyConnected: boolean
}
export interface ChatGPTPendingAccountInput { pendingId: string; label?: string }
export interface ChatGPTPendingIdInput { pendingId: string }
export interface ChatGPTAccountInput { accountId: string }
export interface ChatGPTAccountEnabledInput extends ChatGPTAccountInput { enabled: boolean }
export interface ChatGPTAccountLabelInput extends ChatGPTAccountInput { label: string }
export interface ChatGPTAccountModelInput extends ChatGPTAccountInput { model: string }
export const emptyChatGPTStatus = (): ChatGPTStatus => ({ connected: false, planEnabled: false, email: null, model: null, models: [], message: 'Not connected.', accounts: [], activeAccountId: null, pendingAccount: null })
export const isChatGPTUsageLimitMessage = (message: string | undefined): boolean => Boolean(message && (message.includes('subscription_sharing_usage_limit_exceeded') || /ChatGPT plan usage limit reached/i.test(message)))
