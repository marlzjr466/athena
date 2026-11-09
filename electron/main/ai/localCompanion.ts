import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '../../../shared/settings'
import type { ConversationConfig } from '../../../shared/conversations'
import { localChatCompatibility, type LocalModel } from '../../../shared/localAI'
import { isLlamaValidation, llamaLongMetadata, llamaLongModelId, type LlamaValidation } from '../../../shared/llamaLongContext'
import { ChatError, type AIProvider } from './AIProvider'
import { LlamaCppProvider } from './LlamaCppProvider'
import { MLXProvider } from './MLXProvider'
import { OllamaProvider, validateIsolatedLocalEffort } from './OllamaProvider'
import type { OllamaService } from './ollamaService'

export function readLlamaValidation(userData?: string | null): LlamaValidation | null {
  if (!userData) return null
  try {
    const value = JSON.parse(readFileSync(join(userData, 'llama-context-validation.json'), 'utf8'))
    return isLlamaValidation(value) ? value : null
  } catch { return null }
}

/** This factory has no cloud provider or credential resolver to fall back to. */
export function localCompanionProvider(service: OllamaService, settings: Settings, config: ConversationConfig,
  isolated = false, ready?: (model: LocalModel) => void, instructions?: (model: string) => string | ((request: string, projectAvailable: boolean) => string), userData?: string | null): Promise<AIProvider> {
  const local = structuredClone(settings.localAI)
  const model = isolated ? config.model : local.model
  if (!model) return Promise.reject(new ChatError('Choose an installed local model for Athena before starting a companion conversation.'))
  if (!isolated && config.model && config.model !== model) return Promise.reject(new ChatError('This companion conversation belongs to a different local model. Select that model or start a new companion conversation.'))
  if (model === llamaLongModelId) {
    const metadata = llamaLongMetadata()
    ready?.(metadata)
    return Promise.resolve(new LlamaCppProvider(model, local, readLlamaValidation(userData)))
  }
  return service.modelDetails(model).then(metadata => {
    if (localChatCompatibility(metadata) === 'unsupported') throw new ChatError('This installed Ollama model does not advertise chat completion. Choose a chat-capable model in My Athena → Local AI setup.')
    if (isolated) {
      if (!metadata.capabilities.includes('tools')) throw new ChatError('This local model has no verified tool-calling support for sub-agents.')
      validateIsolatedLocalEffort(metadata, config.effort)
    }
    ready?.(metadata)
    const Provider = metadata.provider === 'mlx' ? MLXProvider : OllamaProvider
    return new Provider(service, model, isolated ? { ...local, reasoning: config.effort, maxOutputTokens: Math.min(local.maxOutputTokens, 4096) } : local, metadata, instructions?.(model))
  })
}

/** Dedicated Athena Chat sessions choose their own installed model. No online fallback. */
export function localChatProvider(service: OllamaService, settings: Settings, config: ConversationConfig,
  isolated = false, ready?: (model: LocalModel) => void, instructions?: (model: string) => string | ((request: string, projectAvailable: boolean) => string), userData?: string | null): Promise<AIProvider> {
  const model = config.model
  if (!model) return Promise.reject(new ChatError('Choose an installed local model for this Athena Chat conversation.'))
  const local = structuredClone(settings.localAI)
  if (model === llamaLongModelId) {
    const metadata = llamaLongMetadata()
    ready?.(metadata)
    return Promise.resolve(new LlamaCppProvider(model, local, readLlamaValidation(userData)))
  }
  return service.modelDetails(model).then(metadata => {
    if (localChatCompatibility(metadata) === 'unsupported') throw new ChatError('This installed Ollama model does not advertise chat completion. Choose a chat-capable local model.')
    if (isolated) {
      if (!metadata.capabilities.includes('tools')) throw new ChatError('This local model has no verified tool-calling support for sub-agents.')
      validateIsolatedLocalEffort(metadata, config.effort)
    }
    ready?.(metadata)
    const Provider = metadata.provider === 'mlx' ? MLXProvider : OllamaProvider
    return new Provider(service, model, isolated ? { ...local, reasoning: config.effort, maxOutputTokens: Math.min(local.maxOutputTokens, 4096) } : local, metadata, instructions?.(model))
  })
}

/** Local inference must never obtain an OpenAI search client via context setup. */
export function localCompanionSettings(settings: Settings): Settings {
  return { ...settings, aiMode: 'local', webAccess: {
    ...settings.webAccess,
    webSearchEnabled: settings.automationPermissions.browserAccess && settings.webAccess.webSearchEnabled,
    automaticSearch: settings.automationPermissions.browserAccess && settings.webAccess.automaticSearch && settings.webAccess.searchProvider !== 'openai-built-in',
  } }
}
