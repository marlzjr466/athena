// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { OllamaProvider } from '../electron/main/ai/OllamaProvider'
import { defaultSettings } from '../shared/settings'

it.skipIf(process.env.ATHENA_OLLAMA_INTEGRATION !== '1')('streams a complete answer from an installed local model without online fallback', async () => {
  const service = new OllamaService(() => defaultSettings.localAI.endpoint)
  const model = await service.modelDetails(process.env.ATHENA_OLLAMA_MODEL ?? 'qwen2.5:3b')
  expect(model.capabilities).toContain('completion')
  const provider = new OllamaProvider(service, model.name, {
    ...defaultSettings.localAI,
    model: model.name,
    maxOutputTokens: 64,
  }, model)
  const chunks = []
  for await (const chunk of provider.streamMessage([{
    id: 'local-live', role: 'user', content: 'Reply with one short sentence confirming that you can answer.',
    createdAt: Date.now(), status: 'complete',
  }], { signal: AbortSignal.timeout(90_000) })) chunks.push(chunk)
  expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text.trim().length > 0)).toBe(true)
  expect(chunks.at(-1)).toEqual({ type: 'done' })
}, 90_000)

it.skipIf(process.env.ATHENA_OLLAMA_INTEGRATION !== '1')('executes a real Ollama function call through Athena tool validation', async () => {
  const service = new OllamaService(() => defaultSettings.localAI.endpoint)
  const model = await service.modelDetails(process.env.ATHENA_OLLAMA_MODEL ?? 'gpt-oss:20b')
  const execute = vi.fn(async () => JSON.stringify({ value: 42 }))
  const provider = new OllamaProvider(service, model.name, { ...defaultSettings.localAI, model: model.name }, model)
  const chunks = []
  for await (const chunk of provider.streamMessage([{ id: 'test', role: 'user', content: 'Call get_test_value now. Use its result to report the number. Do not guess.', createdAt: Date.now(), status: 'complete' }], {
    signal: AbortSignal.timeout(90_000),
    context: { attachments: [], repositoryText: '', sources: [], projectTools: {
      definitions: [{ name: 'get_test_value', description: 'Returns the actual test number. Call this before reporting it.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      assertAccess: () => {}, execute,
    } },
  })) chunks.push(chunk)
  if (!execute.mock.calls.length) throw new Error(`Model did not call the tool: ${JSON.stringify(chunks)}`)
  expect(execute).toHaveBeenCalledOnce()
  expect(chunks.map((chunk) => chunk.type === 'text' ? chunk.text : '').join('')).toContain('42')
  expect(chunks.at(-1)).toEqual({ type: 'done' })
}, 90_000)
