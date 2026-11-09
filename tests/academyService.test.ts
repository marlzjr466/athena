// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { academyCommandSchema, academyComparison } from '../shared/academy'
import { AcademyService } from '../electron/main/ai/academyService'
import { OllamaProvider } from '../electron/main/ai/OllamaProvider'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { defaultSettings } from '../shared/settings'
import type { LocalModel } from '../shared/localAI'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'athena-academy-test-')); directories.push(path); return path }
const alpha: LocalModel = { name: 'qwen2.5:3b', size: 1, capabilities: ['completion'], digest: 'digest-a', family: 'qwen2', quantization: 'Q4_K_M' }
const beta: LocalModel = { ...alpha, name: 'qwen2.5-coder:3b', digest: 'digest-b' }
const service = (path: string, call: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Response> = async () => new Response(JSON.stringify({ message: { content: '42' } }))) => new AcademyService(path, { call, modelDetails: vi.fn() } as unknown as OllamaService)

describe('model-specific Athena Academy', () => {
  it('keeps instructions, modules and model identity separate across restarts', async () => {
    const path = await directory(), academy = service(path)
    academy.setInstructions(alpha, 'Prefer short answers.')
    academy.setModule(alpha, 'coding-foundations', true, true)
    academy.profile(beta)
    expect(academy.instructionsFor(alpha.name)).toContain('Prefer short answers.')
    expect(academy.instructionsFor(alpha.name)).toContain('inspect the authorized repository')
    expect(academy.instructionsFor(beta.name)).toBe('')
    const reloaded = service(path)
    expect(reloaded.profile(alpha)).toMatchObject({ digest: 'digest-a', quantization: 'Q4_K_M', modules: [{ id: 'coding-foundations', enabled: true }] })
    expect(reloaded.profile(beta).modules).toEqual([])
    reloaded.setModule(alpha, 'coding-foundations', true, false)
    expect(reloaded.profile(alpha).modules[0].enabled).toBe(false)
    expect(reloaded.profile(beta).modules).toEqual([])
  })
  it('stores approved sources privately, shares only by explicit link, and removes only Academy copies', async () => {
    const path = await directory(), original = join(path, 'original.md'), academy = service(join(path, 'profile'))
    await writeFile(original, '# Private notes')
    const source = await academy.addSource(original)
    expect(await readFile(join(path, 'profile', 'knowledge', source.id), 'utf8')).toBe('# Private notes')
    academy.linkSource(alpha, source.id, true)
    expect(academy.profile(alpha).knowledgeIds).toEqual([source.id])
    expect(academy.profile(beta).knowledgeIds).toEqual([])
    academy.linkSource(beta, source.id, true)
    await academy.removeSource(source.id)
    expect(academy.profile(alpha).knowledgeIds).toEqual([])
    expect(academy.profile(beta).knowledgeIds).toEqual([])
    expect(await readFile(original, 'utf8')).toBe('# Private notes')
  })
  it('rejects unsupported, empty and oversized sources', async () => {
    const path = await directory(), academy = service(join(path, 'profile'))
    const bad = join(path, 'bad.pdf'), empty = join(path, 'empty.txt'), huge = join(path, 'huge.md')
    await writeFile(bad, 'data'); await writeFile(empty, ''); await writeFile(huge, Buffer.alloc(10 * 1024 * 1024 + 1))
    await expect(academy.addSource(bad)).rejects.toThrow('Only plain text')
    await expect(academy.addSource(empty)).rejects.toThrow('between 1 byte')
    await expect(academy.addSource(huge)).rejects.toThrow('between 1 byte')
  })
  it('preserves malformed Academy data instead of overwriting it with defaults', async () => {
    const path = await directory(), file = join(path, 'academy.json')
    await writeFile(file, '{invalid')
    const academy = service(path)
    expect(() => academy.profile(alpha)).toThrow('existing file was preserved')
    expect(await readFile(file, 'utf8')).toBe('{invalid')
  })
  it('evaluates the selected model only via local Ollama and records honest scores', async () => {
    const path = await directory()
    const answers = ['ORBIT', '42', 'wrong']
    const call = vi.fn(async (_path: string, _body?: unknown, _signal?: AbortSignal) => new Response(JSON.stringify({ message: { content: answers.shift() } })))
    const academy = service(path, call)
    const result = await academy.evaluate(alpha)
    expect(result).toMatchObject({ model: alpha.name, digest: 'digest-a', passed: 2, total: 3 })
    expect(call).toHaveBeenCalledTimes(3)
    expect(call.mock.calls.every(([path, body]) => path === 'api/chat' && (body as { model: string; stream: boolean }).model === alpha.name && (body as { stream: boolean }).stream === false)).toBe(true)
    expect(service(path).snapshot().evaluations[0].id).toBe(result.id)
  })
  it('does not send prompt benchmarks to embedding-only models', async () => {
    const path = await directory(), call = vi.fn(async () => new Response('{}'))
    const academy = service(path, call)
    await expect(academy.evaluate({ ...alpha, name: 'embed:latest', capabilities: ['embedding'] })).rejects.toThrow('does not advertise chat completion')
    expect(call).not.toHaveBeenCalled()
  })
  it('cancels a running evaluation without recording a fabricated result', async () => {
    const path = await directory()
    const call = vi.fn((_path: string, _body: unknown, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
    const academy = service(path, call as never)
    const pending = academy.evaluate(alpha)
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    expect(academy.cancelEvaluation()).toBe(true)
    await expect(pending).rejects.toThrow('cancelled')
    expect(academy.snapshot().evaluations).toHaveLength(0)
  })
  it('enforces command validation and applies model instructions to local inference only', async () => {
    expect(academyCommandSchema.safeParse({ action: 'instructions', model: alpha.name, instructions: 'x'.repeat(4001) }).success).toBe(false)
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true })}\n`))
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), alpha.name, defaultSettings.localAI, alpha, 'Prefer short answers.')
    for await (const _chunk of provider.streamMessage([{ id: 'u', role: 'user', content: 'Hi', status: 'complete', createdAt: 1 }])) { /* consume */ }
    const payload = JSON.parse(request.mock.calls[0][1]?.body as string)
    expect(payload.messages[0].content).toContain('Prefer short answers.')
    expect(payload.model).toBe(alpha.name)
  })
  it('keeps user-approved corrections opt-in, model- and digest-scoped, editable and removable', async () => {
    const path = await directory(), academy = service(path)
    const entry = academy.saveCorrection(alpha, { kind: 'code', prompt: 'Fix the React effect cleanup', correction: 'Remove the listener in the cleanup function.', evidence: 'The focused component test passed.' })
    expect(academy.instructionsFor(alpha.name, 'Fix React effect cleanup')).not.toContain('Remove the listener')
    academy.setLearning(alpha, true)
    expect(academy.instructionsFor(alpha.name, 'Fix React effect cleanup')).toContain('Remove the listener')
    expect(academy.instructionsFor(beta.name, 'Fix React effect cleanup')).toBe('')
    expect(academy.instructionsFor(alpha.name, 'Explain SQL query')).not.toContain('Remove the listener')
    const reloaded = service(path)
    expect(reloaded.profile(alpha).learnFromCorrections).toBe(true)
    expect(reloaded.snapshot().corrections?.[0].id).toBe(entry.id)
    expect(reloaded.exportCorrections(alpha.name)).toContain('athena-academy-corrections')
    reloaded.updateCorrection(alpha, entry.id, { kind: 'code', prompt: entry.prompt, correction: 'Unsubscribe in cleanup.', evidence: entry.evidence })
    expect(reloaded.instructionsFor(alpha.name, 'Fix React effect cleanup')).toContain('Unsubscribe in cleanup')
    reloaded.profile({ ...alpha, digest: 'new-model-version' })
    expect(reloaded.instructionsFor(alpha.name, 'Fix React effect cleanup')).not.toContain('Unsubscribe in cleanup')
    reloaded.removeCorrection(entry.id)
    expect(reloaded.snapshot().corrections).toEqual([])
  })
  it('compares only the same track and current model digest', async () => {
    const path = await directory(), academy = service(path)
    academy.profile(alpha); academy.profile(beta)
    await academy.evaluate(alpha, 'general')
    const current = academyComparison(academy.snapshot(), 'general')
    expect(current.find(item => item.model === alpha.name)?.latest).toBeDefined()
    expect(current.find(item => item.model === beta.name)?.latest).toBeUndefined()
    expect(academyComparison(academy.snapshot(), 'coding').every(item => !item.latest)).toBe(true)
    academy.profile({ ...alpha, digest: 'new-version' })
    expect(academyComparison(academy.snapshot(), 'general').find(item => item.model === alpha.name)?.latest).toBeUndefined()
  })
})
