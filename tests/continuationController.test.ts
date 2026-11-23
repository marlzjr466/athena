// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContinuationController } from '../electron/main/ai/continuationController'
import { ToolCallSession } from '../electron/main/ai/toolCallSession'
import { fitProtocolContext } from '../electron/main/ai/protocolContext'
import { contextDefaults } from '../shared/context'
import { taskControlStateSchema } from '../shared/generation'

describe('shared continuation accounting and durable replay protection', () => {
  it('keeps productive tool rounds and compactions separate from model continuations', () => {
    const controller = new ContinuationController({ maxContinuations: 1 })
    for (let step = 0; step < 24; step++) {
      const key = controller.operationStarted('run_tests', { step }, false)
      controller.operationFinished(key, JSON.stringify({ ok: true, passed: step + 1 }))
      controller.batch(); controller.beginCompaction({ step }); controller.context(500, 16000)
    }
    expect(controller.state).toMatchObject({ continuations: 0, compactions: 24, toolRounds: 24, toolCalls: 24 })
    controller.continue('length', 'unfinished text')
    expect(() => controller.continue('length', 'another')).toThrow('1/1')
  })
  it('bounds repeated incomplete responses and compaction without progress', () => {
    const controller = new ContinuationController({ maxContinuations: 32 })
    controller.continue('length', 'same'); controller.continue('length', 'same')
    expect(() => controller.continue('length', 'same')).toThrow('three times')
    const compactor = new ContinuationController()
    compactor.beginCompaction('same')
    expect(() => compactor.beginCompaction('same')).toThrow('without reducing')
  })
  it('preserves explicit opt-outs while successful tool work remains possible', () => {
    const controller = new ContinuationController({ automaticContinuation: false, automaticCompaction: false })
    const key = controller.operationStarted('read_file', {}, true); controller.operationFinished(key, 'file')
    expect(controller.state.toolCalls).toBe(1)
    expect(() => controller.continue('length', 'partial')).toThrow('allowance')
    expect(() => controller.beginCompaction('large')).toThrow('disabled')
  })
  it('allows a repeated test with changed evidence and stops unchanged failures', () => {
    const controller = new ContinuationController({ noProgressWindow: 6 })
    for (let i = 0; i < 15; i++) {
      const key = controller.operationStarted('run_tests', {}, false)
      controller.operationFinished(key, JSON.stringify({ ok: true, revision: i }))
    }
    expect(() => {
      for (let i = 0; i < 6; i++) { const key = controller.operationStarted('run_tests', {}, false); controller.operationFinished(key, '{"ok":false}') }
    }).toThrow('no operation was retried')
  })
  it('persists a receipt before a real fixture write, then blocks replay after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-task-recovery-'))
    try {
      const checkpoint = join(root, 'checkpoint.json'), file = join(root, 'fixture.txt')
      const controller = new ContinuationController({}, state => writeFileSync(checkpoint, JSON.stringify(state)))
      const execute = vi.fn(async () => {
        expect(JSON.parse(readFileSync(checkpoint, 'utf8')).operations.at(-1).status).toBe('started')
        writeFileSync(file, 'verified fixture mutation'); return '{"ok":true}'
      })
      const tools = { definitions: [{ name: 'edit_file', description: '', parameters: {} }], assertAccess: vi.fn(), execute }
      const call = { type: 'function_call' as const, call_id: 'one', name: 'edit_file', arguments: '{"path":"fixture.txt"}', status: 'completed' as const }
      await new ToolCallSession(tools, new AbortController().signal, 20, controller).executeBatch([call], 8000)
      expect(readFileSync(file, 'utf8')).toBe('verified fixture mutation')
      const restored = new ContinuationController({}, undefined, taskControlStateSchema.parse(JSON.parse(readFileSync(checkpoint, 'utf8'))))
      const result = await new ToolCallSession(tools, new AbortController().signal, 20, restored).executeBatch([{ ...call, call_id: 'two' }], 8000)
      expect(result[0]).toContain('uncertain_replay'); expect(execute).toHaveBeenCalledTimes(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each(['chat', 'responses', 'anthropic', 'gemini', 'bedrock', 'ollama'] as const)('compacts %s without losing call IDs, pinned instructions or recent evidence', protocol => {
    const long = JSON.stringify({ ok: true, path: 'src/important.ts', output: 'large log '.repeat(7000) })
    const entries: Record<string, unknown>[] = protocol === 'responses' ? [{ type: 'function_call_output', call_id: 'abc', output: long }]
      : protocol === 'anthropic' ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abc', content: long }] }]
      : protocol === 'gemini' ? [{ role: 'user', parts: [{ functionResponse: { id: 'abc', response: { output: long } } }] }]
      : protocol === 'bedrock' ? [{ role: 'user', content: [{ toolResult: { toolUseId: 'abc', content: [{ text: long }] } }] }]
      : [{ role: 'tool', tool_call_id: 'abc', content: long }]
    entries.push({ role: 'user', content: '/platform-dev MBM-11825: preserve existing work' }, { role: 'assistant', content: 'next pending step' })
    const tail = structuredClone(entries.slice(-2)), controller = new ContinuationController()
    fitProtocolContext(entries, protocol, { system: 'Permission boundaries remain enforced' }, { continuation: controller }, 16000, 2000)
    expect(JSON.stringify(entries)).toContain('abc'); expect(JSON.stringify(entries)).toContain('src/important.ts')
    expect(entries.slice(-2)).toEqual(tail); expect(controller.state.continuations).toBe(0)
    expect(controller.state.compactions).toBe(1)
  })
  it('refuses to silently discard an oversized attachment or instruction', () => {
    const entries = [{ role: 'user', content: 'essential '.repeat(20000) }]
    const saved = JSON.stringify(entries)
    expect(() => fitProtocolContext(entries, 'chat', {}, { contextSettings: contextDefaults() }, 8000, 1000)).toThrow('Essential instructions')
    expect(JSON.stringify(entries)).toBe(saved)
  })
})
