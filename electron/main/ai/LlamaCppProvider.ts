import { ATHENA_PERSONALITY, ATHENA_VOICE_PERSONALITY, ChatError, type AIProvider, type StreamOptions } from './AIProvider'
import type { AIChunk, ChatMessage } from '../../../shared/chat'
import type { LocalAISettings } from '../../../shared/localAI'
import { resolveLlamaWindow, type LlamaValidation } from '../../../shared/llamaLongContext'
import { rememberPromptUsage } from './contextEngineRuntime'
import { ensureLlamaServer, llamaRequestFinished, llamaServerEndpoint } from './llamaServer'

export class LlamaCppProvider implements AIProvider {
  get modelId(): string { return this.model }
  constructor(private model: string, private settings: LocalAISettings, private validation: LlamaValidation | null) {}
  async testConnection(): Promise<boolean> { return (this.validation?.validatedMaximum ?? 0) >= 32_768 }

  async *streamMessage(history: ChatMessage[], options: StreamOptions = {}): AsyncIterable<AIChunk> {
    if (options.context?.projectTools) throw new ChatError('This long-context model does not run project tools. Choose the original Ollama model for file changes. That model was not modified.')
    const window = resolveLlamaWindow(this.settings.contextLength, this.validation)
    if (!window.available) throw new ChatError('This context length has not passed a llama.cpp retrieval test. Choose a validated profile. The Ollama model is still available and was not modified.')
    const messages = history.map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' as const : 'user' as const, content: entry.content }))
    if (history.some((entry) => entry.attachments?.length)) throw new ChatError('The long-context model has no vision support. Choose the original Ollama model for images.')
    let tracked = false
    try {
      await ensureLlamaServer(window.allocated, window.factor)
      tracked = true
      const maxTokens = Math.max(1, Math.min(8192, this.settings.maxOutputTokens, Math.max(1, window.allocated - 256)))
      const response = await fetch(`${llamaServerEndpoint()}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model, temperature: this.settings.temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
          messages: [{ role: 'system', content: options.voiceOnly ? ATHENA_VOICE_PERSONALITY : ATHENA_PERSONALITY }, ...messages],
        }),
        signal: options.signal,
      })
      if (!response.ok || !response.body) throw new ChatError('llama.cpp rejected the request. The Ollama model was not modified.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let promptTokens: number | null = null
      let outputTokens = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        let newline = pending.indexOf('\n')
        while (newline >= 0) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          newline = pending.indexOf('\n')
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          let event: { choices?: Array<{ delta?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } }
          try { event = JSON.parse(data) } catch { continue }
          if (event.error?.message) throw new ChatError(event.error.message)
          const text = event.choices?.[0]?.delta?.content
          if (text) yield { type: 'text', text }
          if (typeof event.usage?.prompt_tokens === 'number') promptTokens = event.usage.prompt_tokens
          if (typeof event.usage?.completion_tokens === 'number') outputTokens = event.usage.completion_tokens
        }
      }
      if (promptTokens != null) rememberPromptUsage({ model: this.model, promptTokens, outputTokens, contextWindow: window.allocated, reservedOutputTokens: maxTokens, systemTokens: null, historyTokens: null, at: new Date().toISOString() })
      options.onModelResponse?.({ inputTokens: promptTokens ?? 0, outputTokens, estimated: promptTokens == null })
      options.onUsage?.({ inputTokens: promptTokens ?? 0, outputTokens, totalTokens: (promptTokens ?? 0) + outputTokens, contextTokens: promptTokens ?? 0, contextWindow: window.allocated, remainingTokens: Math.max(0, window.allocated - (promptTokens ?? 0) - maxTokens), toolTokens: 0, estimated: promptTokens == null, contextEstimated: promptTokens == null, modelLimitsVerified: true, estimatedCostUsd: 0, compactions: 0, status: 'ready', show: options.contextSettings?.showUsage !== false })
      yield { type: 'done' }
    } finally { if (tracked) llamaRequestFinished() }
  }
}
