// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyService } from '../electron/main/ai/academyService'
import { academyCourses, courseProgress, courseStages } from '../shared/academyCourses'
import type { LocalModel } from '../shared/localAI'

const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
const model: LocalModel = { name: 'qwen2.5-coder:3b', digest: 'version1', size: 1, capabilities: ['completion'] }
const embedding: LocalModel = { name: 'embeddinggemma:latest', digest: 'embed1', size: 1, capabilities: ['embedding'] }
const response = (body: unknown) => new Response(JSON.stringify(body))
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'athena-course-test-')); paths.push(path)
  const call = vi.fn(async (endpoint: string, body?: unknown, _signal?: AbortSignal) => {
    if (endpoint === 'api/tags') return response({ models: [{ name: embedding.name, digest: embedding.digest }] })
    if (endpoint === 'api/embed') return response({ embeddings: (body as { input: string[] }).input.map(() => [1, 0]) })
    const prompt = (body as { messages: Array<{ content: string }> }).messages.at(-1)!.content
    const answer = prompt.includes('worked example') ? 'Review git status and the staged diff before committing. Verify with tests, and never claim remote state without a fetch. This is only an illustrative example.' : prompt.includes('summarizes') ? 'git status' : prompt.includes('actual patch') ? 'git diff --staged' : prompt.includes('Without a fetch') ? 'NO' : 'YES'
    return response({ message: { content: answer } })
  })
  const ollama = { call, modelDetails: async () => embedding }
  const service = new AcademyService(join(path, 'academy'), ollama)
  const knowledge = async () => { const original = join(path, 'git-guide.md'); await writeFile(original, '# Git guide\nReview staged changes and test before committing.'); const source = await service.addSource(original); service.linkSource(model, source.id, true); service.setEmbeddingModel(model, embedding); await service.indexSource(model, source.id, () => {}) }
  return { path, service, knowledge, ollama, call }
}
describe('persistent Academy courses', () => {
  it('registers eight courses and never treats an installed guidance pack as a passed course', async () => {
    expect(academyCourses).toHaveLength(8)
    const { service } = await fixture()
    service.setModule(model, 'git-intelligence', true)
    expect(courseProgress(service.snapshot().courses?.[0])).toMatchObject({ status: 'Not Started', percent: 0 })
    await service.courseStage(model, 'git', 'foundation')
    expect(courseProgress(service.snapshot().courses?.[0])).toMatchObject({ status: 'In Progress', completed: 1 })
    await expect(service.courseStage(model, 'git', 'evaluation')).rejects.toThrow('preceding')
    await expect(service.courseStage(model, 'git', 'knowledge')).rejects.toThrow('approved knowledge source')
  })
  it('uses approved RAG in guidance, separate held-out prompts in assessment, and persists per digest', async () => {
    const { service, knowledge, call, path, ollama } = await fixture()
    await service.courseStage(model, 'git', 'foundation'); await knowledge()
    for (const stage of courseStages.slice(1)) await service.courseStage(model, 'git', stage)
    const record = service.snapshot().courses![0]
    expect(courseProgress(record)).toMatchObject({ status: 'Passed', percent: 100 })
    await expect(service.courseStage(model, 'git', 'evaluation')).rejects.toThrow('already passed')
    const requests = call.mock.calls.filter(([endpoint]) => endpoint === 'api/chat').map(([, body]) => body as { model: string; messages: Array<{ role: string; content: string }> })
    expect(requests.every(item => item.model === model.name)).toBe(true)
    expect(requests[0].messages[0].content).toContain('untrusted reference material')
    expect(requests.slice(1).every(item => item.messages.at(-1)?.role === 'user' && !item.messages.some(m => m.content.includes('untrusted reference material')))).toBe(true)
    const restored = new AcademyService(join(path, 'academy'), ollama)
    expect(restored.snapshot().courses![0]).toEqual(record)
    await restored.courseStage({ ...model, digest: 'version2' }, 'git', 'foundation')
    await restored.courseStage({ ...model, name: 'another:3b' }, 'git', 'foundation')
    expect(restored.snapshot().courses).toHaveLength(3)
    expect(restored.snapshot().courses![0]).toEqual(record)
  })
  it('fails a critical check despite a permissive threshold and preserves prior results', async () => {
    const { service, knowledge, call, path } = await fixture()
    await service.courseStage(model, 'git', 'foundation'); await knowledge()
    for (const stage of courseStages.slice(1)) await service.courseStage(model, 'git', stage)
    const changed = join(path, 'git-extra.md'); await writeFile(changed, '# Extra Git guide\nVerify remote state before claiming it.')
    const extra = await service.addSource(changed, model, 'git'); service.setEmbeddingModel(model, embedding); await service.indexSource(model, extra.id, () => {}, 'git')
    await service.courseStage(model, 'git', 'knowledge')
    expect(service.snapshot().courses![0].results.map(result => result.stage)).toEqual(['foundation', 'knowledge', 'guided', 'practical', 'ready', 'evaluation', 'knowledge'])
    for (const stage of courseStages.slice(2, 5)) await service.courseStage(model, 'git', stage)
    call.mockImplementation(async () => response({ message: { content: 'YES' } }))
    await service.courseStage(model, 'git', 'evaluation', 50)
    const record = service.snapshot().courses![0]
    expect(record.results).toHaveLength(11)
    expect(record.results.at(-1)).toMatchObject({ score: 50, passed: false })
    expect(courseProgress(record)).toMatchObject({ completed: 5, status: 'Failed' })
    const failedId = record.results.at(-1)!.id
    service.deleteCourseResult(model, 'git', failedId)
    expect(service.snapshot().courses![0].results.some(result => result.id === failedId)).toBe(false)
    await expect(Promise.resolve().then(() => service.deleteCourseResult(model, 'git', record.results[0].id))).rejects.toThrow('Only failed')
  })
  it('restarts a course in a new run while retaining historical results', async () => {
    const { service, knowledge } = await fixture()
    await service.courseStage(model, 'git', 'foundation'); await knowledge()
    for (const stage of courseStages.slice(1)) await service.courseStage(model, 'git', stage)
    const before = service.snapshot().courses![0]
    await service.restartCourse(model, 'git')
    const restarted = service.snapshot().courses![0]
    expect(restarted.activeRunId).toBeDefined()
    expect(courseProgress(restarted)).toMatchObject({ completed: 0, status: 'Not Started' })
    await service.courseStage(model, 'git', 'foundation')
    const after = service.snapshot().courses![0]
    expect(after.results).toHaveLength(before.results.length + 1)
    expect(after.results.filter(result => result.stage === 'evaluation')).toHaveLength(1)
    expect(after.results.at(-1)).toMatchObject({ stage: 'foundation', runId: restarted.activeRunId, passed: true })
  })
  it('cancels a local lesson without a fabricated completion and releases its execution slot', async () => {
    const { service, knowledge, call } = await fixture()
    await service.courseStage(model, 'git', 'foundation'); await knowledge(); await service.courseStage(model, 'git', 'knowledge')
    const original = call.getMockImplementation()!
    call.mockImplementation((endpoint, body, signal) => endpoint !== 'api/chat' ? original(endpoint, body, signal) : new Promise<Response>((_resolve, reject) => { if (signal?.aborted) reject(new Error('cancelled')); else signal?.addEventListener('abort', () => reject(new Error('cancelled'))) }))
    const pending = service.courseStage(model, 'git', 'guided')
    await vi.waitFor(() => expect(call.mock.lastCall?.[0]).toBe('api/chat'))
    await expect(service.courseStage(model, 'git', 'guided')).rejects.toThrow('Another local lesson')
    service.cancelEvaluation()
    await expect(pending).rejects.toThrow('cancelled')
    expect(service.snapshot().courses![0].results).toHaveLength(2)
    await expect(service.courseStage(model, 'git', 'foundation')).rejects.toThrow('already complete')
  })
  it('migrates old metadata without dropping stored evaluations, knowledge or instructions', async () => {
    const { path, service, ollama } = await fixture()
    service.setInstructions(model, 'Keep these preferences.')
    const file = join(path, 'academy', 'academy.json')
    const original = JSON.parse(await readFile(file, 'utf8')); delete original.courses; await writeFile(file, JSON.stringify(original))
    const restored = new AcademyService(join(path, 'academy'), ollama)
    expect(restored.snapshot().courses).toEqual([])
    await restored.courseStage(model, 'git', 'foundation')
    expect(restored.profile(model).instructions).toBe('Keep these preferences.')
    expect(restored.snapshot().evaluations).toEqual(original.evaluations)
  })
})
