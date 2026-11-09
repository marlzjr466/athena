import { createHash } from 'node:crypto'
import type { DatasetSplit } from '../../../shared/academyTraining'

export const datasetHash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
interface DatasetRow { line: string; key: string; prompt: string; lineNumber: number }
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ')

/** Canonical MLX-LM conversation/text records, shared by automatic and manual imports. */
export function parseDataset(content: string, minimum = 1): DatasetRow[] {
  if (Buffer.byteLength(content, 'utf8') > 20 * 1024 * 1024) throw new Error('JSONL must be 20 MB or smaller.')
  const rows: DatasetRow[] = [], seen = new Set<string>()
  for (const [index, line] of content.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let item: unknown
    try { item = JSON.parse(line) } catch { throw new Error(`Invalid JSONL at line ${index + 1}.`) }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Line ${index + 1} must be an object with text or messages.`)
    const row = item as Record<string, unknown>
    let canonical: object, prompt: string
    if ('messages' in row) {
      if (!Array.isArray(row.messages) || row.messages.length < 2) throw new Error(`Line ${index + 1} needs user and assistant messages.`)
      const messages = row.messages.map((message: unknown) => {
        if (!message || typeof message !== 'object') throw new Error(`Line ${index + 1} has an invalid message.`)
        const m = message as Record<string, unknown>
        if (!['system', 'user', 'assistant'].includes(String(m.role))) throw new Error(`Line ${index + 1} has an unsupported message role.`)
        if (typeof m.content !== 'string' || !m.content.trim()) throw new Error(`Line ${index + 1}: ${String(m.role)} response/content must be nonempty.`)
        return { role: m.role as string, content: m.content.trim() }
      })
      let expected = 'user'
      for (const [i, message] of messages.entries()) {
        if (i === 0 && message.role === 'system') continue
        if (message.role !== expected) throw new Error(`Line ${index + 1}: messages must alternate user and assistant after an optional system message.`)
        expected = expected === 'user' ? 'assistant' : 'user'
      }
      if (messages.at(-1)?.role !== 'assistant') throw new Error(`Line ${index + 1} must end with a nonempty assistant response.`)
      canonical = { messages }
      prompt = messages.filter(m => m.role === 'user').map(m => normalize(m.content)).join('\n')
    } else {
      if (typeof row.text !== 'string' || !row.text.trim()) throw new Error(`Line ${index + 1} needs nonempty text or messages.`)
      canonical = { text: row.text.trim() }; prompt = normalize(row.text)
    }
    const serialized = JSON.stringify(canonical), key = datasetHash(normalize(serialized))
    if (seen.has(key)) throw new Error(`Duplicate example at line ${index + 1}. Remove exact duplicates before importing.`)
    seen.add(key); rows.push({ line: serialized, key, prompt, lineNumber: index + 1 })
  }
  if (rows.length < minimum || rows.length > 20_000) throw new Error(`Provide ${minimum}–20,000 JSONL examples.`)
  if (new Set(rows.map(row => row.line.startsWith('{"messages":') ? 'messages' : 'text')).size > 1) throw new Error('Use one format per file: messages or text. MLX-LM selects a dataset format from the first row.')
  return rows
}

export function checkDatasetOverlap(sets: Partial<Record<DatasetSplit, DatasetRow[]>>): string[] {
  const seen = new Map<string, DatasetSplit>(), prompts = new Map<string, DatasetSplit>()
  // Bounded token-shingle candidates: a local similarity heuristic, not a semantic guarantee.
  const buckets = new Map<string, Array<{ split: DatasetSplit; words: Set<string> }>>()
  let similar = false
  for (const split of ['train', 'valid', 'test'] as const) for (const row of sets[split] ?? []) {
    const owner = seen.get(row.key) ?? prompts.get(row.prompt)
    if (owner && owner !== split) throw new Error(`Dataset overlap: ${split} line ${row.lineNumber} repeats an example or user prompt in ${owner}.`)
    seen.set(row.key, split); prompts.set(row.prompt, split)
    const words = new Set(row.prompt.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    const tokens = [...words].sort(), keys = tokens.slice(0, 4)
    if (words.size < 5) continue
    for (const key of keys) {
      const candidates = buckets.get(key) ?? []
      if (!similar) for (const other of candidates) {
        if (other.split === split) continue
        const common = [...words].filter(w => other.words.has(w)).length
        if (common / (words.size + other.words.size - common) >= .8) { similar = true; break }
      }
      if (candidates.length < 40) candidates.push({ split, words })
      buckets.set(key, candidates)
    }
  }
  return similar ? ['Potential semantic overlap: highly similar prompts occur across datasets. Review for data leakage. This local wording-similarity heuristic cannot detect every paraphrase.'] : []
}
