import { IPC } from '../../../shared/ipcChannels'
import { contextCommandSchema, sessionCommandSchema } from '../../../shared/conversations'
import type { ChatController } from './chatController'
import type { ChatContextService } from './chatContextService'
import { ChatError } from './AIProvider'

export interface CompanionConversation { chat: ChatController; context: ChatContextService }
export const companionChannels: ReadonlySet<string> = new Set([
  IPC.chatGet, IPC.chatSend, IPC.chatStop, IPC.chatSession, IPC.chatContext,
])

/** Renderer identity chooses the local lane; untrusted payloads cannot select a provider. */
export function routeCompanionRequest(channel: string, input: unknown, runtime: CompanionConversation) {
  const { chat, context } = runtime
  switch (channel) {
    case IPC.chatGet: return chat.snapshot()
    case IPC.chatSend: return chat.send(input)
    case IPC.chatStop: return chat.stop()
    case IPC.chatContext: {
      const command = contextCommandSchema.parse(input)
      if (!['connect', 'browse', 'attach-source', 'pick-files', 'remove', 'import-pasted', 'rename', 'update-text', 'preview'].includes(command.action)) return { ok: false, message: 'This file operation requires the local control center.' }
      return context.run(command)
    }
    case IPC.chatSession: {
      const command = sessionCommandSchema.parse(input)
      if (command.action === 'configure-model' || command.action === 'configure') {
        return { ok: false, message: 'Change the active local companion model in local model settings.' }
      }
      if ('id' in command && !chat.getSession(command.id)) throw new ChatError('This conversation does not belong to the local companion.')
      if (!['draft', 'agent-approval', 'create', 'switch', 'rename', 'delete', 'more'].includes(command.action)) return { ok: false, message: 'Change project and model permissions from the local control center.' }
      return chat.command(command)
    }
    default: throw new ChatError('This operation is unavailable in the local companion.')
  }
}
