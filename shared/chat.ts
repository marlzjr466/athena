import { z } from 'zod'
import type { AgentExecution } from './agent'
import type { Attachment, ConversationConfig, ConversationSummary, SourceReference, WorkspaceReference } from './conversations'
import type { SlashCommandMeta } from './slashCommands'
import type { AIOwnership } from './aiOwnership'
import type { AutomationProgress } from './automation'

export const MAX_MESSAGE_LENGTH = 12_000
export const MAX_RESPONSE_LENGTH = 48_000
export const MAX_CONVERSATION_LENGTH = 160_000
export const MAX_CHAT_MESSAGES = 100

/** Search evidence remains available to the agent, but source appendices are not user-facing answer text. */
export function stripTrailingSourcesSection(content: string): string {
  const appendix = /(?:^|\r?\n[ \t]*\r?\n)Sources:\s*\r?\n[\s\S]*$/i.exec(content)
  return appendix ? content.slice(0, appendix.index).trimEnd() : content
}

export const chatInputSchema = z.object({ text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH), sessionId: z.string().uuid().optional(), requestId: z.string().uuid().optional(), commandId: z.string().min(1).max(500).optional() }).strict()
export const chatCopySchema = z.object({ text: z.string().max(MAX_RESPONSE_LENGTH) }).strict()
export interface ChatMessage {
  ownership?: AIOwnership
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'complete' | 'streaming' | 'stopped' | 'error'
  createdAt: number
  error?: string
  attachments?: Attachment[]
  artifacts?: GeneratedArtifact[]
  sources?: SourceReference[]
  requestId?: string
  execution?: AgentExecution
  command?: SlashCommandMeta
}
export interface GeneratedArtifact {
  id: string
  name: string
  mimeType: string
  size: number
  createdAt: number
  /** Main-process managed identifier; no file bytes are persisted in chat history. */
  storageKey: string
  /** An artifact is only exposed to the renderer after it reaches ready. */
  status?: 'generated' | 'saving' | 'ready' | 'failed' | 'cancelled'
  width?: number
  height?: number
  provider?: string
  error?: string
}
export type ChatPhase = 'idle' | 'thinking' | 'speaking'
export interface ChatSnapshot { ownership?: AIOwnership; revision: number; messages: ChatMessage[]; phase: ChatPhase; error: string | null; sessionId?: string; sessions?: ConversationSummary[]; config?: ConversationConfig; draft?: string; attachments?: Attachment[]; workspaces?: Array<WorkspaceReference & { authorized: boolean }>; hasMore?: boolean; contextNotice?: string; cursorModelNotice?: string; voiceSearchPreview?: ChatMessage; automationProgress?: AutomationProgress }
export interface ChatResult { ok: boolean; message?: string }
export type AIChunk =
  | { type: 'text'; text: string }
  | { type: 'activity'; id: string; tool: string; label: string; status: 'running' | 'complete' | 'error' | 'cancelled' }
  | { type: 'artifact'; artifact: GeneratedArtifact }
  | { type: 'done' }
export const emptyChatSnapshot = (): ChatSnapshot => ({ revision: 0, messages: [], phase: 'idle', error: null })
