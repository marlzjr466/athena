import type { ReasoningEffort } from './conversations'
import { inferenceModelEfforts, type InferenceModel, type InferenceProtocol } from './thirdPartyInference'

const defaultPath: Partial<Record<InferenceProtocol, string>> = {
  'openai-responses': 'reasoning.effort',
  'openai-chat-completions': 'reasoning_effort',
  'azure-foundry-chat': 'reasoning_effort',
  'anthropic-messages': 'output_config.effort',
  'gemini-native': 'thinkingConfig.thinkingLevel',
}

function allowedPath(protocol: InferenceProtocol, path: string): boolean {
  const roots: Partial<Record<InferenceProtocol, string[]>> = {
    'openai-responses': ['reasoning'],
    'openai-chat-completions': ['reasoning_effort', 'reasoning'],
    'azure-foundry-chat': ['reasoning_effort', 'reasoning'],
    'anthropic-messages': ['output_config'],
    'gemini-native': ['thinkingConfig.thinkingLevel', 'thinkingConfig.thinkingBudget'],
    'bedrock-converse': ['additionalModelRequestFields'],
  }
  return !path.split('.').some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment)) && (protocol === 'anthropic-messages' && path === 'thinking.budget_tokens' || Boolean(roots[protocol]?.some(root => path === root || path.startsWith(`${root}.`))))
}

export function validateInferenceReasoning(protocol: InferenceProtocol, model: InferenceModel): void {
  const caps = { ...model.reportedCapabilities, ...model.configuredCapabilities }
  const levels = inferenceModelEfforts(model)
  if (!caps.reasoning && (caps.reasoningEfforts?.length || caps.reasoningDefault || caps.reasoningParameterPath || caps.reasoningValueMap || caps.reasoningRequired)) throw new Error(`Enable reasoning before configuring effort for ${model.id}.`)
  if (caps.reasoningDefault && caps.reasoningDefault !== 'auto' && !levels?.includes(caps.reasoningDefault)) throw new Error(`The default reasoning level for ${model.id} must be supported.`)
  if (caps.reasoningRequired && (!caps.reasoningDefault || caps.reasoningDefault === 'auto')) throw new Error(`A required reasoning setting for ${model.id} needs a concrete default.`)
  const path = caps.reasoningParameterPath ?? defaultPath[protocol]
  if (caps.reasoning && levels && (!path || !allowedPath(protocol, path) || path === 'additionalModelRequestFields')) throw new Error(`Reasoning parameter path ${path ?? '(unset)'} is unavailable for ${protocol}.`)
  if (caps.thinkingMode && protocol !== 'anthropic-messages') throw new Error('Thinking mode is available only for Anthropic Messages profiles.')
  if (caps.thinkingMode && !caps.reasoning) throw new Error('Enable reasoning before configuring Anthropic thinking mode.')
  if (caps.thinkingMode === 'enabled' && !caps.thinkingBudget) throw new Error('Enabled Anthropic thinking needs a token budget.')
  if (path === 'thinking.budget_tokens' && caps.thinkingMode !== 'enabled') throw new Error('A thinking budget mapping requires enabled Anthropic thinking.')
  if (caps.thinkingBudget && caps.thinkingMode !== 'enabled') throw new Error('A thinking budget requires enabled Anthropic thinking.')
  if (protocol === 'gemini-native' && path?.endsWith('thinkingBudget') && caps.reasoning && caps.reasoningEfforts?.some(effort => effort !== 'auto' && typeof caps.reasoningValueMap?.[effort] !== 'number')) throw new Error('Gemini thinkingBudget needs a numeric value mapping for each supported effort.')
  if (path === 'thinking.budget_tokens' && caps.reasoningEfforts?.some(effort => effort !== 'auto' && typeof caps.reasoningValueMap?.[effort] !== 'number')) throw new Error('Anthropic thinking.budget_tokens needs numeric value mappings.')
  if (caps.reasoningValueMap) for (const effort of Object.keys(caps.reasoningValueMap) as ReasoningEffort[]) if (!levels?.includes(effort)) throw new Error(`Mapped reasoning level ${effort} is not supported by ${model.id}.`)
}

export function inferenceReasoningPayload(protocol: InferenceProtocol, model: InferenceModel | undefined, requested: ReasoningEffort | undefined): Record<string, unknown> {
  if (!model) { if (requested && requested !== 'auto') throw new Error('The selected inference model has no reasoning capability metadata.'); return {} }
  validateInferenceReasoning(protocol, model)
  const caps = { ...model.reportedCapabilities, ...model.configuredCapabilities }
  if (!caps.reasoning) { if (requested && requested !== 'auto') throw new Error('The selected model does not support reasoning effort.'); return {} }
  const result: Record<string, unknown> = {}
  if (protocol === 'anthropic-messages' && caps.thinkingMode) result.thinking = caps.thinkingMode === 'enabled' ? { type: 'enabled', budget_tokens: caps.thinkingBudget } : { type: caps.thinkingMode }
  const effort = requested && requested !== 'auto' ? requested : caps.reasoningDefault
  if (!effort || effort === 'auto') return result
  if (!inferenceModelEfforts(model)?.includes(effort)) throw new Error(`The selected model does not support ${effort} reasoning effort.`)
  const path = caps.reasoningParameterPath ?? defaultPath[protocol]
  if (!path) throw new Error(`Reasoning is not mapped for ${protocol}.`)
  const value = caps.reasoningValueMap?.[effort] ?? (protocol === 'gemini-native' ? effort.toUpperCase() : effort)
  let cursor = result
  const segments = path.split('.')
  for (const segment of segments.slice(0, -1)) { const existing=cursor[segment]; const nested: Record<string, unknown> = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {}; cursor[segment] = nested; cursor = nested }
  cursor[segments[segments.length - 1]] = value
  return result
}
