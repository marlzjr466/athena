import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { executionSchema } from '../../../shared/agent'
import { contextCheckpointSchema } from '../../../shared/context'
import { attachmentSchema, conversationConfigSchema, defaultConversationConfig, MAX_DRAFT_LENGTH, workspaceSchema, type ConversationConfig } from '../../../shared/conversations'
import { slashCommandMetaSchema } from '../../../shared/slashCommands'
import { aiOwnershipSchema } from '../../../shared/aiOwnership'

const artifactSchema = z.object({ id: z.string().uuid(), name: z.string().max(255), mimeType: z.string().max(160), size: z.number().int().nonnegative(), createdAt: z.number(), storageKey: z.string().max(500), status: z.enum(['generated', 'saving', 'ready', 'failed', 'cancelled']).optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), provider: z.string().max(80).optional(), error: z.string().max(500).optional() })
const messageSchema = z.object({ ownership: aiOwnershipSchema.optional(), id: z.string().uuid(), role: z.enum(['user', 'assistant']), content: z.string().max(48_000), status: z.enum(['complete', 'streaming', 'stopped', 'error']), createdAt: z.number(), error: z.string().optional(), requestId: z.string().uuid().optional(), execution: executionSchema.optional(), attachments: z.array(attachmentSchema).max(8).optional(), artifacts: z.array(artifactSchema).max(32).optional(), sources: z.array(z.object({ workspace: z.string(), path: z.string(), start: z.number(), end: z.number() })).optional(), command: slashCommandMetaSchema.optional() })
export const sessionSchema = z.object({ id: z.string().uuid(), title: z.string().max(120), createdAt: z.number(), updatedAt: z.number(), config: conversationConfigSchema, messages: z.array(messageSchema).max(10_000), draft: z.string().max(MAX_DRAFT_LENGTH).default(''), attachments: z.array(attachmentSchema).max(8).default([]), workspaces: z.array(workspaceSchema).max(8).default([]), contextCheckpoint: contextCheckpointSchema.optional().catch(undefined), unreadCompletion: z.enum(['complete', 'failed']).optional() })
export type Conversation = z.infer<typeof sessionSchema>
export const librarySchema = z.object({ version: z.literal(1), activeId: z.string().uuid(), sessions: z.array(sessionSchema).min(1).max(500) })
export type ConversationLibrary = z.infer<typeof librarySchema>
export function newConversation(config: ConversationConfig = defaultConversationConfig()): Conversation {
  return { id: randomUUID(), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), config: { ...config }, messages: [], draft: '', attachments: [], workspaces: [] }
}
export interface ConversationStorage { load(): ConversationLibrary; save(library: ConversationLibrary): void; archive(session: Conversation): void }
export class ConversationRepository implements ConversationStorage {
  private file: string
  constructor(private directory: string) { this.file = join(directory, 'conversations.json') }
  load(): ConversationLibrary {
    if (!existsSync(this.file)) { const session = newConversation(); return { version: 1, activeId: session.id, sessions: [session] } }
    // Do not silently overwrite damaged history. Startup can report a recovery error.
    const data = librarySchema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    for (const session of data.sessions) for (const message of session.messages) {
      if (message.execution?.approval) {
        message.execution.approval = undefined
        message.execution.status = 'cancelled'
        message.execution.finishedAt = Date.now()
        message.error = [message.error, 'Athena restarted before this approval was answered. The request was cancelled safely; review and submit the operation again if it is still needed.'].filter(Boolean).join(' ')
        session.unreadCompletion = 'failed'
      }
      for (const activity of message.execution?.activities ?? []) if (activity.subagent && ['queued', 'running'].includes(activity.subagent.status)) {
        activity.subagent.status = 'interrupted'; activity.subagent.reviewAccepted = false
        activity.subagent.error = 'Athena restarted. Resume explicitly from saved child observations after validating the project and artifacts.'
        activity.status = 'error'
      }
      // Preserve recoverability for runs interrupted by token expiry before
      // structured waiting-auth states existed. No tool is replayed on load.
      if (message.execution?.status === 'error' && message.error && /ChatGPT authorization.*token_expired/i.test(message.error)) {
        message.execution.status = 'waiting-auth'
        if (message.execution.taskCheckpoint) message.execution.taskCheckpoint.pendingActions = ['Reconnect the ChatGPT account used for this run, inspect current files, then explicitly continue unfinished work.']
      }
    }
    for (const session of data.sessions) for (const message of session.messages) if (message.status === 'streaming') {
      message.status = 'stopped'; message.error = 'Request interrupted when Athena closed. Review any completed changes before continuing.'
      if (message.execution) { message.execution.status = 'cancelled'; message.execution.finishedAt = message.execution.updatedAt; message.execution.approval = undefined; if (message.execution.recovery) message.execution.recovery.continuing = false; for (const activity of message.execution.activities) if (activity.status === 'running') activity.status = 'cancelled' }
      session.unreadCompletion = 'failed'
    }
    if (!data.sessions.some((session) => session.id === data.activeId)) data.activeId = data.sessions[0].id
    return data
  }
  save(library: ConversationLibrary): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(library), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
  archive(session: Conversation): void {
    const directory = join(this.directory, 'conversation-archive')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, `${session.id}-${Date.now()}.json`), JSON.stringify(session), { mode: 0o600 })
  }
}
