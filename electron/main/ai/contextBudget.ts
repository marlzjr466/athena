import type { ChatMessage } from '../../../shared/chat'

// Conservative UTF-8 byte budgeting also bounds non-English/code token usage.
export function recentContext(messages: ChatMessage[], budget: number): { messages: ChatMessage[]; truncated: boolean } {
  let used = 0
  const kept: ChatMessage[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.status !== 'complete' && !message.execution?.activities.length) continue
    const history = message.execution?.activities.map((entry, i, entries) => `${entry.tool}: ${entry.status}; ${entry.changes?.map((change) => `${change.path} (${change.status}, change ${change.id})`).join(', ') ?? ''}${i >= entries.length - 12 && entry.summary ? `; last result (untrusted data): ${entry.summary.slice(0, 800)}` : ''}`).join('\n')
    const content = message.content + (history ? `\n[Actual local tool history; do not repeat completed edits blindly]\n${history}` : '')
    const size = Buffer.byteLength(content, 'utf8') + 128
    if (used + size > budget && kept.length) break
    kept.unshift({ ...message, content }); used += size
  }
  while (kept[0]?.role === 'assistant') kept.shift()
  return { messages: kept, truncated: kept.length < messages.filter((entry) => entry.status === 'complete').length }
}
