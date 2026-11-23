import { ATHENA_PERSONALITY, ChatError, type StreamOptions } from './AIProvider'
import { continuationFor } from './continuationController'

export type ContextProtocol = 'chat' | 'responses' | 'anthropic' | 'gemini' | 'bedrock' | 'ollama'
const marker = '[Condensed tool evidence; full result remains in Activity]'
export function protocolTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value, (key, item) =>
    ['data', 'image_url', 'images'].includes(key) && (typeof item === 'string' || Array.isArray(item)) ? '[image]'.repeat(4096) : item) ?? '') / 3) + 32
}
function evidence(text: string): string {
  if (text.length <= 1800 || text.startsWith(marker)) return text
  // Keep structure and short status/path/version/error fields when the tool
  // returns JSON; shorten only large strings/arrays. No synthetic success.
  try {
    const trim = (value: unknown, depth = 0): unknown => {
      if (typeof value === 'string') return value.length > 900 ? `${value.slice(0, 600)}\n[omitted; retrieve from Activity or read the source again]\n${value.slice(-250)}` : value
      if (depth > 10) return '[nested evidence retained in Activity]'
      if (Array.isArray(value)) return value.length > 16 ? [...value.slice(0, 12).map(item => trim(item, depth + 1)), '[additional entries in Activity]', ...value.slice(-3).map(item => trim(item, depth + 1))] : value.map(item => trim(item, depth + 1))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trim(item, depth + 1)]))
      return value
    }
    const reduced = JSON.stringify(trim(JSON.parse(text)))
    if (reduced.length < text.length) return `${marker}\n${reduced}`
  } catch { /* Commands may return plain text. */ }
  return `${marker}\n${text.slice(0, 1100)}\n[omitted; inspect original output before relying on omitted details]\n${text.slice(-500)}`
}

/** Local protocol-preserving compaction at complete batch boundaries only.
 * Original instructions, attachments, tool IDs/arguments, signed thinking and
 * recent results are pinned. Never sends an OpenAI compaction API to gateways. */
export function fitProtocolContext<T>(entries: T[], protocol: ContextProtocol, fixed: unknown, options: StreamOptions, window: number, output: number): boolean {
  const control = continuationFor(options), settings = control.settings
  const used = () => protocolTokens(entries) + protocolTokens(fixed)
  const hard = Math.floor(Math.min(window * (1 - settings.contextSafetyMargin) - output, (options.requestContextBudget ?? Infinity) - output))
  const soft = Math.min(hard, (options.requestContextBudget ?? window) * settings.utilizationThreshold)
  const report = (tokens: number) => {
    control.context(tokens, window)
    if (!options.onPromptBudget) return
    const object = fixed && typeof fixed === 'object' && !Array.isArray(fixed) ? fixed as Record<string, unknown> : undefined
    const definitions = object?.tools ?? object?.definitions ?? object?.toolConfig ?? (Array.isArray(fixed) ? fixed : undefined)
    const tools = definitions ? protocolTokens(definitions) : 0
    const systemTurn = entries.find(item => (item as {role?: string})?.role === 'system') as { content?: string } | undefined
    const instructions = String(object?.system ?? object?.instructions ?? (typeof fixed === 'string' ? fixed : systemTurn?.content ?? ''))
    const base = instructions.startsWith(ATHENA_PERSONALITY) ? ATHENA_PERSONALITY : ''
    const system = base ? protocolTokens(base) : 0
    const projectText = options.context?.projectInstructions
    const project = projectText && (instructions.includes(projectText) || JSON.stringify(entries).includes(JSON.stringify(projectText).slice(1,-1))) ? protocolTokens(projectText) : 0
    const developer = Math.max(0, protocolTokens(instructions) - system - (projectText && instructions.includes(projectText) ? project : 0))
    options.onPromptBudget({ configured: options.modelContextWindow, effective: window, documented: options.runtimeCapacity?.source === 'documented' ? options.runtimeCapacity.contextWindow : undefined,
      safeInput: Math.max(0, hard), prompt: tokens, output, system, developer, project, tools, history: Math.max(0, tokens-system-developer-project-tools),
      reason: options.requestContextBudget !== undefined && hard === options.requestContextBudget-output ? 'Delegated request allocation' :
        options.modelContextWindow === window ? 'Configured conversation cap' : `Integration context window (${options.runtimeCapacity?.source ?? 'adapter policy'})` })
  }
  const before = used()
  report(before)
  if (before <= soft || (!settings.automaticCompaction && before <= hard)) return false
  const replacements = new Map<number, T>()
  // Leave the most recent complete response/results untouched. Never split or
  // remove a tool batch, even if that means an actionable context-size stop.
  for (let index = 0; index < entries.length - 2; index++) {
    const entry = structuredClone(entries[index]) as Record<string, unknown>
    if (protocol === 'responses' && entry.type === 'function_call_output' && typeof entry.output === 'string') entry.output = evidence(entry.output)
    if ((protocol === 'chat' || protocol === 'ollama') && entry.role === 'tool' && typeof entry.content === 'string') entry.content = evidence(entry.content)
    if (protocol === 'anthropic' && Array.isArray(entry.content)) entry.content = entry.content.map(block => block.type === 'tool_result' && typeof block.content === 'string' ? { ...block, content: evidence(block.content) } : block)
    if (protocol === 'gemini' && Array.isArray(entry.parts)) entry.parts = entry.parts.map(part => part.functionResponse && typeof part.functionResponse.response?.output === 'string' ? { ...part, functionResponse: { ...part.functionResponse, response: { ...part.functionResponse.response, output: evidence(part.functionResponse.response.output) } } } : part)
    if (protocol === 'bedrock' && Array.isArray(entry.content)) entry.content = entry.content.map(block => block.toolResult ? { ...block, toolResult: { ...block.toolResult, content: block.toolResult.content.map((part: { text?: string }) => typeof part.text === 'string' ? { ...part, text: evidence(part.text) } : part) } } : block)
    if (JSON.stringify(entries[index]) !== JSON.stringify(entry)) replacements.set(index, entry as T)
  }
  if (replacements.size) {
    control.beginCompaction({ protocol, entries, fixed })
    for (const [index, entry] of replacements) entries[index] = entry
    report(used())
    options.onBudget?.('Conversation context optimized. Older tool results remain available in Activity.')
  }
  if (used() > hard) {
    if (!settings.automaticCompaction) control.beginCompaction({ protocol, entries, fixed })
    throw new ChatError(`The request needs approximately ${used()} input tokens. The safe input limit is ${hard} after reserving ${output} for output in a ${window}-token window. Essential instructions, attachments and recent tool batches were retained. Reduce mandatory inputs or select an integration with a larger verified window.`)
  }
  return replacements.size > 0
}
