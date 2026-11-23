import type { ReasoningEffort } from './conversations'

export type CapabilityTransport = 'openai-responses' | 'claude-messages' | 'cursor-acp' | 'ollama' | 'unknown'
export type ModelCapability = 'text-input' | 'image-input' | 'file-input' | 'audio-input' | 'video-input' | 'image-generation' | 'video-generation' | 'tool-calling' | 'structured-output' | 'file-creation'

const openAIReasoningEfforts = (id: string): ReasoningEffort[] | undefined => {
  // Match newer/specific families before the broad GPT-5 rule. Otherwise the
  // broad prefix would return early and erase xhigh from 5.2+ variants.
  if (/^gpt-5\.6(?:-|$)/.test(id) || /^gpt-6-(?:astra|sol|luna)(?:-|$)/.test(id) || /^gpt-6\.1-(?:sol|terra)(?:-|$)/.test(id) || /^gpt-6\.2-(?:astra|sol)(?:-|$)/.test(id)) return ['auto', 'low', 'medium', 'high', 'xhigh']
  if (/^gpt-5\.[2345](?:-|$)/.test(id) && !/chat/.test(id)) return /pro/.test(id) ? ['auto', 'medium', 'high', 'xhigh'] : ['auto', 'low', 'medium', 'high', 'xhigh']
  if (/^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(id) && !/chat|pro/.test(id)) return ['auto', 'low', 'medium', 'high']
  return undefined
}

// The Models API lists account access, not reasoning levels. Keep API effort
// support separate from model discovery and update these entries from the
// official model pages. An unknown suffix is not evidence of the base model's
// capabilities. Auto remains available without sending a reasoning value.
const apiEffortsWithNone: ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']
const apiEffortsWithoutNone: ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const documentedOpenAIAPIEfforts: Record<string, ReasoningEffort[]> = {
  'gpt-5.6': apiEffortsWithNone,
  'gpt-5.6-sol': apiEffortsWithNone,
  'gpt-5.6-terra': apiEffortsWithNone,
  'gpt-5.6-luna': apiEffortsWithNone,
  'gpt-6-astra': apiEffortsWithoutNone,
  'gpt-6-sol': apiEffortsWithNone,
  'gpt-6-luna': apiEffortsWithNone,
  'gpt-6.1-sol': apiEffortsWithoutNone,
  'gpt-6.1-terra': apiEffortsWithNone,
  'gpt-6.2-astra': apiEffortsWithoutNone,
  'gpt-6.2-sol': apiEffortsWithoutNone,
}

/** Capabilities from an authenticated provider catalog take precedence over this trusted built-in metadata. */
export function knownReasoningEfforts(provider: string | undefined, model: string | null): ReasoningEffort[] | undefined {
  if (!model) return undefined
  const id = model.toLowerCase()
  if (['openai', 'cloud'].includes((provider ?? '').toLowerCase())) return documentedOpenAIAPIEfforts[id]?.slice()
  if (['subscription', 'chatgpt-subscription', 'codex-subscription'].includes((provider ?? '').toLowerCase())) return openAIReasoningEfforts(id)
  if (['claude-api', 'claude api', 'anthropic-messages'].includes((provider ?? '').toLowerCase())) {
    if (/^claude-(?:fable|mythos)-5-(?:0|1|2)(?:-|$)/.test(id) || /^claude-(?:opus|sonnet|haiku)-5-(?:0|1|2|3|4|5)(?:-|$)/.test(id)) return ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
    if (/^claude-opus-4-(?:7|8)(?:-|$)/.test(id)) return ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
    if (/^claude-(?:opus-4-(?:5|6)|sonnet-4-6)(?:-|$)/.test(id)) return ['auto', 'low', 'medium', 'high', 'max']
  }
  return undefined
}

/** Explicitly advertised empty arrays mean unsupported; undefined means unknown and may use trusted metadata. */
export function resolveReasoningEfforts(provider: string | undefined, model: string | null, ...advertised: Array<ReasoningEffort[] | undefined>): ReasoningEffort[] | undefined {
  return advertised.find((efforts): efforts is ReasoningEffort[] => efforts !== undefined) ?? knownReasoningEfforts(provider, model)
}

export function knownReasoningDefault(provider: string | undefined, model: string | null): ReasoningEffort | undefined {
  if (provider && ['claude-api', 'claude api', 'anthropic-messages'].includes(provider.toLowerCase()) && model) {
    if (/^claude-(?:opus-5-5|haiku-5-5)(?:-|$)/i.test(model)) return 'medium'
    if (knownReasoningEfforts(provider, model)) return 'high'
  }
  return undefined
}

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
  const reasoningEfforts = openAIReasoningEfforts(id)
  if (reasoningEfforts) efforts.splice(0, efforts.length, ...reasoningEfforts)
  return { transport, verified, capabilities, efforts, contextCharacters, reason }
}

export function supportsImageInput(model: string | null, transport: CapabilityTransport): boolean {
  return verifiedModelCapabilities(model, transport).capabilities.has('image-input')
}
