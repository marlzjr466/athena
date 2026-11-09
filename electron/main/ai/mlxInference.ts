import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createReadStream, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { LocalModel } from '../../../shared/localAI'
import type { MLXActivationSource, MLXDiagnostic, MLXModelRegistration } from '../../../shared/mlxInference'
import { mlxWorker } from './mlxWorker'

export class MLXInference {
  private registrations: MLXModelRegistration[] = []
  private diagnostics = new Map<string, MLXDiagnostic>()
  private child?: ChildProcess
  private loadError = false
  constructor(private directory: string, private python = join(homedir(), '.athena/models/training/runtime/bin/python3')) {
    try { const data = JSON.parse(readFileSync(join(directory, 'models.json'), 'utf8')); if (!Array.isArray(data)) throw new Error('Invalid MLX registry'); this.registrations = data }
    catch (error) { this.loadError = (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
  list() { return structuredClone(this.registrations) }
  status(): MLXDiagnostic[] { return [...this.registrations.map(model => this.diagnostics.get(model.id) ?? this.diagnostic(model, 'idle')), ...[...this.diagnostics.values()].filter(d => !this.registrations.some(m => m.id === d.id))].map(d => ({ ...d })) }
  private diagnostic(model: MLXModelRegistration, status: MLXDiagnostic['status']): MLXDiagnostic { return { id: model.id, label: model.label, baseCheckpoint: model.checkpointPath, adapterCheckpoint: model.adapterName, provider: 'mlx', status, verifiedAt: model.verifiedAt, previousModel: model.previousModel } }
  metadata(id: string): LocalModel {
    const model = this.registrations.find(m => m.id === id)
    if (!model) throw new Error(`MLX model ${id} is not activated. Activate a verified adapter in Academy Step 7.`)
    return { name: id, label: model.label, provider: 'mlx', size: model.size, digest: model.digest, family: model.family, contextLength: model.contextLength, capabilities: ['completion', ...(model.toolsVerified ? ['tools'] : [])] }
  }
  private async hash(path: string) {
    if (!statSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`MLX source must be a regular file: ${path}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }
  private async fingerprint(source: MLXActivationSource): Promise<Record<string, string>> {
    const names = readdirSync(source.checkpointPath).filter(name => /(?:\.safetensors|\.json|\.model|\.tiktoken|merges\.txt|vocab\.txt)$/.test(name)).sort()
    if (!names.includes('config.json') || !names.some(name => name.startsWith('tokenizer'))) throw new Error('Source checkpoint is missing model/tokenizer configuration.')
    const files: Record<string, string> = {}
    for (const name of names) files[join(source.checkpointPath, name)] = await this.hash(join(source.checkpointPath, name))
    files[source.adapterPath] = await this.hash(source.adapterPath)
    files[source.adapterConfigPath] = await this.hash(source.adapterConfigPath)
    return files
  }
  private async verifyIdentity(model: MLXModelRegistration) {
    const actual = await this.fingerprint(model)
    if (JSON.stringify(actual) !== JSON.stringify(model.files)) throw new Error('MLX checkpoint, tokenizer, or adapter changed since activation. Reactivate and verify this adapter before inference.')
  }
  private worker(request: object, signal?: AbortSignal): AsyncIterable<Record<string, any>> {
    const self = this
    return { async *[Symbol.asyncIterator]() {
      if (self.child) throw new Error('MLX inference is already running. Cancel or finish it before starting another request.')
      signal?.throwIfAborted()
      const child = spawn(self.python, ['-u', '-c', mlxWorker], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1' } })
      self.child = child
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      let stderr = '', failure: Error | undefined
      const finished = new Promise<number | null>(resolve => { child.once('error', e => { failure = e; resolve(-1) }); child.once('close', resolve) })
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000) })
      const cancel = () => child.kill('SIGKILL')
      signal?.addEventListener('abort', cancel, { once: true })
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify(request))
      let pending = '', done = false, reported: string | undefined
      try {
        for await (const chunk of child.stdout!) {
          signal?.throwIfAborted()
          pending += chunk.toString()
          if (pending.length > 2_000_000) throw new Error('MLX worker output exceeded its safety limit.')
          let index: number
          while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1)
            if (!line) continue
            let event: Record<string, any>
            try { event = JSON.parse(line) } catch { continue }
            if (event.error) reported = `${event.errorType ?? 'MLX error'}: ${event.error}`
            done ||= event.done === true
            yield event
          }
        }
        const code = await finished
        signal?.throwIfAborted()
        if (failure) throw failure
        if (reported || code !== 0 || !done) throw new Error(reported ?? `MLX worker exited ${code} before completion. ${stderr}`)
      } finally {
        signal?.removeEventListener('abort', cancel)
        if (child.exitCode === null) cancel()
        await finished
        if (self.child === child) self.child = undefined
      }
    } }
  }
  async activate(source: MLXActivationSource, previousModel: string | null): Promise<MLXModelRegistration> {
    if (this.loadError) throw new Error('MLX registry could not be read; existing registration was preserved.')
    if (this.child) throw new Error('Finish or cancel MLX inference before activation.')
    const config = JSON.parse(readFileSync(join(source.checkpointPath, 'config.json'), 'utf8'))
    const adapter = JSON.parse(readFileSync(source.adapterConfigPath, 'utf8'))
    if (config.model_type !== 'qwen2') throw new Error(`Unsupported verified MLX activation architecture: ${config.model_type}`)
    if (adapter.model !== source.checkpointPath) throw new Error('Adapter source path does not match the exact training checkpoint.')
    if (adapter.fine_tune_type !== 'lora' || adapter.lora_parameters?.rank !== 8 || !Number.isInteger(adapter.num_layers) || adapter.num_layers > config.num_hidden_layers) throw new Error('Expected a compatible rank-8 LoRA adapter with valid layer count.')
    const files = await this.fingerprint(source)
    const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    const adapterFolder = join(this.directory, 'adapters', digest)
    mkdirSync(adapterFolder, { recursive: true, mode: 0o700 })
    copyFileSync(source.adapterPath, join(adapterFolder, 'adapters.safetensors'))
    copyFileSync(source.adapterConfigPath, join(adapterFolder, 'adapter_config.json'))
    const model: MLXModelRegistration = { ...source, id: 'mlx:athena-coder-v2', label: 'Athena Coder v2', provider: 'mlx', digest, files, contextLength: Math.min(config.max_position_embeddings ?? 32768, 32768), family: config.model_type, size: Object.keys(files).filter(p => p.endsWith('.safetensors')).reduce((sum, p) => sum + statSync(p).size, 0), previousModel: previousModel === 'mlx:athena-coder-v2' ? this.registrations.find(m => m.id === previousModel)?.previousModel ?? null : previousModel, verifiedAt: '', baseResponse: '', adapterResponse: '', adapterTensorCount: 0, logitDifference: 0, toolsVerified: false }
    this.diagnostics.set(model.id, this.diagnostic(model, 'loading'))
    try {
      for await (const event of this.worker({ checkpointPath: source.checkpointPath, adapterPath: adapterFolder, verify: true, maxTokens: 128, contextLength: model.contextLength, temperature: 0 }, AbortSignal.timeout(600_000))) {
        if (event.verification) Object.assign(model, event.verification)
        if (event.memoryGB) this.diagnostics.set(model.id, { ...this.diagnostic(model, 'loading'), memoryGB: event.memoryGB })
      }
      if (!model.adapterResponse || !model.baseResponse || !(model.logitDifference > 0) || !model.adapterTensorCount) throw new Error('MLX activation did not return complete base/adapter verification evidence.')
      await this.verifyIdentity(model)
      model.verifiedAt = new Date().toISOString()
      const next = [...this.registrations.filter(m => m.id !== model.id), model]
      const target = join(this.directory, 'models.json')
      writeFileSync(target + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(target + '.tmp', target)
      this.registrations = next
      this.diagnostics.set(model.id, { ...this.diagnostic(model, 'idle'), memoryGB: this.diagnostics.get(model.id)?.memoryGB })
      return structuredClone(model)
    } catch (error) { this.diagnostics.set(model.id, { ...this.diagnostic(model, 'error'), error: String(error) }); throw error }
  }
  async call(body: unknown, signal?: AbortSignal): Promise<Response> {
    const input = body as { model: string; stream?: boolean; messages: unknown[]; tools?: unknown[]; options?: { num_predict?: number; num_ctx?: number; temperature?: number } }
    const model = this.registrations.find(m => m.id === input.model)
    if (!model) throw new Error('Selected MLX model has not passed activation.')
    const diagnostic = this.diagnostic(model, 'loading'); this.diagnostics.set(model.id, diagnostic)
    try { await this.verifyIdentity(model) } catch (error) { diagnostic.status = 'error'; diagnostic.error = String(error); throw error }
    const adapterFolder = join(this.directory, 'adapters', model.digest)
    // Verify the inference copy as well as the original exported checkpoint.
    try {
      if (await this.hash(join(adapterFolder, 'adapters.safetensors')) !== model.files[model.adapterPath] || await this.hash(join(adapterFolder, 'adapter_config.json')) !== model.files[model.adapterConfigPath]) throw new Error('MLX inference adapter copy changed. Reactivate this adapter.')
    } catch (error) { diagnostic.status = 'error'; diagnostic.error = String(error); throw error }
    const abort = new AbortController(), combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(600_000)])
    const worker = this.worker({ checkpointPath: model.checkpointPath, adapterPath: adapterFolder, messages: input.messages, tools: input.tools, maxTokens: Math.min(input.options?.num_predict ?? 1024, 8192), contextLength: Math.min(input.options?.num_ctx ?? model.contextLength, model.contextLength), temperature: input.options?.temperature ?? .3 }, combined)
    const iterator = worker[Symbol.asyncIterator]()
    if (!input.stream) {
      let content = ''
      try { for await (const event of worker) { if (event.error) throw new Error(event.error); content += event.message?.content ?? ''; if (event.memoryGB) diagnostic.memoryGB = event.memoryGB } diagnostic.status = 'idle'; return Response.json({ message: { content } }) }
      catch (error) { diagnostic.status = combined.aborted ? 'idle' : 'error'; diagnostic.error = String(error); throw error }
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next()
          if (done) { diagnostic.status = 'idle'; controller.close(); return }
          if (value.loaded) diagnostic.status = 'generating'
          if (value.memoryGB) diagnostic.memoryGB = value.memoryGB
          if (value.error) { diagnostic.error = String(value.error); diagnostic.status = 'error'; throw new Error(value.error) }
          controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'))
        } catch (error) { diagnostic.status = combined.aborted ? 'idle' : 'error'; diagnostic.error = String(error); controller.error(error); await iterator.return?.() }
      },
      async cancel() { abort.abort(); await iterator.return?.(); diagnostic.status = 'idle' },
    })
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
  }
  cancel() { this.child?.kill('SIGKILL') }
}
