import { z } from 'zod'
import { modelIdSchema } from './ai'

export const webAccessSettingsSchema = z.object({
  systemInformationEnabled: z.boolean().default(true),
  webSearchEnabled: z.boolean().default(false),
  automaticSearch: z.boolean().default(true),
  searchProvider: z.enum(['brave', 'openai-built-in']).default('brave'),
  // Independent of the model used by online chat or local Athena.
  openAIModel: modelIdSchema.nullable().default(null),
  maxResults: z.number().int().min(1).max(10).default(5),
  timeoutSeconds: z.number().int().min(3).max(30).default(10),
  openAIResponseTimeoutSeconds: z.number().int().min(25).max(90).default(45),
  timezone: z.string().trim().max(100).default('local'),
  timeFormat: z.enum(['12h', '24h']).default('12h'),
}).strict()

export type WebAccessSettings = z.infer<typeof webAccessSettingsSchema>
export const webAccessDefaults = webAccessSettingsSchema.parse({})

export interface WebSearchStatus {
  hasKey: boolean
  provider: 'Brave Search API' | 'OpenAI built-in web search'
  active: boolean
  model: string | null
  availableModels: string[]
  validated: boolean
  strictOffline: boolean
  note: string
}

export interface WebSearchTestResult {
  ok: boolean
  message: string
  resultCount?: number
  model?: string
}

export interface WebCitation {
  title: string
  url: string
  source: string
  publicationDate?: string
  retrievedAt: string
}
