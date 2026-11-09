import { createHash, randomUUID } from 'node:crypto'
import { rename, readFile, mkdir, writeFile, lstat, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AcademyKnowledgeScope, AcademySource } from '../../../shared/academy'
import type { SourceReference } from '../../../shared/conversations'
import type { OllamaService } from './ollamaService'

const MAX_CHUNKS = 2000
const MAX_CHARS = 1200
const vectorSchema = z.array(z.number().finite()).min(1).max(4096)
const indexSchema = z.object({ version: z.literal(1), sourceId: z.string().uuid(), sourceHash: z.string(), model: z.string(), digest: z.string(), courseId: z.string().optional(), localModel: z.string().optional(), localDigest: z.string().optional(), totalChunks: z.number().int().nonnegative(), complete: z.boolean(),
  entries: z.array(z.object({ start: z.number().int().positive(), end: z.number().int().positive(), text: z.string().max(MAX_CHARS + 100), vector: vectorSchema }).strict()).max(MAX_CHUNKS) }).strict()
type Index = z.infer<typeof indexSchema>
export interface KnowledgeHit { sourceId: string; source: SourceReference; text: string; score: number }
export interface KnowledgeIndexScope { courseId: AcademyKnowledgeScope; localModel: string; localDigest?: string }

export function chunkKnowledge(text: string): Array<{ start: number; end: number; text: string }> {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const chunks: Array<{ start: number; end: number; text: string }> = []
  let current = '', start = 1, end = 1
  const flush = () => { if (current.trim()) chunks.push({ start, end, text: current.trimEnd() }); current = '' }
  lines.forEach((line, lineIndex) => {
    const number = lineIndex + 1
    const pieces: string[] = []
    for (let offset = 0; offset < line.length;) {
      let endOffset = Math.min(offset + MAX_CHARS, line.length)
      if (endOffset < line.length && /[\uD800-\uDBFF]/u.test(line[endOffset - 1]) && /[\uDC00-\uDFFF]/u.test(line[endOffset])) endOffset--
      pieces.push(line.slice(offset, endOffset))
      offset = endOffset
    }
    if (!pieces.length) pieces.push('')
    for (const piece of pieces) {
      if (current && current.length + piece.length + 1 > MAX_CHARS) flush()
      if (!current) start = number
      current += `${piece}\n`; end = number
    }
  })
  flush()
  if (chunks.length > MAX_CHUNKS) throw new Error('This source exceeds the 2,000-chunk local indexing limit. Split it into smaller files.')
  return chunks
}

function validVector(value: unknown): number[] {
  const parsed = vectorSchema.parse(value)
  if (!parsed.some(number => number !== 0)) throw new Error('The embedding model returned a zero vector.')
  return parsed
}
function similarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return -Infinity
  let dot = 0, aa = 0, bb = 0
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2 }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -Infinity
}

/** An opaque, local-only index. All reads are constrained by caller-supplied approved source IDs. */
export class AcademyKnowledge {
  constructor(private directory: string, private ollama: Pick<OllamaService, 'call'>) {}
  private path(sourceId: string, model: string, digest: string, scope?: KnowledgeIndexScope): string {
    const key = createHash('sha256').update(scope ? `${scope.courseId}\0${scope.localModel}\0${scope.localDigest ?? ''}\0${model}\0${digest}` : `${model}\0${digest}`).digest('hex').slice(0, 24)
    return join(this.directory, 'indexes', `${sourceId}-${key}.json`)
  }
  private async save(path: string, index: Index): Promise<void> {
    const directory = join(this.directory, 'indexes')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory()) throw new Error('Academy index storage is not a regular directory.')
    const temporary = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, JSON.stringify(index), { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
  }
  private async load(path: string): Promise<Index> {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('The local index is not a regular file within the safe size limit.')
    return indexSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  }
  private async embed(model: string, input: string[], signal: AbortSignal): Promise<number[][]> {
    const response = await this.ollama.call('api/embed', { model, input, truncate: false, keep_alive: '2m' }, signal, 90_000)
    const body = await response.json() as { embeddings?: unknown[] }
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) throw new Error('Ollama returned an incomplete embedding batch.')
    const vectors = body.embeddings.map(validVector)
    if (vectors.some(vector => vector.length !== vectors[0].length)) throw new Error('Ollama returned inconsistent embedding dimensions.')
    return vectors
  }
  async build(source: AcademySource, model: string, digest: string, signal: AbortSignal, progress: (done: number, total: number) => void, scope?: KnowledgeIndexScope): Promise<number> {
    if (!(await lstat(join(this.directory, 'knowledge'))).isDirectory()) throw new Error('Academy knowledge storage is not a regular directory.')
    const sourcePath = join(this.directory, 'knowledge', source.id)
    const info = await lstat(sourcePath)
    if (!info.isFile() || info.size !== source.bytes || info.size > 10 * 1024 * 1024) throw new Error('The stored source size changed. Re-import it before indexing.')
    const bytes = await readFile(sourcePath)
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('The stored source changed. Re-import it before indexing.')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const chunks = chunkKnowledge(text)
    if (!chunks.length) throw new Error('The source has no readable text to index.')
    const path = this.path(source.id, model, digest, scope)
    let index: Index = { version: 1, sourceId: source.id, sourceHash: source.sha256, model, digest, ...(scope ? { courseId: scope.courseId, localModel: scope.localModel, localDigest: scope.localDigest } : {}), totalChunks: chunks.length, complete: false, entries: [] }
    try {
      const saved = await this.load(path)
      if (saved.sourceHash !== source.sha256 || saved.totalChunks !== chunks.length || saved.model !== model || saved.digest !== digest) throw new Error('Existing index checkpoint does not match this source or embedding model.')
      if (scope && (saved.courseId !== scope.courseId || saved.localModel !== scope.localModel || saved.localDigest !== scope.localDigest)) throw new Error('Existing index checkpoint does not match this Academy module or local model version.')
      if (saved.entries.length <= chunks.length && (!saved.complete || saved.entries.length === chunks.length)) {
        index = saved
        if (index.complete) { progress(chunks.length, chunks.length); return chunks.length }
      }
    } catch (error) {
      // A malformed derived index can be rebuilt from the validated source;
      // filesystem/security errors and source/model mismatches are not ignored.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error
      // A source's vectors are safe to reuse across module assignments when
      // the source hash and embedding model digest match. The new file still
      // carries its own course scope, so retrieval boundaries remain strict.
      if (scope && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        const directory = join(this.directory, 'indexes')
        try {
          const candidates = (await readdir(directory)).filter(file => file.startsWith(`${source.id}-`) && file.endsWith('.json'))
          for (const candidate of candidates) {
            try {
              const reusable = await this.load(join(directory, candidate))
              if (reusable.complete && reusable.sourceHash === source.sha256 && reusable.model === model && reusable.digest === digest && reusable.entries.length === chunks.length) {
                index = { ...reusable, ...(scope ? { courseId: scope.courseId, localModel: scope.localModel, localDigest: scope.localDigest } : {}) }
                await this.save(path, index)
                progress(index.entries.length, chunks.length)
                return index.entries.length
              }
            } catch { /* Ignore unrelated or malformed derived indexes. */ }
          }
        } catch (scanError) { if ((scanError as NodeJS.ErrnoException).code !== 'ENOENT') throw scanError }
      }
    }
    progress(index.entries.length, chunks.length)
    try {
      for (let offset = index.entries.length; offset < chunks.length; offset += 8) {
        signal.throwIfAborted()
        const batch = chunks.slice(offset, offset + 8)
        const vectors = await this.embed(model, batch.map(chunk => chunk.text), signal)
        if (index.entries.length && vectors.some(vector => vector.length !== index.entries[0].vector.length)) throw new Error('The embedding model changed vector dimensions during indexing. Select a stable local embedding model and retry.')
        for (let item = 0; item < batch.length; item++) index.entries.push({ ...batch[item], vector: vectors[item] })
        if (index.entries.length % 64 === 0) await this.save(path, index)
        progress(index.entries.length, chunks.length)
      }
      index.complete = true
      await this.save(path, index)
      return index.entries.length
    } catch (error) {
      if (index.entries.length) await this.save(path, index)
      throw error
    }
  }
  async search(sources: AcademySource[], model: string, digest: string, question: string, signal: AbortSignal, limit = 5, scope?: KnowledgeIndexScope, allowLegacyFallback = false): Promise<KnowledgeHit[]> {
    const count = Math.min(Math.max(Math.trunc(limit), 0), 8)
    if (!sources.length || !question.trim() || !count) return []
    const vector = (await this.embed(model, [question.slice(0, 1200)], signal))[0]
    const hits: KnowledgeHit[] = []
    for (const source of sources) {
      signal.throwIfAborted()
      let index: Index
      try { index = await this.load(this.path(source.id, model, digest, scope)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`The local index for ${source.name} is unreadable. Re-index this source.`)
        if (!scope || !allowLegacyFallback) continue
        // Legacy indexes predate module scoping. They can be read only for a
        // source explicitly assigned to the requested scope; the caller has
        // already applied that assignment boundary.
        try { index = await this.load(this.path(source.id, model, digest)) }
        catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error(`The local index for ${source.name} is unreadable. Re-index this source.`) }
      }
      if (!index.complete || index.entries.length !== index.totalChunks || index.sourceHash !== source.sha256 || index.model !== model || index.digest !== digest) continue
      if (scope && index.courseId && (index.courseId !== scope.courseId || index.localModel !== scope.localModel || index.localDigest !== scope.localDigest)) continue
      for (const entry of index.entries) {
        const score = similarity(vector, entry.vector)
        if (!Number.isFinite(score) || (hits.length === count && score <= hits[hits.length - 1].score)) continue
        const hit: KnowledgeHit = { sourceId: source.id, source: { workspace: 'Athena Academy', path: `knowledge/${source.id}/${source.name}`, start: entry.start, end: entry.end }, text: entry.text, score }
        const position = hits.findIndex(existing => score > existing.score)
        hits.splice(position < 0 ? hits.length : position, 0, hit)
        if (hits.length > count) hits.pop()
      }
    }
    return hits
  }
}
