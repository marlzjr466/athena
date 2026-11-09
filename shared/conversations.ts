import { z } from 'zod'
import { modelIdSchema } from './ai'
import { agentModeSchema } from './agent'
import { contextSettingsSchema } from './context'
import { cursorModelIdSchema } from './cursor'

export const effortSchema = z.enum(['auto', 'low', 'medium', 'high', 'xhigh'])
export type ReasoningEffort = z.infer<typeof effortSchema>
const conversationModelIdSchema = z.union([modelIdSchema, cursorModelIdSchema])
export const conversationConfigSchema = z.object({ provider: z.literal('OpenAI').default('OpenAI'), model: conversationModelIdSchema.nullable().default(null), cursorModel: cursorModelIdSchema.nullable().optional(), cursorPendingModel: cursorModelIdSchema.optional(), effort: effortSchema.default('auto'), agentMode: agentModeSchema.optional(), contextSettings: contextSettingsSchema.optional() })
export type ConversationConfig = z.infer<typeof conversationConfigSchema>
export const defaultConversationConfig = (): ConversationConfig => ({ provider: 'OpenAI', model: null, effort: 'auto' })
export const attachmentSchema = z.object({ id: z.string().uuid(), name: z.string().max(255), mime: z.string().max(100), size: z.number().int().nonnegative(), kind: z.enum(['image', 'pdf', 'text']), characters: z.number().int().nonnegative().default(0), origin: z.enum(['file', 'paste']).optional() })
export type Attachment = z.infer<typeof attachmentSchema>
export const workspaceSchema = z.object({ id: z.string().uuid(), name: z.string().max(255), fingerprint: z.string().length(64).regex(/^[a-f0-9]+$/).optional() })
export type WorkspaceReference = z.infer<typeof workspaceSchema>
export interface ConversationSummary { id: string; title: string; updatedAt: number; createdAt: number; config: ConversationConfig; project?: WorkspaceReference; executionStatus?: 'running' | 'queued' | 'recovering' | 'paused' | 'waiting-approval'; unreadCompletion?: 'complete' | 'failed'; pendingApprovalId?: string }
export const sessionCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cancel-subagent'), id: z.string().uuid(), subagentId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal('configure-context'), id: z.string().uuid(), settings: contextSettingsSchema }).strict(),
  z.object({ action: z.literal('agent-mode'), id: z.string().uuid(), mode: agentModeSchema }).strict(),
  z.object({ action: z.literal('project-permissions'), id: z.string().uuid(), mode: agentModeSchema, allowDeletion: z.boolean(), allowCommands: z.boolean() }).strict(),
  z.object({ action: z.literal('agent-approval'), id: z.string().uuid(), approvalId: z.string().uuid(), allow: z.boolean(), remember: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('create'), workspaceId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal('switch'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('rename'), id: z.string().uuid(), title: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.literal('delete'), id: z.string().uuid(), confirmed: z.literal(true).optional() }).strict(),
  z.object({ action: z.literal('configure'), id: z.string().uuid(), config: conversationConfigSchema }).strict(),
  z.object({ action: z.literal('configure-model'), id: z.string().uuid(), model: conversationModelIdSchema }).strict(),
  z.object({ action: z.literal('configure-effort'), id: z.string().uuid(), effort: effortSchema }).strict(),
  z.object({ action: z.literal('edit'), id: z.string().uuid(), messageId: z.string().uuid(), text: z.string().trim().min(1).max(12_000), commandId: z.string().min(1).max(500).optional() }).strict(),
  z.object({ action: z.literal('draft'), id: z.string().uuid(), text: z.string().max(1_000_000) }).strict(),
  z.object({ action: z.literal('more'), id: z.string().uuid() }).strict(),
])
export type SessionCommand = z.infer<typeof sessionCommandSchema>
export const contextCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('project-status'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('revert-change'), sessionId: z.string().uuid(), id: z.string().uuid(), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('pick-files'), sessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('import'), sessionId: z.string().uuid(), name: z.string().min(1).max(255), bytes: z.instanceof(Uint8Array) }).strict(),
  z.object({ action: z.literal('import-pasted'), sessionId: z.string().uuid(), name: z.string().min(1).max(255), text: z.string().min(1).max(1_000_000) }).strict(),
  z.object({ action: z.literal('remove'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('rename'), sessionId: z.string().uuid(), id: z.string().uuid(), name: z.string().min(1).max(255) }).strict(),
  z.object({ action: z.literal('update-text'), sessionId: z.string().uuid(), id: z.string().uuid(), text: z.string().min(1).max(1_000_000) }).strict(),
  z.object({ action: z.literal('preview'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('download'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('preview-artifact'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('artifact-url'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('download-artifact'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('open-artifact'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('connect'), sessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('disconnect'), sessionId: z.string().uuid(), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('project-rename'), sessionId: z.string().uuid(), id: z.string().uuid(), name: z.string().trim().min(1).max(255) }).strict(),
  z.object({ action: z.literal('project-delete'), sessionId: z.string().uuid(), id: z.string().uuid(), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('browse'), sessionId: z.string().uuid(), id: z.string().uuid(), query: z.string().max(200).default(''), offset: z.number().int().min(0).max(100_000).default(0) }).strict(),
  z.object({ action: z.literal('attach-source'), sessionId: z.string().uuid(), id: z.string().uuid(), path: z.string().min(1).max(1000) }).strict(),
])
export type ContextCommand = z.infer<typeof contextCommandSchema>
export interface SourceReference { workspace: string; path: string; start: number; end: number }
export interface ProjectFile { path: string; line: number; excerpt: string }
export interface ContextResult { ok: boolean; message?: string; root?: string; preview?: string; assetUrl?: string; text?: string; saved?: boolean; files?: ProjectFile[]; total?: number; truncated?: boolean }

// /models lists IDs, not capabilities. Unknown/new models safely use provider defaults.
// Only known families receive explicit settings; the live catalog remains authoritative.
export function modelCapabilities(model: string | null, transport?: 'cursor-acp' | 'openai-responses' | 'claude-messages' | 'ollama' | 'unknown'): { efforts: ReasoningEffort[]; vision: boolean; contextCharacters: number; fileInput?: boolean; toolCalling?: boolean; reason?: string } {
  const id = model ?? ''
  let efforts: ReasoningEffort[] = ['auto']
  if (/^(o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(id) && !/chat|pro/.test(id)) efforts = ['auto', 'low', 'medium', 'high']
  if (/^gpt-5\.[2345](?:-|$)/.test(id) && !/chat/.test(id)) efforts = /pro/.test(id) ? ['auto', 'medium', 'high', 'xhigh'] : ['auto', 'low', 'medium', 'high', 'xhigh']
  if (/^gpt-5\.6(?:-|$)/.test(id)) efforts = ['auto', 'low', 'medium', 'high', 'xhigh']
  if (/^gpt-6-(?:astra|sol)(?:-|$)/.test(id)) efforts = ['auto', 'low', 'medium', 'high', 'xhigh']
  if (/^gpt-6\.1-sol(?:-|$)/.test(id)) efforts = ['auto', 'low', 'medium', 'high', 'xhigh']
  if (/^gpt-5\.6-luna(?:-|$)/.test(id)) efforts = ['auto', 'low', 'medium', 'high', 'xhigh']
  const cursorVision = transport === 'cursor-acp' && /^(?:cursor-)?grok-4\.(?:6|7)(?:-|\[|$)/i.test(id)
  const vision = cursorVision || (/^(gpt-4o|gpt-4\.1|gpt-5|gpt-6(?:\.1-sol|-astra|-sol)|o3(?:-|$)|o4)/.test(id) && !/audio|transcribe|tts/.test(id))
  return { efforts, vision, fileInput: vision, toolCalling: vision, contextCharacters: cursorVision || /^gpt-(4\.1|5|6(?:\.1-sol|-astra|-sol))|^o[34]/.test(id) ? 100_000 : 20_000,
    ...(transport === 'cursor-acp' && !cursorVision ? { reason: 'Cursor ACP did not verify image input for this selected model.' } : {}) }
}
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** Long clipboard text is kept out of the inline message contract, but remains a bounded local attachment. */
export const MAX_TEXT_ATTACHMENT_CHARACTERS = 1_000_000
/** Drafts may temporarily hold a restored long attachment while it is edited. */
export const MAX_DRAFT_LENGTH = MAX_TEXT_ATTACHMENT_CHARACTERS
/** Pasting at or above this size creates a managed text attachment. */
export const LONG_TEXT_PASTE_THRESHOLD = 12_000
export const MAX_ATTACHMENTS = 8
