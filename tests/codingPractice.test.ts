// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CodingPracticeRunner, codingChallenges } from '../electron/main/ai/codingPractice'
import { codingChallengeDescriptions, codingChallengeIds } from '../shared/academyStudio'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('isolated Academy coding practice', () => {
  it('keeps every displayed exercise aligned with real test cases', () => {
    for (const id of codingChallengeIds) {
      expect(codingChallengeDescriptions[id].prompt).toContain('solve')
      expect(codingChallenges[id].length).toBeGreaterThan(1)
    }
  })
  it.runIf(process.platform === 'darwin')('runs user code in the probed macOS sandbox and reports test evidence', async () => {
    const result = await new CodingPracticeRunner().run('qwen2.5:3b', 'sum-pairs', 'function solve(numbers) { return numbers.filter(n => n % 2 === 0).reduce((a, b) => a + b, 0) }', new AbortController().signal)
    expect(result).toMatchObject({ challenge: 'sum-pairs', passed: 3, total: 3 })
    expect(result.results.every(item => item.passed)).toBe(true)
  })
  it.runIf(process.platform === 'darwin')('runs independently imported JSON unit cases in the same isolated sandbox', async () => {
    const results = await new CodingPracticeRunner().runCases('function solve(a, b) { return a + b }', [
      { name: 'positive', args: [1, 2], expected: 3 },
      { name: 'negative', args: [-2, 1], expected: 0 },
    ], new AbortController().signal)
    expect(results).toMatchObject([{ name: 'positive', passed: true }, { name: 'negative', passed: false }])
  })
  it.runIf(process.platform === 'darwin')('passes both ordinary-array and empty-array summation cases', async () => {
    const results = await new CodingPracticeRunner().runCases('function solve(values) { return values.reduce((sum, value) => sum + value, 0) }', [
      { name: 'sum', args: [[2, 3]], expected: 5 },
      { name: 'empty sum', args: [[]], expected: 0 },
    ], new AbortController().signal)
    expect(results).toMatchObject([
      { name: 'sum', passed: true, detail: '5' },
      { name: 'empty sum', passed: true, detail: '0' },
    ])
  })
  it.runIf(process.platform === 'darwin')('bounds infinite loops rather than leaving a running child', async () => {
    await expect(new CodingPracticeRunner().run('qwen2.5:3b', 'sum-pairs', 'function solve() { while (true) {} }', new AbortController().signal)).rejects.toThrow(/3-second limit/)
  }, 10_000)
  it.runIf(process.platform === 'darwin')('cannot read or overwrite a file outside its sandbox scratch directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athena-practice-boundary-'))
    const protectedFile = join(directory, 'outside.txt')
    try {
      await writeFile(protectedFile, 'private test fixture')
      const code = `function solve() { const fs = process.mainModule.require('node:fs'); fs.writeFileSync(${JSON.stringify(protectedFile)}, 'changed'); return fs.readFileSync(${JSON.stringify(protectedFile)}, 'utf8') }`
      const result = await new CodingPracticeRunner().run('qwen2.5:3b', 'sum-pairs', code, new AbortController().signal)
      expect(result.passed).toBe(0)
      expect(await readFile(protectedFile, 'utf8')).toBe('private test fixture')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
