import type { ChatMessage } from '../../../shared/chat'

const TOOL_HISTORY_MARKER = '\n[Actual local tool history; do not repeat completed edits blindly]\n'

export interface FittedHistory {
  messages: ChatMessage[]
  compacted: boolean
  originalBytes: number
  finalBytes: number
  currentRequestBytes: number
}

function promptContent(message: ChatMessage): string {
  const marker = message.content.indexOf(TOOL_HISTORY_MARKER)
  return marker < 0 ? message.content : message.content.slice(0, marker)
}

function historyEntrySize(message: ChatMessage): number {
  const activityReserve = Math.min(2_000, (message.execution?.activities.length ?? 0) * 260)
  return Buffer.byteLength(promptContent(message), 'utf8') + 128 + activityReserve + (message.attachments?.length ?? 0) * 160
}

function compactRecentMessage(message: ChatMessage): ChatMessage {
  const existing = promptContent(message)
  const priorRecord = existing.indexOf('\n[Recent operation record; full details remain in Activity]')
  const content = priorRecord < 0 ? existing : existing.slice(0, priorRecord)
  const operations = (message.execution?.activities ?? []).slice(-6).map(activity => {
    const paths = activity.changes?.map(change => change.path).slice(0, 3).join(', ')
    const result = activity.summary?.replace(/\s+/g, ' ').slice(0, 120)
    return `- ${activity.status}: ${activity.tool}${paths ? `; ${paths}` : ''}${result ? `; ${result}` : ''}`
  })
  return { ...message, content: `${content}${operations.length ? `\n[Recent operation record; full details remain in Activity]\n${operations.join('\n')}` : ''}` }
}

function summarizeOlderMessages(messages: ChatMessage[], budget: number): string {
  if (budget < 256 || !messages.length) return ''
  const candidates: Array<{ text: string; score: number; time: number }> = []
  for (const message of messages) {
    const role = message.role === 'user' ? 'User requirement' : 'Athena result'
    const content = promptContent(message).trim()
    if (content) {
      const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      const rankedLines = lines.map((line, index) => ({ line: line.slice(0, 700), index,
        score: (message.role === 'user' ? 5 : 1) + (/\b(?:must|shall|required|never|do not|don't|acceptance|decision|constraint|pending|remaining|failed|error|verified|ticket|MBM-\d+)\b|(?:\/|\\)[\w.-]+\.[\w.-]+/i.test(line) ? 5 : 0) + (index === 0 ? 1 : 0) }))
      const selected = rankedLines.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, message.role === 'user' ? 6 : 2).sort((a, b) => a.index - b.index)
      const selectedLines = selected.map(item => item.line)
      if (selectedLines.length) {
        const date = new Date(message.createdAt)
        const dateLabel = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'date unavailable'
        candidates.push({ text: `- ${role} (${dateLabel}): ${selectedLines.join(' / ')}`, score: (message.role === 'user' ? 10 : 2) + Math.max(...selected.map(item => item.score)), time: message.createdAt })
      }
    }
    for (const activity of message.execution?.activities.slice(-8) ?? []) {
      const paths = activity.changes?.map(change => change.path).slice(0, 4).join(', ')
      const summary = activity.summary?.replace(/\s+/g, ' ').slice(0, 220)
      const detail = [activity.status, activity.tool, paths && `paths: ${paths}`, summary].filter(Boolean).join('; ')
      if (detail) candidates.push({ text: `- Recorded operation: ${detail}`, score: 7, time: activity.finishedAt ?? message.createdAt })
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.time - a.time)
  const heading = 'Earlier conversation checkpoint (condensed from original turns; original messages remain in Athena history):'
  let result = heading
  for (const item of candidates) {
    const addition = `\n${item.text}`
    if (Buffer.byteLength(result + addition, 'utf8') > budget) continue
    result += addition
  }
  return result === heading ? '' : result
}

/** Fits provider-bound message history by summarizing older turns and retaining
 * the newest request verbatim. The source conversation is never mutated. */
export function fitConversationHistory(messages: ChatMessage[], maxBytes: number): FittedHistory {
  const originalBytes = messages.reduce((sum, message) => sum + historyEntrySize(message), 0)
  const lastUserIndex = messages.map(message => message.role).lastIndexOf('user')
  const current = lastUserIndex >= 0 ? messages[lastUserIndex] : messages.at(-1)
  const currentRequestBytes = current ? historyEntrySize(current) : 0
  if (originalBytes <= maxBytes) return { messages, compacted: false, originalBytes, finalBytes: originalBytes, currentRequestBytes }
  if (maxBytes <= 0 || currentRequestBytes > maxBytes) return { messages: current ? [current] : [], compacted: true, originalBytes, finalBytes: currentRequestBytes, currentRequestBytes }

  const summaryBudget = Math.min(24_000, Math.floor(maxBytes * 0.32))
  const recentBudget = Math.max(currentRequestBytes, maxBytes - summaryBudget)
  const recent: ChatMessage[] = []
  let recentBytes = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (index < lastUserIndex && recentBytes >= currentRequestBytes) break
    const size = historyEntrySize(message)
    if (recent.length && recentBytes + size > recentBudget) break
    recent.unshift(message)
    recentBytes += size
    if (index === lastUserIndex) continue
  }
  // If a single recent assistant turn was larger than the available tail,
  // retain only the current user request; its content is never shortened.
  if (!recent.some(message => message.id === current?.id)) recent.unshift(current!)
  const selectedIds = new Set(recent.map(message => message.id))
  const older = messages.filter(message => !selectedIds.has(message.id))
  const availableSummary = Math.max(0, maxBytes - recent.reduce((sum, message) => sum + historyEntrySize(message), 0) - 128)
  const summary = summarizeOlderMessages(older, Math.min(summaryBudget, availableSummary))
  const summaryMessage: ChatMessage | undefined = summary ? {
    id: `context-summary-${current?.id ?? 'request'}`, role: 'assistant', status: 'complete',
    createdAt: older[0]?.createdAt ?? current?.createdAt ?? Date.now(), content: summary,
  } : undefined
  const fitted = [...(summaryMessage ? [summaryMessage] : []), ...recent.map(compactRecentMessage)]
  const finalBytes = fitted.reduce((sum, message) => sum + historyEntrySize(message), 0)
  return { messages: finalBytes <= maxBytes ? fitted : (current ? [current] : []), compacted: true, originalBytes, finalBytes: finalBytes <= maxBytes ? finalBytes : currentRequestBytes, currentRequestBytes }
}

export function compactConversationHistoryText(messages: ChatMessage[], maxBytes: number): { text: string; compacted: boolean; fits: boolean; originalBytes: number; finalBytes: number; currentRequestBytes: number } {
  const fit = fitConversationHistory(messages, maxBytes)
  const text = fit.messages.filter(message => message.status === 'complete' || message.status === 'streaming')
    .map(message => `${message.role === 'user' ? 'User' : 'Athena'}: ${compactRecentMessage(message).content}`).join('\n\n')
  const finalBytes = Buffer.byteLength(text, 'utf8')
  return { text, compacted: fit.compacted, fits: fit.currentRequestBytes <= maxBytes && finalBytes <= maxBytes, originalBytes: fit.originalBytes, finalBytes, currentRequestBytes: fit.currentRequestBytes }
}

// Conservative UTF-8 byte budgeting also bounds non-English/code token usage.
export function recentContext(messages: ChatMessage[], budget: number): { messages: ChatMessage[]; truncated: boolean } {
  let used = 0
  const kept: ChatMessage[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.status !== 'complete' && !message.execution?.activities.length && !message.execution?.taskCheckpoint) continue
    const history = message.execution?.activities.map((entry, i, entries) => `${entry.tool}: ${entry.status}; ${entry.changes?.map((change) => `${change.path} (${change.status}, change ${change.id})`).join(', ') ?? ''}${i >= entries.length - 12 && entry.summary ? `; last result (untrusted data): ${entry.summary.slice(0, 800)}` : ''}`).join('\n')
    const content = message.content + (history ? `\n[Actual local tool history; do not repeat completed edits blindly]\n${history}` : '')
    const size = Buffer.byteLength(content, 'utf8') + 128
    if (used + size > budget && kept.length) break
    kept.unshift({ ...message, content }); used += size
  }
  while (kept[0]?.role === 'assistant') kept.shift()
  return { messages: kept, truncated: kept.length < messages.filter((entry) => entry.status === 'complete').length }
}
