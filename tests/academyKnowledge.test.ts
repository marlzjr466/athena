// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyService } from '../electron/main/ai/academyService'
import { AcademyKnowledge, chunkKnowledge } from '../electron/main/ai/academyKnowledge'
import type { LocalModel } from '../shared/localAI'
import type { OllamaService } from '../electron/main/ai/ollamaService'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'athena-rag-test-')); directories.push(path); return path }
const digest = 'a'.repeat(64)
const model: LocalModel = { name: 'qwen2.5:3b', size: 1, capabilities: ['completion'] }
const other: LocalModel = { ...model, name: 'qwen2.5-coder:3b' }
const embedding: LocalModel = { name: 'embeddinggemma:latest', size: 1, capabilities: ['embedding'], digest }
const response = (value: unknown) => new Response(JSON.stringify(value))
function localOllama(options?: { waitOnCall?: number }) {
  let embedCalls = 0
  const call = vi.fn(async (path: string, body?: unknown, signal?: AbortSignal) => {
    if (path === 'api/tags') return response({ models: [{ name: embedding.name, digest }] })
    if (path !== 'api/embed') throw new Error('Unexpected external request')
    embedCalls++
    if (options?.waitOnCall === embedCalls) await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    const input = (body as { input: string[] }).input
    return response({ embeddings: input.map(value => /moon/i.test(value) ? [1, 0] : [0, 1]) })
  })
  const modelDetails = vi.fn(async (name: string) => name === embedding.name ? embedding : model)
  return { call, modelDetails, get embedCalls() { return embedCalls } } as unknown as OllamaService & { call: typeof call; modelDetails: typeof modelDetails; embedCalls: number }
}

describe('private local Academy knowledge index', () => {
  it('preserves source line ranges and bounds oversized indexing', () => {
    expect(chunkKnowledge('One\nTwo\nThree')).toEqual([{ start: 1, end: 3, text: 'One\nTwo\nThree' }])
    expect(chunkKnowledge(`${'a'.repeat(1100)}\n${'b'.repeat(1100)}`)).toMatchObject([{ start: 1, end: 1 }, { start: 2, end: 2 }])
    expect(chunkKnowledge('🌙'.repeat(700)).every(chunk => chunk.text.length <= 1201 && !chunk.text.includes('\uFFFD'))).toBe(true)
    expect(() => chunkKnowledge(`${'a'.repeat(1100)}\n`.repeat(2001))).toThrow('2,000-chunk')
  })
  it('indexes approved files with local embeddings, retrieves cited excerpts only for linked models, and reuses a shared index', async () => {
    const path = await directory(), original = join(path, 'moon.md'), ollama = localOllama(), academy = new AcademyService(join(path, 'academy'), ollama)
    await writeFile(original, 'Moon geology notes\nThe crater is basaltic.')
    const source = await academy.addSource(original)
    academy.linkSource(model, source.id, true)
    academy.setEmbeddingModel(model, embedding)
    academy.setModule(model, 'personal-knowledge', true)
    const progress = vi.fn()
    await academy.indexSource(model, source.id, progress)
    expect(progress.mock.lastCall?.[0]).toMatchObject({ status: 'ready', indexedChunks: 1, totalChunks: 1 })
    expect(ollama.call.mock.calls.some(([endpoint, body]) => endpoint === 'api/embed' && (body as { truncate: boolean }).truncate === false)).toBe(true)
    expect((await academy.retrieve(model.name, 'Tell me about the moon', new AbortController().signal)).sources).toEqual([{ workspace: 'Athena Academy', path: `knowledge/${source.id}/moon.md`, start: 1, end: 2 }])
    expect(await academy.retrieve(other.name, 'Tell me about the moon', new AbortController().signal)).toMatchObject({ text: '', sources: [] })
    academy.linkSource(other, source.id, true)
    academy.setEmbeddingModel(other, embedding)
    academy.setModule(other, 'personal-knowledge', true)
    expect((await academy.retrieve(other.name, 'moon', new AbortController().signal)).text).toContain('Moon geology')
    expect((await readdir(join(path, 'academy', 'indexes'))).length).toBe(1)
    await academy.removeSource(source.id)
    expect(await readdir(join(path, 'academy', 'indexes'))).toEqual([])
    expect((await academy.retrieve(model.name, 'moon', new AbortController().signal)).text).toBe('')
  })
  it('checkpoints cancelled work and resumes without re-embedding completed chunks', async () => {
    const path = await directory(), original = join(path, 'long.txt'), ollama = localOllama({ waitOnCall: 2 }), academy = new AcademyService(join(path, 'academy'), ollama)
    await writeFile(original, `${'moon'.repeat(250)}\n`.repeat(20))
    const source = await academy.addSource(original)
    academy.linkSource(model, source.id, true); academy.setEmbeddingModel(model, embedding)
    const progress = vi.fn()
    const pending = academy.indexSource(model, source.id, progress)
    await vi.waitFor(() => expect(ollama.embedCalls).toBe(2))
    expect(academy.cancelIndex()).toBe(true)
    await expect(pending).rejects.toThrow('cancelled')
    expect(academy.snapshot().sources[0].indexes[0]).toMatchObject({ status: 'paused', indexedChunks: 8 })
    await academy.indexSource(model, source.id, progress)
    expect(academy.snapshot().sources[0].indexes[0]).toMatchObject({ status: 'ready', indexedChunks: 20 })
    const embedBodies = ollama.call.mock.calls.filter(([endpoint]) => endpoint === 'api/embed').map(([, body]) => body as { input: string[] })
    expect(embedBodies.map(body => body.input.length)).toEqual([8, 8, 8, 4])
  })
  it('refuses stale indexes when the embedding model digest changes', async () => {
    const path = await directory(), original = join(path, 'source.txt'), ollama = localOllama(), academy = new AcademyService(join(path, 'academy'), ollama)
    await writeFile(original, 'Moon rocks are basaltic.')
    const source = await academy.addSource(original)
    academy.linkSource(model, source.id, true); academy.setEmbeddingModel(model, embedding); academy.setModule(model, 'personal-knowledge', true)
    await academy.indexSource(model, source.id, vi.fn())
    ollama.call.mockImplementation(async (endpoint: string, body?: unknown) => endpoint === 'api/tags' ? response({ models: [{ name: embedding.name, digest: 'b'.repeat(64) }] }) : response({ embeddings: (body as { input: string[] }).input.map(() => [1, 0]) }))
    const result = await academy.retrieve(model.name, 'moon', new AbortController().signal)
    expect(result.text).toBe('')
    expect(result.notice).toContain('Re-index linked Academy sources')
  })
  it('reserves the single indexing slot before asynchronous model checks', async () => {
    const path = await directory(), original = join(path, 'source.txt'), ollama = localOllama(), academy = new AcademyService(join(path, 'academy'), ollama)
    await writeFile(original, 'Moon rocks are basaltic.')
    const source = await academy.addSource(original)
    academy.linkSource(model, source.id, true); academy.setEmbeddingModel(model, embedding)
    let release: (() => void) | undefined
    ollama.modelDetails.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return embedding })
    const first = academy.indexSource(model, source.id, vi.fn())
    await vi.waitFor(() => expect(release).toBeDefined())
    await expect(academy.indexSource(model, source.id, vi.fn())).rejects.toThrow('already running')
    release?.()
    await first
    expect(academy.snapshot().sources[0].indexes[0].status).toBe('ready')
  })
  it('rebuilds a malformed derived index from the validated source copy', async () => {
    const path = await directory(), original = join(path, 'source.txt'), ollama = localOllama(), academy = new AcademyService(join(path, 'academy'), ollama)
    await writeFile(original, 'Moon rocks are basaltic.')
    const source = await academy.addSource(original)
    academy.linkSource(model, source.id, true); academy.setEmbeddingModel(model, embedding); academy.setModule(model, 'personal-knowledge', true)
    await academy.indexSource(model, source.id, vi.fn())
    const indexDirectory = join(path, 'academy', 'indexes')
    await writeFile(join(indexDirectory, (await readdir(indexDirectory))[0]), '{invalid')
    await academy.indexSource(model, source.id, vi.fn())
    expect((await academy.retrieve(model.name, 'moon', new AbortController().signal)).text).toContain('Moon rocks')
  })
  it('keeps retrieval bounded and stable with thousands of indexed chunks', async () => {
    const path = await directory(), root = join(path, 'academy'), indexFolder = join(root, 'indexes')
    await mkdir(indexFolder, { recursive: true })
    const key = createHash('sha256').update(`${embedding.name}\0${digest}`).digest('hex').slice(0, 24)
    const sources = Array.from({ length: 2 }, (_, sourceIndex) => ({ id: randomUUID(), name: `large-${sourceIndex}.md`, bytes: 1, sha256: 'a'.repeat(64), addedAt: new Date().toISOString(), indexes: [] }))
    for (const [sourceIndex, source] of sources.entries()) {
      const entries = Array.from({ length: 2000 }, (_, index) => ({ start: index + 1, end: index + 1, text: `Chunk ${sourceIndex}-${index}`, vector: index % 2 === 0 ? [1, 0] : [0, 1] }))
      await writeFile(join(indexFolder, `${source.id}-${key}.json`), JSON.stringify({ version: 1, sourceId: source.id, sourceHash: source.sha256, model: embedding.name, digest, totalChunks: entries.length, complete: true, entries }))
    }
    const ollama = localOllama(), knowledge = new AcademyKnowledge(root, ollama)
    const hits = await knowledge.search(sources, embedding.name, digest, 'moon', new AbortController().signal, 5)
    expect(hits.map(hit => [hit.sourceId, hit.source.start])).toEqual([[sources[0].id, 1], [sources[0].id, 3], [sources[0].id, 5], [sources[0].id, 7], [sources[0].id, 9]])
    expect(await knowledge.search(sources, embedding.name, digest, 'moon', new AbortController().signal, 0)).toEqual([])
    expect(ollama.embedCalls).toBe(1)
  })
})
