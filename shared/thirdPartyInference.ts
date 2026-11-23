import { z } from 'zod'
import { modelIdSchema } from './ai'
import { effortSchema, type ReasoningEffort } from './conversations'

export const inferenceProviderSchema = z.enum(['anthropic-compatible', 'openai-compatible', 'custom', 'anthropic', 'openai', 'gemini', 'bedrock', 'bedrock-mantle', 'vertex', 'foundry'])
export const inferenceProtocolSchema = z.enum(['anthropic-messages', 'openai-chat-completions', 'openai-responses', 'gemini-native', 'bedrock-converse', 'azure-foundry-chat'])
export const inferenceAuthSchema = z.enum(['api-key', 'bearer', 'x-api-key', 'aws-default', 'aws-static', 'google-adc', 'azure-key', 'azure-identity'])
export const inferenceCapabilitiesSchema = z.object({ contextWindow: z.number().int().positive().max(10_000_000).optional(), maxOutputTokens: z.number().int().positive().max(1_000_000).optional(), inputTokens: z.boolean().optional(), imageInput: z.boolean().optional(), toolCalling: z.boolean().optional(), streamingToolCalling: z.boolean().optional(), parallelToolCalling: z.boolean().optional(), streaming: z.boolean().optional(), usageMetadata: z.boolean().optional(), sampling: z.boolean().optional(), reasoning: z.boolean().optional(), reasoningEfforts: z.array(effortSchema).max(8).optional(), reasoningDefault: effortSchema.optional(), reasoningParameterPath: z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/).optional(), reasoningValueMap: z.partialRecord(effortSchema, z.union([z.string().max(80), z.number().int().min(0).max(1_000_000)])).optional(), thinkingMode: z.enum(['adaptive','enabled','disabled']).optional(), thinkingBudget: z.number().int().min(1024).max(1_000_000).optional(), reasoningRequired: z.boolean().optional(), structuredOutput: z.boolean().optional(), promptCaching: z.boolean().optional(), functionCalling: z.boolean().optional() }).strict()
export const inferenceModelSchema = z.object({ id: modelIdSchema, displayName: z.string().trim().min(1).max(200).optional(), enabled: z.boolean().default(true), source: z.enum(['provider','manual']).default('provider'), reportedCapabilities: inferenceCapabilitiesSchema.optional(), configuredCapabilities: inferenceCapabilitiesSchema.optional() }).strict()
export const inferenceHeaderSchema = z.object({ name: z.string().trim().min(1).max(100).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), value: z.string().max(4096), sensitive: z.boolean().default(true) }).strict()
export const inferenceConnectionSchema = z.object({
  id: z.string().uuid(), version: z.literal(1).default(1), name: z.string().trim().min(1).max(80), provider: inferenceProviderSchema, protocol: inferenceProtocolSchema,
  enabled: z.boolean().default(true), isDefault: z.boolean().default(false), baseUrl: z.string().max(2048).optional(), resourceUrl: z.string().max(2048).optional(), deployment: z.string().max(200).optional(), region: z.string().max(100).optional(), projectId: z.string().max(200).optional(), accountId: z.string().max(200).optional(), apiVersion: z.string().max(100).optional(),
  auth: inferenceAuthSchema, credentialConfigured: z.boolean().default(false), customHeaders: z.array(z.object({ name: inferenceHeaderSchema.shape.name, hasValue: z.boolean() }).strict()).max(32).default([]), models: z.array(inferenceModelSchema).max(2000).default([]), defaultModel: modelIdSchema.nullable().default(null), status: z.enum(['not-tested','connected','payment-required','authentication-failed','endpoint-invalid','discovery-unavailable','model-unavailable','provider-error','network-error','timeout']).default('not-tested'), statusMessage: z.string().max(500).default('Not tested.'), lastTestedAt: z.number().finite().nullable().default(null), lastSuccessfulTestAt: z.number().finite().nullable().default(null), lastDiscoveryAt: z.number().finite().nullable().default(null), lastReasoning: z.object({ model: modelIdSchema, requested: effortSchema, effective: effortSchema.nullable(), observedAt: z.number().finite() }).strict().optional(), usage: z.object({ requests: z.number().int().nonnegative().default(0), inputTokens: z.number().nonnegative().default(0), cachedInputTokens: z.number().nonnegative().default(0), outputTokens: z.number().nonnegative().default(0), reasoningTokens: z.number().nonnegative().default(0), source: z.enum(['provider-reported','unavailable']).default('unavailable') }).strict().default({ requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, source: 'unavailable' }), allowPrivateNetwork: z.boolean().default(false), generation: z.object({ temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(), maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(), timeoutSeconds: z.number().int().min(5).max(600).default(120), streaming: z.boolean().default(true) }).strict().default({ timeoutSeconds:120, streaming:true }), createdAt: z.number().finite(), updatedAt: z.number().finite(),
}).strict()
export type InferenceConnection = z.infer<typeof inferenceConnectionSchema>
/** A 402 applies to the probed model or account allowance, not the discovered catalog. */
export const inferenceCatalogSelectable = (profile: InferenceConnection): boolean => profile.status === 'connected' || profile.status === 'payment-required' || (profile.status === 'provider-error' && /HTTP 402\b/.test(profile.statusMessage))
export type InferenceModel = z.infer<typeof inferenceModelSchema>
export type InferenceProvider = z.infer<typeof inferenceProviderSchema>
export type InferenceProtocol = z.infer<typeof inferenceProtocolSchema>
export type InferenceAuth = z.infer<typeof inferenceAuthSchema>
export function inferenceModelEfforts(model: InferenceModel | undefined): ReasoningEffort[] | undefined {
  const capabilities = { ...model?.reportedCapabilities, ...model?.configuredCapabilities }
  if (capabilities.reasoning !== true) return undefined
  const levels = capabilities.reasoningEfforts?.filter(level => level !== 'auto') ?? []
  return levels.length ? ['auto', ...new Set(levels)] : undefined
}
export const inferenceSecretInputSchema = z.object({ apiKey: z.string().max(4096).optional(), bearerToken: z.string().max(4096).optional(), accessKeyId: z.string().max(256).optional(), secretAccessKey: z.string().max(4096).optional(), sessionToken: z.string().max(4096).optional(), customHeaders: z.array(inferenceHeaderSchema).max(32).optional() }).strict()
export const inferenceConnectionInputSchema = inferenceConnectionSchema.omit({ credentialConfigured:true, customHeaders:true, createdAt:true, updatedAt:true, status:true, statusMessage:true, lastTestedAt:true, lastSuccessfulTestAt:true, lastDiscoveryAt:true, lastReasoning:true, usage:true }).extend({ id: z.string().uuid().optional(), credentials: inferenceSecretInputSchema.optional(), customHeaders: z.array(inferenceHeaderSchema).max(32).optional() }).strict()
export const inferenceCommandSchema = z.discriminatedUnion('action', [
  z.object({ action:z.literal('list') }).strict(),
  z.object({ action:z.literal('save'), connection:inferenceConnectionInputSchema }).strict(),
  z.object({ action:z.literal('delete'), id:z.string().uuid() }).strict(),
  z.object({ action:z.literal('duplicate'), id:z.string().uuid() }).strict(),
  z.object({ action:z.literal('test'), id:z.string().uuid(), model:modelIdSchema.optional() }).strict(),
  z.object({ action:z.literal('discover'), id:z.string().uuid() }).strict(),
  z.object({ action:z.literal('select-default'), id:z.string().uuid() }).strict(),
  z.object({ action:z.literal('set-enabled'), id:z.string().uuid(), enabled:z.boolean() }).strict(),
  z.object({ action:z.literal('add-model'), id:z.string().uuid(), model:inferenceModelSchema }).strict(),
  z.object({ action:z.literal('remove-credential'), id:z.string().uuid() }).strict(),
  z.object({ action:z.literal('export') }).strict(),
  z.object({ action:z.literal('import'), config:z.unknown() }).strict(),
])
export type InferenceCommand = z.infer<typeof inferenceCommandSchema>
export interface InferenceResult { ok:boolean; message:string; connections:InferenceConnection[]; activeConnectionId:string|null; export?:unknown }
