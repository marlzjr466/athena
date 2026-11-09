import { create } from 'zustand'
import { emptyChatSnapshot, type ChatResult, type ChatSnapshot } from '../../shared/chat'
import type { SessionCommand } from '../../shared/conversations'
import { desktop } from '../services/desktop'

interface AthenaChatStore {
  snapshot: ChatSnapshot
  pending: boolean
  issue: string | null
  send(text: string, commandId?: string): Promise<boolean>
  stop(): Promise<boolean>
  retry(): Promise<boolean>
  clear(): Promise<boolean>
  command(input: SessionCommand): Promise<boolean>
}

async function request(operation: () => Promise<ChatResult>): Promise<boolean> {
  if (useAthenaChat.getState().pending) return false
  useAthenaChat.setState({ pending: true, issue: null })
  try {
    const result = await operation()
    if (!result.ok) useAthenaChat.setState({ issue: result.message ?? 'The local request could not be completed.' })
    return result.ok
  } catch {
    useAthenaChat.setState({ issue: 'Could not reach Athena’s local chat service.' })
    return false
  } finally { useAthenaChat.setState({ pending: false }) }
}
async function approvalRequest(operation: () => Promise<ChatResult>): Promise<boolean> {
  try {
    const result = await operation()
    if (!result.ok) useAthenaChat.setState({ issue: result.message ?? 'The local request could not be completed.' })
    return result.ok
  } catch {
    useAthenaChat.setState({ issue: 'Could not reach Athena’s local chat service.' })
    return false
  }
}

export const useAthenaChat = create<AthenaChatStore>((_set, get) => ({
  snapshot: emptyChatSnapshot(), pending: false, issue: null,
  send: (text, commandId) => request(() => desktop.sendAthenaChat({ text, ...(commandId ? { commandId } : {}), sessionId: get().snapshot.sessionId, requestId: crypto.randomUUID() })),
  stop: () => request(() => desktop.stopAthenaChat()),
  retry: () => request(() => desktop.retryAthenaChat()),
  clear: () => request(() => desktop.clearAthenaChat()),
  command: input => input.action === 'agent-approval' ? approvalRequest(() => desktop.athenaChatSession(input)) : request(() => desktop.athenaChatSession(input)),
}))

export function connectAthenaChat(): () => void {
  let live = true
  const accept = (snapshot: ChatSnapshot) => {
    if (live && snapshot.revision >= useAthenaChat.getState().snapshot.revision) useAthenaChat.setState({ snapshot })
  }
  const off = desktop.onAthenaChat(accept)
  void desktop.getAthenaChat().then(accept).catch(() => {
    if (live) useAthenaChat.setState({ issue: 'Could not load private Athena Chat history.' })
  })
  return () => { live = false; off() }
}
