import type { ReasoningEffort } from './conversations'

export type CapabilityTransport = 'openai-responses' | 'claude-messages' | 'cursor-acp' | 'ollama' | 'unknown'
export type ModelCapability = 'text-input' | 'image-input' | 'file-input' | 'audio-input' | 'video-input' | 'image-generation' | 'video-generation' | 'tool-calling' | 'structured-output' | 'file-creation'

export interface VerifiedModelCapabilities {
  transport: CapabilityTransport
  verified: boolean
  capabilities: Set<ModelCapability>
  efforts: ReasoningEffort[]
  contextCharacters: number
  reason?: string
}

/**
 * Returns capabilities for the complete provider path. Model names alone are
 * not enough evidence: the adapter must be able to carry the content too.
 * Cursor's ACP prompt accepts image content blocks, and Cursor documents image
 * reading for vision-capable models. Grok variants are therefore enabled only
 * on the ACP transport and only for the exact Grok 4.6/4.7 family.
 */
export function verifiedModelCapabilities(model: string | null, transport: CapabilityTransport = 'unknown'): VerifiedModelCapabilities {
  const id = model ?? ''
  const efforts: ReasoningEffort[] = ['auto']
  const capabilities = new Set<ModelCapability>(['text-input'])
  let contextCharacters = 20_000
  let verified = false
  let reason: string | undefined
  if (transport === 'cursor-acp') {
    verified = true
    if (/^(?:cursor-)?grok-4\.(?:6|7)(?:-|\[|$)/i.test(id)) {
      capabilities.add('image-input')
      capabilities.add('file-input')
      capabilities.add('tool-calling')
      contextCharacters = 100_000
    } else {
      reason = 'Cursor ACP image input is available only when the selected model advertises vision support. This model family has not been verified by Athena.'
    }
  } else if (/^(?:gpt-4o|gpt-4\.1|gpt-5|gpt-6(?:\.1-sol|-astra|-sol)|o3(?:-|$)|o4)/.test(id) && !/audio|transcribe|tts/.test(id)) {
    capabilities.add('image-input'); capabilities.add('file-input'); capabilities.add('tool-calling'); verified = true; contextCharacters = 100_000
  }
  if (/^(?:gpt-5|gpt-6)/.test(id)) efforts.push('low', 'medium', 'high', 'xhigh')
  return { transport, verified, capabilities, efforts, contextCharacters, reason }
}

export function supportsImageInput(model: string | null, transport: CapabilityTransport): boolean {
  return verifiedModelCapabilities(model, transport).capabilities.has('image-input')
}
