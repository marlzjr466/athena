import { ATHENA_PERSONALITY, ATHENA_VOICE_PERSONALITY, ChatError, type AIProvider, type StreamOptions } from './AIProvider'
import type { AIChunk, ChatMessage } from '../../../shared/chat'
import type { LocalAISettings } from '../../../shared/localAI'
import { resolveLlamaWindow, type LlamaValidation } from '../../../shared/llamaLongContext'
import { rememberPromptUsage } from './contextEngineRuntime'
import { ensureLlamaServer, llamaRequestFinished, llamaServerEndpoint } from './llamaServer'
import { CONTINUE_TASK, continuationFor } from './continuationController'
import { fitProtocolContext } from './protocolContext'
import { recoverProviderRequest } from './requestRecovery'

export class LlamaCppProvider implements AIProvider {
  get contextLimits() {
    const window = resolveLlamaWindow(this.settings.contextLength, this.validation)
    return { contextWindow: window.validatedMaximum ?? undefined, runtimeContextWindow: window.allocated || undefined, maxOutputTokens: this.settings.maxOutputTokens, source: window.available ? 'reported' as const : 'fallback' as const }
  }
  get modelId(): string { return this.model }
  get promptHistoryLimitBytes(): number { return Math.max(2048, resolveLlamaWindow(this.settings.contextLength, this.validation).allocated * 2) }
  constructor(private model: string, private settings: LocalAISettings, private validation: LlamaValidation | null) {}
  async testConnection(): Promise<boolean> { return (this.validation?.validatedMaximum ?? 0) >= 32_768 }

  async *streamMessage(history: ChatMessage[], options: StreamOptions = {}): AsyncIterable<AIChunk> {
    if (options.context?.projectTools) throw new ChatError('This long-context model does not run project tools. Choose the original Ollama model for file changes. That model was not modified.')
    const window = resolveLlamaWindow(this.settings.contextLength, this.validation)
    if (!window.available) throw new ChatError('This context length has not passed a llama.cpp retrieval test. Choose a validated profile. The Ollama model is still available and was not modified.')
    const messages = history.map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' as const : 'user' as const, content: entry.content }))
    if (history.some((entry) => entry.attachments?.length)) throw new ChatError('The long-context model has no vision support. Choose the original Ollama model for images.')
    let tracked = false
    const control = continuationFor(options), signal = options.signal ?? new AbortController().signal
    const system = options.voiceOnly ? ATHENA_VOICE_PERSONALITY : ATHENA_PERSONALITY
    let totalInput = 0, totalOutput = 0, estimated = false
    try {
      await ensureLlamaServer(window.allocated, window.factor)
      tracked = true
      const maxTokens = Math.max(1, Math.min(8192, this.settings.maxOutputTokens, Math.floor(Math.min(window.allocated, options.modelContextWindow ?? Infinity) / 2)))
      for (;;) {
        signal.throwIfAborted()
        fitProtocolContext(messages, 'chat', system, options, Math.min(window.allocated, options.modelContextWindow ?? window.allocated), maxTokens)
        const response = await recoverProviderRequest(options, signal, () => fetch(`${llamaServerEndpoint()}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.model, temperature: this.settings.temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
            messages: [{ role: 'system', content: system }, ...messages],
          }),
          signal,
        }))
        if (!response.ok || !response.body) throw new ChatError('llama.cpp rejected the request. The Ollama model was not modified.')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        let promptTokens: number | null = null
        let outputTokens = 0
        let finishReason: string | null = null, textOutput = ''
        try {
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
              let event: { choices?: Array<{ delta?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } }
              try { event = JSON.parse(data) } catch { throw new ChatError('llama.cpp returned malformed stream data. The partial response is saved; no tool operation was executed.') }
              if (event.error?.message) throw new ChatError(event.error.message)
              const text = event.choices?.[0]?.delta?.content
              if (event.choices?.[0]?.delta?.tool_calls?.length) throw new ChatError('This text-only llama.cpp model returned an unsupported tool call. No tool was executed.')
              if (text) { textOutput += text; yield { type: 'text', text } }
              if (event.choices?.[0]?.finish_reason) finishReason = event.choices[0].finish_reason
              if (typeof event.usage?.prompt_tokens === 'number') promptTokens = event.usage.prompt_tokens
              if (typeof event.usage?.completion_tokens === 'number') outputTokens = event.usage.completion_tokens
            }
          }
        } catch (error) { options.onModelRequestUnresolved?.(); throw error }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        if (promptTokens != null) rememberPromptUsage({ model: this.model, promptTokens, outputTokens, contextWindow: window.allocated, reservedOutputTokens: maxTokens, systemTokens: null, historyTokens: null, at: new Date().toISOString() })
        options.onModelResponse?.({ inputTokens: promptTokens ?? 0, outputTokens, estimated: promptTokens == null })
        totalInput += promptTokens ?? 0; totalOutput += outputTokens; estimated ||= promptTokens == null
        options.onUsage?.({ inputTokens: totalInput, outputTokens: totalOutput, totalTokens: totalInput + totalOutput, contextTokens: promptTokens ?? 0, contextWindow: window.allocated, remainingTokens: Math.max(0, window.allocated - (promptTokens ?? 0) - maxTokens), toolTokens: 0, estimated, contextEstimated: promptTokens == null, modelLimitsVerified: true, estimatedCostUsd: 0, compactions: control.state.compactions, status: 'ready', show: options.contextSettings?.showUsage !== false })
        if (finishReason === 'length') {
          control.continue('max-output-tokens', textOutput)
          if (textOutput) messages.push({ role: 'assistant', content: textOutput })
          messages.push({ role: 'user', content: CONTINUE_TASK })
          continue
        }
        if (finishReason !== 'stop') throw new ChatError(finishReason ? 'llama.cpp stopped without completing the response. Review the partial answer before resuming.' : 'llama.cpp disconnected before its final completion event. The partial answer is preserved; resume explicitly.')
        yield { type: 'done' }
        return
      }
    } finally { if (tracked) llamaRequestFinished() }
  }
}
