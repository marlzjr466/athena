import type { Settings } from '../../../shared/settings'
import { ChatError } from './AIProvider'
import type { ChatMessage } from '../../../shared/chat'

export const ONLINE_SELECTION_REQUIRED = 'Choose an online provider in Settings → AI for this conversation. Your local model and history are preserved; use the floating companion for local chat.'

export function requireOnlineProvider(settings: Settings): void {
  if (settings.aiMode === 'local' || settings.aiMode === 'unconfigured') throw new ChatError(ONLINE_SELECTION_REQUIRED)
}

export function requireOnlineHistory(settings: Settings, messages: ChatMessage[]): void {
  if (!settings.reviewLegacyLocalHistory) return
  // User messages are not ownership-tagged. Every prior assistant execution
  // must positively identify the online lane before its context can leave it.
  if (messages.some(message => message.role === 'assistant' && message.ownership?.origin !== 'online-chat')) {
    throw new ChatError('This preserved conversation predates local/online separation and may contain private local context. Start a new online conversation. The original history has not been changed or sent to an online provider.')
  }
}

/** The companion's offline preference must never change an online execution. */
export function onlineContextSettings(settings: Settings): Settings {
  return { ...settings, strictOffline: false }
}
