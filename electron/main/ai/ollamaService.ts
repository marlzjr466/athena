import os from 'node:os'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { localEndpointSchema, localModelIdSchema, type LocalModel, type LocalPullProgress, type LocalStatus } from '../../../shared/localAI'
import type { MLXInference } from './mlxInference'
import { ChatError } from './AIProvider'

const run = promisify(execFile)

function cardValue(info: Record<string, unknown>, suffix: string): unknown {
  return Object.entries(info).find(([key]) => key.endsWith(suffix))?.[1]
}
function cardNumber(info: Record<string, unknown>, suffix: string): number | undefined {
  const value = cardValue(info, suffix)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function readModelCard(info: Record<string, unknown>): Pick<LocalModel, 'contextLength' | 'architecture' | 'ropeScaling' | 'generationLimit'> {
  const heads = cardNumber(info, '.attention.head_count')
  const embedding = cardNumber(info, '.embedding_length')
  const headDim = cardNumber(info, '.attention.key_length') ?? (embedding && heads ? embedding / heads : undefined)
  const blocks = cardNumber(info, '.block_count')
  const kvHeads = cardNumber(info, '.attention.head_count_kv')
  const ropeType = cardValue(info, '.rope.scaling.type')
  const architecture = blocks && kvHeads && headDim && Number.isInteger(blocks) && Number.isInteger(kvHeads) && Number.isInteger(headDim) ? { blocks, kvHeads, headDim } : undefined
  const ropeScaling = typeof ropeType === 'string' && ropeType
    ? { type: ropeType, factor: cardNumber(info, '.rope.scaling.factor'), originalContext: cardNumber(info, '.rope.scaling.original_context_length') ?? cardNumber(info, '.rope.scaling.original_max_position_embeddings') }
    : undefined
  return { contextLength: cardNumber(info, '.context_length'), architecture, ropeScaling, generationLimit: cardNumber(info, '.generation_length') ?? cardNumber(info, '.max_new_tokens') }
}

async function installedMacVoices(): Promise<LocalStatus['macVoices']> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/say')) return []
  try {
    const { stdout } = await run('/usr/bin/say', ['-v', '?'], { timeout: 5000, maxBuffer: 64 * 1024 })
    return stdout.split('\n').flatMap((line) => {
      const match = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2,3})\s+#/)
      return match ? [{ name: match[1].trim(), locale: match[2] }] : []
    })
  } catch { return [] }
}

export async function* ndjson(response: Response, signal?: AbortSignal): AsyncIterable<Record<string, unknown>> {
  if (!response.body) throw new ChatError('The local AI server returned an empty response.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      if (pending.length > 2_000_000) throw new ChatError('The local AI response exceeded the safety limit.')
      let boundary = pending.indexOf('\n')
      while (boundary >= 0) {
        const line = pending.slice(0, boundary).trim(); pending = pending.slice(boundary + 1)
        if (line) yield JSON.parse(line) as Record<string, unknown>
        boundary = pending.indexOf('\n')
      }
    }
    if (pending.trim()) yield JSON.parse(pending.trim()) as Record<string, unknown>
  } finally { await reader.cancel().catch(() => {}) }
}

export class OllamaService {
  private pull?: AbortController
  private ggufPaths = new Map<string, string | null>()
  mlx?: MLXInference
  constructor(private endpoint: () => string, private request: typeof fetch = fetch) {}
  private url(path: string): string {
    const base = localEndpointSchema.parse(this.endpoint())
    return new URL(path, base.endsWith('/') ? base : `${base}/`).toString()
  }
  endpointFor(path: string): string { return this.url(path) }
  async call(path: string, body?: unknown, signal?: AbortSignal, timeout = 60_000): Promise<Response> {
    const model = (body as { model?: string } | undefined)?.model
    if (model?.startsWith('mlx:')) {
      if (!this.mlx) throw new ChatError('Native MLX inference is unavailable.')
      if (path !== 'api/chat') throw new ChatError(`MLX model does not support ${path}.`)
      return this.mlx.call(body, signal)
    }
    const deadline = AbortSignal.timeout(timeout)
    let response: Response
    try {
      response = await this.request(this.url(path), { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: 'error' })
    } catch (error) {
      if (signal?.aborted) throw new ChatError('Local AI request cancelled.')
      if (deadline.aborted) throw new ChatError('Ollama took too long to respond. Check the selected model and system memory.')
      throw new ChatError('Cannot reach Ollama on this Mac. Start Ollama and check its endpoint in My Athena → Local AI setup.')
    }
    if (!response.ok) {
      if (response.status === 404) throw new ChatError('The selected Ollama model is not installed. Choose an installed model in My Athena → Local AI setup.')
      if (response.status === 400) throw new ChatError('Ollama rejected this model or request. Check model capabilities and local settings.')
      if (response.status === 503 || response.status === 500) throw new ChatError('Ollama could not load the model. Check available memory and its server status.')
      throw new ChatError(`Ollama request failed (HTTP ${response.status}).`)
    }
    return response
  }
  async ggufPath(name: string): Promise<string | null> {
    if (this.ggufPaths.has(name)) return this.ggufPaths.get(name) ?? null
    if (name.startsWith('mlx:')) { this.ggufPaths.set(name, null); return null }
    try {
      const response = await this.call('api/show', { model: localModelIdSchema.parse(name) }, undefined, 15_000)
      const result = await response.json() as { modelfile?: string }
      const match = /^FROM\s+(\/[^\s]+)/m.exec(result.modelfile ?? '')
      const path = match?.[1]
      const allowed = Boolean(path && path.includes('/.ollama/models/blobs/') && !path.includes('..') && existsSync(path))
      const value = allowed && path ? path : null
      this.ggufPaths.set(name, value)
      return value
    } catch { return null }
  }
  async modelDetails(name: string): Promise<LocalModel> {
    if (name.startsWith('mlx:')) { if (!this.mlx) throw new ChatError('Native MLX inference is unavailable.'); return this.mlx.metadata(name) }
    const response = await this.call('api/show', { model: localModelIdSchema.parse(name) }, undefined, 15_000)
    const result = await response.json() as { capabilities?: string[]; details?: { family?: string; quantization_level?: string }; model_info?: Record<string, unknown>; size?: number }
    const card = readModelCard(result.model_info ?? {})
    return { name, size: result.size ?? 0, capabilities: Array.isArray(result.capabilities) ? result.capabilities : [], family: result.details?.family, quantization: result.details?.quantization_level, ...card }
  }
  async status(): Promise<LocalStatus> {
    const hardware = { arch: os.arch(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
      whisperInstalled: ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'].some(existsSync),
      macSpeechAvailable: process.platform === 'darwin' && existsSync('/usr/bin/say') && existsSync('/usr/bin/afconvert'),
      macVoices: await installedMacVoices() }
    try {
      const response = await this.call('api/tags', undefined, undefined, 5000)
      const data = await response.json() as { models?: Array<{ name: string; size?: number; modified_at?: string; digest?: string }> }
      const listed = Array.isArray(data.models) ? data.models.slice(0, 100) : []
      const models = await Promise.all(listed.map(async (item) => {
        try { return { ...await this.modelDetails(item.name), size: item.size ?? 0, modifiedAt: item.modified_at, digest: item.digest } }
        catch { return { name: item.name, size: item.size ?? 0, modifiedAt: item.modified_at, digest: item.digest, capabilities: [] } }
      }))
      return { connected: true, message: 'Ollama is available on this Mac.', models: [...models, ...(this.mlx?.list().map(m => this.mlx!.metadata(m.id)) ?? [])], mlxDiagnostics: this.mlx?.status(), ...hardware }
    } catch { const models = this.mlx?.list().map(m => this.mlx!.metadata(m.id)) ?? []; return { connected: models.length > 0, message: models.length ? 'Native MLX models available; Ollama is unavailable.' : 'Ollama is unavailable. Install or start Ollama, then try again.', models, mlxDiagnostics: this.mlx?.status(), ...hardware } }
  }
  async pullModel(name: string, progress: (value: LocalPullProgress) => void): Promise<void> {
    if (this.pull) throw new ChatError('A model download is already in progress.')
    const model = localModelIdSchema.parse(name), abort = new AbortController(); this.pull = abort
    try {
      const response = await this.call('api/pull', { model, stream: true }, abort.signal, 3_600_000)
      for await (const event of ndjson(response, abort.signal)) {
        if (typeof event.error === 'string') throw new ChatError('Ollama could not download this model. Check disk space and connectivity.')
        progress({ model, status: String(event.status ?? 'Downloading'), completed: typeof event.completed === 'number' ? event.completed : undefined, total: typeof event.total === 'number' ? event.total : undefined })
      }
      progress({ model, status: 'Complete', done: true })
    } finally { if (this.pull === abort) this.pull = undefined }
  }
  cancelPull(): void { this.pull?.abort() }
  async deleteModel(name: string): Promise<void> {
    if (name.startsWith('mlx:')) throw new ChatError('MLX adapters are preserved in Academy. Switch models using the model selector or Step 7 rollback.')
    const response = await this.request(this.url('api/delete'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: localModelIdSchema.parse(name) }), signal: AbortSignal.timeout(15_000), redirect: 'error' })
    if (!response.ok) throw new ChatError('Ollama could not remove this model.')
  }
}
