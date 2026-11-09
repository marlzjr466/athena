import { create } from 'zustand'
import { desktop } from '../services/desktop'
import { emptyChatSnapshot, type ChatResult, type ChatSnapshot } from '../../shared/chat'
import type { SessionCommand } from '../../shared/conversations'

interface ChatStore {
  snapshot: ChatSnapshot
  issue: string | null
  pending: boolean
  send(text: string, commandId?: string): Promise<boolean>
  retry(): Promise<boolean>
  stop(): Promise<boolean>
  clear(): Promise<boolean>
  command(input: SessionCommand): Promise<boolean>
}
const accept = (snapshot: ChatSnapshot) => {
  if (snapshot.revision >= useChat.getState().snapshot.revision) useChat.setState({ snapshot })
}
async function request(operation: () => Promise<ChatResult>): Promise<boolean> {
  if (useChat.getState().pending) return false
  useChat.setState({ pending: true, issue: null })
  try {
    const result = await operation()
    if (!result.ok) useChat.setState({ issue: result.message ?? 'The request could not be completed.' })
    return result.ok
  } catch { useChat.setState({ issue: 'Could not reach Athena’s desktop process. Reopen the app and try again.' }); return false }
  finally { useChat.setState({ pending: false }) }
}
async function approvalRequest(operation: () => Promise<ChatResult>): Promise<boolean> {
  try {
    const result = await operation()
    if (!result.ok) useChat.setState({ issue: result.message ?? 'The request could not be completed.' })
    return result.ok
  } catch { useChat.setState({ issue: 'Could not reach Athena’s desktop process. Reopen the app and try again.' }); return false }
}
export const useChat = create<ChatStore>((_set, get) => ({
  snapshot: emptyChatSnapshot(), issue: null, pending: false,
  send: (text, commandId) => request(() => desktop.sendChat({ text, sessionId: get().snapshot.sessionId, requestId: crypto.randomUUID(), ...(commandId ? { commandId } : {}) })),
  command: (input) => input.action === 'agent-approval' ? approvalRequest(() => desktop.chatSession(input)) : request(() => desktop.chatSession(input)),
  retry: () => request(() => desktop.retryChat()),
  stop: () => request(() => desktop.stopChat()),
  clear: () => request(() => desktop.clearChat()),
}))
export function connectChat(): () => void {
  let live = true
  const off = desktop.onChat((snapshot) => { if (live) accept(snapshot) })
  void desktop.getChat().then((snapshot) => { if (live) accept(snapshot) }).catch(() => {
    if (live) useChat.setState({ issue: 'Could not load the conversation. Reopen this page to retry.' })
  })
  return () => { live = false; off() }
}
