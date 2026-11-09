// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveLlamaWindow, type LlamaValidation } from '../shared/llamaLongContext'

const validation = (passed: number[]): LlamaValidation => ({
  runtime: { executable: '/opt/homebrew/bin/llama-server', version: '0.6.0' },
  model: { id: 'llama.cpp:qwen2.5-coder-3b', gguf: '/tmp/model.gguf', family: 'qwen2', quantization: 'Q4_K_M', trainedContext: 32768, ollamaModelPreserved: 'qwen2.5-coder:3b' },
  checkedAt: '2026-11-07T00:00:00.000Z',
  levels: [
    { id: 'standard', requestedTokens: 32768, yarnFactor: null, loaded: true, passed: passed.includes(32768) },
    { id: 'extended', requestedTokens: 65536, yarnFactor: 2, loaded: true, passed: passed.includes(65536) },
    { id: 'long', requestedTokens: 131072, yarnFactor: 4, loaded: false, passed: passed.includes(131072) },
  ],
  validatedMaximum: Math.max(0, ...passed),
  limitations: [],
})

describe('llama.cpp validated windows', () => {
  it('uses a passed window and keeps a larger profile unavailable', () => {
    expect(resolveLlamaWindow(65536, validation([32768, 65536]))).toMatchObject({ allocated: 65536, factor: 2, available: true })
    expect(resolveLlamaWindow(131072, validation([32768, 65536]))).toMatchObject({ allocated: 65536, factor: 2, available: false, validatedMaximum: 65536 })
  })

  it('does not allocate a long window when nothing has passed retrieval', () => {
    expect(resolveLlamaWindow(32768, validation([]))).toMatchObject({ allocated: 0, available: false, validatedMaximum: 0 })
  })
})
