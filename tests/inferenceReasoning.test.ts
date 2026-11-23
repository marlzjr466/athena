import { describe, expect, it } from 'vitest'
import { inferenceReasoningPayload, validateInferenceReasoning } from '../shared/inferenceReasoning'
import { inferenceModelEfforts, type InferenceModel } from '../shared/thirdPartyInference'

const configured = (capabilities: NonNullable<InferenceModel['configuredCapabilities']>): InferenceModel => ({ id: 'reasoning-model', enabled: true, source: 'manual', configuredCapabilities: { reasoning: true, reasoningEfforts: ['low', 'high'], ...capabilities } })

describe('third-party model reasoning contract', () => {
  it('omits unsupported capabilities and rejects a stale explicit effort', () => {
    const model: InferenceModel = { id: 'plain-model', enabled: true, source: 'manual' }
    expect(inferenceModelEfforts(model)).toBeUndefined()
    expect(inferenceReasoningPayload('openai-chat-completions', model, 'auto')).toEqual({})
    expect(() => inferenceReasoningPayload('openai-chat-completions', model, 'high')).toThrow('does not support')
  })

  it('maps Responses and Chat Completions to different request fields', () => {
    const model = configured({ reasoningEfforts: ['none', 'minimal', 'high', 'max'], reasoningDefault: 'minimal' })
    expect(inferenceModelEfforts(model)).toEqual(['auto', 'none', 'minimal', 'high', 'max'])
    expect(inferenceReasoningPayload('openai-responses', model, 'auto')).toEqual({ reasoning: { effort: 'minimal' } })
    expect(inferenceReasoningPayload('openai-chat-completions', model, 'max')).toEqual({ reasoning_effort: 'max' })
    expect(() => inferenceReasoningPayload('openai-responses', model, 'low')).toThrow('does not support')
  })

  it('keeps Anthropic thinking mode separate from output effort', () => {
    const model = configured({ thinkingMode: 'adaptive' })
    expect(inferenceReasoningPayload('anthropic-messages', model, 'high')).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
    expect(inferenceReasoningPayload('anthropic-messages', model, 'auto')).toEqual({ thinking: { type: 'adaptive' } })
    expect(inferenceReasoningPayload('anthropic-messages', configured({ thinkingMode: 'enabled', thinkingBudget: 2048 }), 'low')).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 }, output_config: { effort: 'low' } })
  })

  it('supports Gemini level and numeric budget mappings', () => {
    expect(inferenceReasoningPayload('gemini-native', configured({}), 'high')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH' } })
    const budget = configured({ reasoningParameterPath: 'thinkingConfig.thinkingBudget', reasoningValueMap: { low: 1024, high: 8192 } })
    expect(inferenceReasoningPayload('gemini-native', budget, 'high')).toEqual({ thinkingConfig: { thinkingBudget: 8192 } })
  })

  it('maps only explicitly configured Bedrock model fields', () => {
    const model=configured({ reasoningParameterPath:'additionalModelRequestFields.output_config.effort' })
    expect(inferenceReasoningPayload('bedrock-converse',model,'high')).toEqual({additionalModelRequestFields:{output_config:{effort:'high'}}})
    expect(() => validateInferenceReasoning('bedrock-converse',configured({}))).toThrow('unavailable')
  })

  it('validates custom paths, defaults, and required settings', () => {
    expect(() => validateInferenceReasoning('openai-chat-completions', configured({ reasoningParameterPath: 'model' }))).toThrow('unavailable')
    expect(() => validateInferenceReasoning('openai-responses', configured({ reasoningParameterPath: 'reasoning.__proto__.effort' }))).toThrow('unavailable')
    expect(() => validateInferenceReasoning('gemini-native', configured({ reasoningParameterPath: 'thinkingConfig.thinkingBudget' }))).toThrow('numeric')
    expect(() => validateInferenceReasoning('anthropic-messages', configured({ reasoningRequired: true }))).toThrow('concrete default')
    expect(() => validateInferenceReasoning('anthropic-messages', configured({ thinkingMode: 'enabled' }))).toThrow('token budget')
  })
})
