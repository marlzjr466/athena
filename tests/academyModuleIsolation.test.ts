// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyService } from '../electron/main/ai/academyService'
import type { LocalModel } from '../shared/localAI'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const response = (body: unknown) => new Response(JSON.stringify(body))
const model: LocalModel = { name: 'qwen2.5-coder:3b', digest: 'model-v1', size: 1, capabilities: ['completion'] }
const embedding: LocalModel = { name: 'embeddinggemma:latest', digest: 'embedding-v1', size: 1, capabilities: ['embedding'] }
function ollama() {
  const call = vi.fn(async (endpoint: string, body?: unknown) => {
    if (endpoint === 'api/tags') return response({ models: [{ name: embedding.name, digest: embedding.digest }] })
    if (endpoint === 'api/embed') return response({ embeddings: (body as { input: string[] }).input.map(text => /coding/i.test(text) ? [1, 0] : [0, 1]) })
    return response({ message: { content: 'A verified local answer with evidence and a limitation.' } })
  })
  return { call, modelDetails: vi.fn(async () => embedding) }
}

describe('Academy course source isolation', () => {
  it('keeps assignments, retrieval, and indexes scoped while reusing source vectors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-academy-module-')); roots.push(root)
    const codingPath = join(root, 'coding.md'), gitPath = join(root, 'git.md')
    await writeFile(codingPath, 'Coding source: prefer small verified changes.')
    await writeFile(gitPath, 'Git source: inspect staged changes before committing.')
    const service = new AcademyService(join(root, 'academy'), ollama())
    service.setEmbeddingModel(model, embedding)
    const coding = await service.addSource(codingPath, model, 'coding')
    const git = await service.addSource(gitPath, model, 'git')
    await service.indexSource(model, coding.id, () => {}, 'coding')
    await service.indexSource(model, git.id, () => {}, 'git')
    const profile = service.profile(model)
    expect(profile.knowledgeAssignments).toEqual(expect.arrayContaining([
      { courseId: 'coding', sourceIds: [coding.id] },
      { courseId: 'git', sourceIds: [git.id] },
    ]))
    const codingResult = await service.retrieve(model.name, 'coding', new AbortController().signal, 'coding')
    const gitResult = await service.retrieve(model.name, 'coding', new AbortController().signal, 'git')
    expect(codingResult.text).toContain(coding.id)
    expect(codingResult.text).not.toContain(git.id)
    expect(gitResult.text).toContain(git.id)
    expect(gitResult.text).not.toContain(coding.id)
    expect((await readdir(join(root, 'academy', 'indexes'))).length).toBe(2)

    const nextVersion = { ...model, digest: 'model-v2' }
    service.profile(nextVersion)
    await service.indexSource(nextVersion, coding.id, () => {}, 'coding')
    expect(service.snapshot().sources.find(source => source.id === coding.id)?.indexes.filter(index => index.courseId === 'coding').map(index => index.localDigest)).toEqual(expect.arrayContaining(['model-v1', 'model-v2']))

    // Adding the same file to another module reuses its private stored copy.
    const duplicate = await service.addSource(codingPath, nextVersion, 'git')
    expect(duplicate.id).toBe(coding.id)
    await service.indexSource(nextVersion, coding.id, () => {}, 'git')
    expect(service.snapshot().sources).toHaveLength(2)
    expect((await readdir(join(root, 'academy', 'indexes'))).length).toBe(4)
    await service.removeSource(coding.id, nextVersion, 'git')
    expect(service.profile(nextVersion).knowledgeAssignments?.find(item => item.courseId === 'coding')?.sourceIds).toEqual([coding.id])
    expect(service.profile(nextVersion).knowledgeAssignments?.find(item => item.courseId === 'git')?.sourceIds).toEqual([git.id])
    expect(service.snapshot().sources.some(source => source.id === coding.id)).toBe(true)
  })

  it('migrates a legacy list to the course proven by completed knowledge training and remains idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-academy-migrate-')); roots.push(root)
    const academyRoot = join(root, 'academy'), sourceId = randomUUID(), now = new Date().toISOString()
    const sourceBytes = Buffer.from('Existing coding source')
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
    await writeFile(join(root, 'legacy.md'), sourceBytes)
    await mkdir(join(academyRoot, 'knowledge'), { recursive: true })
    await writeFile(join(academyRoot, 'academy.json'), JSON.stringify({ version: 1, profiles: [{ model: model.name, digest: model.digest, instructions: '', modules: [{ id: 'coding-foundations', enabled: true }], knowledgeIds: [sourceId], embeddingModel: embedding.name, embeddingDigest: embedding.digest, learnFromCorrections: false, createdAt: now, updatedAt: now }], sources: [{ id: sourceId, name: 'legacy.md', bytes: sourceBytes.length, sha256: sourceHash, addedAt: now, indexes: [{ model: embedding.name, digest: embedding.digest, status: 'ready', indexedChunks: 1, totalChunks: 1, updatedAt: now }] }], evaluations: [], courses: [{ model: model.name, digest: model.digest, courseId: 'coding', threshold: 80, updatedAt: now, results: [{ id: randomUUID(), stage: 'knowledge', completedAt: now, passed: true, score: 100, checks: [], evidence: [] }] }] }))
    await writeFile(join(academyRoot, 'knowledge', sourceId), sourceBytes)
    const service = new AcademyService(academyRoot, ollama())
    expect(service.profile(model).knowledgeAssignments).toEqual([{ courseId: 'coding', sourceIds: [sourceId] }])
    expect(service.profile(model).knowledgeAssignments?.some(item => item.courseId === 'git')).toBe(false)
    const persisted = JSON.parse(await readFile(join(academyRoot, 'academy.json'), 'utf8'))
    expect(persisted.version).toBe(2)
    const restored = new AcademyService(academyRoot, ollama())
    expect(restored.profile(model).knowledgeAssignments).toEqual(service.profile(model).knowledgeAssignments)
    expect((await restored.retrieve(model.name, 'unrelated question', new AbortController().signal)).text).toBe('')
  })
})
