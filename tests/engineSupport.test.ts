// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { describeLocalEngines, longContextModelNote } from '../shared/engineSupport'
import { parseTokenCount } from '../electron/main/ai/ggufTokenCount'

describe('local engine investigation', () => {
  it('does not treat installed engines or GGUF metadata as 128K or 250K support', () => {
    const findings = describeLocalEngines({
      ollamaVersion: '0.40.13', ollamaConnected: true, modelName: 'qwen2.5-coder:3b', modelHasYarn: false, yarnFactor: null, trainedTokens: 32_768,
      llamaVersion: '0.6.0', llamaYarnFlag: true, vllmInstalled: false,
    })
    const text = JSON.stringify(findings)
    expect(text).toContain('0.40.13')
    expect(text).toContain('does not enable YaRN')
    expect(text).toContain('A flag by itself is not a passing test')
    expect(text).not.toContain('128K is supported')
    expect(text).not.toContain('250K is supported')
    expect(findings.map((finding) => finding.engine)).toEqual(['Ollama', 'llama.cpp', 'MLX', 'vLLM'])
    expect(longContextModelNote('qwen2.5-coder:3b')).toContain('was not copied or modified')
    expect(longContextModelNote('qwen2.5-coder:3b')).toContain('llama.cpp:qwen2.5-coder-3b')
    expect(longContextModelNote('llama.cpp:qwen2.5-coder-3b')).toContain('does not copy, overwrite, or modify')
  })
})

describe('GGUF token count parsing', () => {
  it('reads the tokenizer total and ignores token lines', () => {
    expect(parseTokenCount(" 14990 -> 'hello'\nTotal number of tokens: 1\n")).toBe(1)
    expect(parseTokenCount('no count')).toBeNull()
  })
})
