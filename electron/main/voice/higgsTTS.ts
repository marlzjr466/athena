import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Settings } from '../../../shared/settings'
import type { SpeechVoice } from '../../../shared/speech'
import { HIGGS_LICENSE_NOTE, HIGGS_REPO, type HiggsReference, type HiggsStatus, type HiggsSupportedTokens } from '../../../shared/higgsTTS'
import { applyHiggsDelivery } from '../../../shared/higgsSpeech'
import type { SpeechService } from './speechService'
import { ChatError } from '../ai/AIProvider'

interface Pending { id: string; startedAt: number; resolve(value: Uint8Array): void; reject(error: Error): void; clean(): void }

/** Isolated official Higgs TTS 3 runtime. Never loads Chatterbox or Sesame weights. */
export class HiggsTTS implements SpeechService {
  readonly mimeType = 'audio/wav' as const
  private worker?: ChildProcessWithoutNullStreams
  private job?: ChildProcessWithoutNullStreams
  private pending?: Pending
  private preparing = false
  private idle?: ReturnType<typeof setTimeout>
  private buffer = ''
  private supported?: HiggsSupportedTokens
  private state: Omit<HiggsStatus, 'references'> = {
    runtime: false, downloaded: false, verified: false, loaded: false, busy: false,
    stage: 'Not loaded', license: HIGGS_LICENSE_NOTE, streaming: false, diskEstimateBytes: 9300 * 1024 * 1024,
    memoryWarning: 'The 4B checkpoint often needs 10+ GB of unified memory while loaded. Unload unused voice engines. If Ollama is also resident, generation may fail; Athena will not switch engines.',
  }
  readonly python: string
  constructor(private settings: () => Settings, readonly script: string, readonly requirements: string, readonly root = join(homedir(), '.athena', 'models', 'higgs-tts-3')) {
    this.python = join(root, 'runtime', 'bin', 'python3')
  }
  private env(online = false): NodeJS.ProcessEnv {
    return { ...process.env, ATHENA_HIGGS_ROOT: this.root, NO_TORCH_COMPILE: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_OFFLINE: online ? '0' : '1', TRANSFORMERS_OFFLINE: online ? '0' : '1', OMP_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4', VECLIB_MAXIMUM_THREADS: '4' }
  }
  async status(): Promise<HiggsStatus> {
    let compatibility: { compatible?: boolean; message?: string } = {}
    try { compatibility = JSON.parse(await readFile(join(this.root, 'compatibility.json'), 'utf8')) } catch { /* Not checked yet. */ }
    const references: HiggsReference[] = []
    for (const file of await readdir(join(this.root, 'references')).catch(() => [])) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
      try { references.push(JSON.parse(await readFile(join(this.root, 'references', file), 'utf8'))) } catch { /* Incomplete imports are not selectable. */ }
    }
    const downloaded = existsSync(join(this.root, 'downloaded.json'))
    const verified = existsSync(join(this.root, 'verified.json'))
    let architecture = this.state.architecture
    try {
      const meta = JSON.parse(await readFile(join(this.root, downloaded ? 'downloaded.json' : 'verified.json'), 'utf8'))
      architecture = architecture ?? meta.architecture?.modelType ?? meta.architecture
      this.supported = meta.supportedTokens ?? this.supported
    } catch { /* Status remains useful without metadata. */ }
    return {
      ...this.state,
      compatible: compatibility.compatible,
      compatibilityMessage: compatibility.message,
      runtime: existsSync(join(this.root, 'runtime-ready.json')),
      downloaded, verified, busy: Boolean(this.job || this.pending),
      architecture: typeof architecture === 'string' ? architecture : undefined,
      supportedTokens: this.supported,
      references,
    }
  }
  private terminate(child?: ChildProcessWithoutNullStreams) {
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 2000)
    timer.unref(); child.once('exit', () => clearTimeout(timer))
  }
  unload(message = 'Higgs speech cancelled.'): void {
    clearTimeout(this.idle); this.idle = undefined
    const worker = this.worker, pending = this.pending
    this.worker = undefined; this.pending = undefined; this.buffer = ''; this.state.loaded = false
    this.state.stage = message === 'Higgs speech cancelled.' ? 'Unloaded' : 'Needs attention'
    if (message !== 'Higgs speech cancelled.') this.state.error = message
    this.terminate(worker)
    pending?.clean(); pending?.reject(new ChatError(message))
  }
  cancel(): void {
    const active = Boolean(this.job || this.pending), job = this.job
    this.job = undefined; this.terminate(job); this.unload()
    this.state.stage = active ? 'Cancelled; partial downloads can resume' : 'Unloaded; selected engine and references remain saved'
  }
  private run(command: string, args: string[], online = false): Promise<Record<string, any>> {
    if (this.job || this.pending) return Promise.reject(new ChatError('Higgs is busy. Cancel the current operation first.'))
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'pipe', env: this.env(online) }); this.job = child
      let buffer = '', result: Record<string, any> = {}
      const timer = setTimeout(() => { if (this.job === child) this.cancel() }, 60 * 60_000)
      child.stdout.on('data', data => {
        buffer += data.toString()
        if (buffer.length > 64000) buffer = buffer.slice(-32000)
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try {
            const value = JSON.parse(line); result = { ...result, ...value }
            if (value.stage) this.state.stage = String(value.stage).slice(0, 240)
            if (typeof value.progress === 'number') this.state.progress = Math.min(1, Math.max(0, value.progress))
            if (value.supportedTokens) this.supported = value.supportedTokens
            if (value.architecture) this.state.architecture = typeof value.architecture === 'string' ? value.architecture : value.architecture.modelType
          } catch { /* pip output never reaches UI or logs */ }
        }
      })
      child.stderr.on('data', () => {})
      child.once('error', () => { clearTimeout(timer); if (this.job === child) this.job = undefined; reject(new ChatError('The isolated Higgs Python runtime could not start.')) })
      child.once('close', code => {
        clearTimeout(timer)
        if (this.job !== child) { reject(new ChatError('Higgs operation cancelled.')); return }
        this.job = undefined
        if (code !== 0 || result.ok === false) reject(new ChatError(typeof result.message === 'string' ? result.message : 'Higgs runtime setup failed. Chatterbox and Sesame remain available as separately selected engines.'))
        else resolve(result)
      })
    })
  }
  async setup(): Promise<void> {
    this.state.error = undefined; this.state.progress = undefined; this.state.stage = 'Installing isolated Higgs PyTorch/Transformers dependencies'
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (!existsSync(this.python)) {
      const python = ['/opt/homebrew/bin/python3.11', join(homedir(), '.athena', 'models', 'tts', 'runtime', 'bin', 'python3')].find(existsSync)
      if (!python) throw new ChatError('Python 3.11 is required for the isolated Higgs runtime. Install Python 3.11, then retry setup.')
      await this.run(python, ['-m', 'venv', join(this.root, 'runtime')])
    }
    await this.run(this.python, ['-m', 'pip', 'install', '-r', this.requirements], true)
    // Only architecture metadata is fetched here; weights still require approval.
    const inspected = await this.run(this.python, [this.script, 'inspect'], true)
    await writeFile(join(this.root, 'runtime-ready.json'), JSON.stringify({ inspectedAt: new Date().toISOString(), source: HIGGS_REPO, torch: inspected.torch, mpsAvailable: inspected.mpsAvailable }))
    this.state.stage = inspected.compatible === false
      ? 'Dependencies installed; Higgs model architecture is not supported by this runtime'
      : 'Dependencies installed; real speech generation still requires verification'
    this.state.error = inspected.compatible === false ? inspected.message : undefined
  }
  async download(): Promise<void> {
    if (!existsSync(this.python)) throw new ChatError('Install the isolated Higgs runtime first.')
    const status = await this.status()
    if (status.compatible === false) throw new ChatError(status.compatibilityMessage ?? 'The Higgs runtime is incompatible. No model weights were downloaded.')
    this.unload(); this.state.error = undefined; this.state.progress = 0; this.state.stage = `Downloading official ${HIGGS_REPO}`
    await this.run(this.python, [this.script, 'download'], true)
    this.state.stage = 'Official checkpoint downloaded; verify files, then use Preview Voice'
    this.state.progress = 1
  }
  async verify(): Promise<void> {
    if (!existsSync(this.python)) throw new ChatError('Install the isolated Higgs runtime first.')
    this.state.error = undefined; this.state.stage = 'Verifying official checkpoint files'
    const result = await this.run(this.python, [this.script, 'verify'])
    this.supported = result.supportedTokens ?? this.supported
    this.state.architecture = typeof result.architecture === 'string' ? result.architecture : this.state.architecture
    this.state.streaming = false
    this.state.stage = typeof result.stage === 'string' ? result.stage : 'Checkpoint files verified; speech still needs a successful preview'
  }
  async removeModel(): Promise<void> {
    this.unload()
    await rm(join(this.root, 'hub'), { recursive: true, force: true })
    await rm(join(this.root, 'downloaded.json'), { force: true })
    await rm(join(this.root, 'verified.json'), { force: true })
    this.state.progress = undefined
    this.state.stage = 'Official Higgs checkpoint removed. Runtime and imported references remain.'
  }
  async importReference(file: string, transcript: string): Promise<string> {
    if (!existsSync(this.python)) throw new ChatError('Set up the isolated Higgs runtime before importing reference audio.')
    if ((await stat(file)).size > 20 * 1024 * 1024 || !/\.wav$/i.test(file)) throw new ChatError('Use a WAV recording under 20 MB, lasting 1–20 seconds.')
    const folder = join(this.root, 'references'), id = randomUUID(), target = join(folder, `${id}.wav`)
    await mkdir(folder, { recursive: true, mode: 0o700 }); await copyFile(file, target)
    try {
      const result = await this.run(this.python, [this.script, 'reference', target])
      if (!Number.isFinite(result.seconds)) throw new Error('Invalid duration')
      const reference: HiggsReference = { id, name: basename(file), transcript, seconds: result.seconds }
      await writeFile(join(folder, `${id}.json`), JSON.stringify(reference), { mode: 0o600 })
      return id
    } catch (error) { await rm(target, { force: true }); throw error }
  }
  async removeReference(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ChatError('Invalid reference ID.')
    this.unload()
    await rm(join(this.root, 'references', `${id}.json`), { force: true })
    await rm(join(this.root, 'references', `${id}.wav`), { force: true })
  }
  error(error: unknown): string {
    const message = error instanceof ChatError ? error.userMessage : 'Higgs operation failed. Chatterbox and Sesame remain independently selectable.'
    this.state.error = message; this.state.stage = 'Needs attention'; return message
  }
  private start(): ChildProcessWithoutNullStreams {
    if (this.worker) return this.worker
    if (!existsSync(this.python)) throw new ChatError('Install the Higgs runtime in Settings → Voice first.')
    if (!existsSync(join(this.root, 'downloaded.json'))) throw new ChatError('Download the official Higgs TTS 3 checkpoint in Settings → Voice first. Athena will not substitute another model.')
    const child = spawn(this.python, ['-u', this.script], { stdio: 'pipe', env: this.env() })
    this.worker = child; this.buffer = ''; this.state.stage = 'Loading official Higgs TTS 3'; this.state.error = undefined
    child.stderr.on('data', () => {})
    child.stdout.on('data', data => {
      if (child !== this.worker) return
      this.buffer += data.toString()
      if (this.buffer.length > 8 * 1024 * 1024) { this.unload('Higgs exceeded the audio output limit.'); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
        let result: Record<string, any>
        try { result = JSON.parse(line) } catch { this.unload('Higgs returned invalid output.'); return }
        const pending = this.pending
        if (!pending || result.id !== pending.id) continue
        if (!result.ok || typeof result.wav !== 'string') { this.state.error = typeof result.message === 'string' ? result.message : 'Higgs generation failed.'; this.unload(this.state.error); return }
        const bytes = Buffer.from(result.wav, 'base64')
        if (bytes.length < 44 || bytes.length > 8 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') { this.unload('Higgs returned invalid WAV audio.'); return }
        if (result.metrics?.supportedTokens) this.supported = result.metrics.supportedTokens
        this.state = {
          ...this.state, loaded: true, error: undefined, streaming: false,
          stage: 'Speech generated with official Higgs TTS 3',
          device: result.metrics?.device,
          architecture: result.metrics?.architecture ?? this.state.architecture,
          metrics: result.metrics ? {
            loadMs: result.metrics.loadMs, generationMs: result.metrics.generationMs, totalMs: Date.now() - pending.startedAt,
            firstAudioMs: result.metrics.firstAudioMs ?? result.metrics.generationMs, audioSeconds: result.metrics.audioSeconds,
            peakProcessBytes: result.metrics.peakProcessBytes, device: result.metrics.device, streaming: false,
          } : undefined,
        }
        this.pending = undefined; pending.clean(); pending.resolve(bytes)
        this.idle = setTimeout(() => this.unload(), 120000); this.idle.unref()
      }
    })
    child.stdin.on('error', () => { if (this.worker === child) this.unload('Higgs input disconnected.') })
    child.on('error', () => { if (this.worker === child) this.unload('Higgs could not start. Check its runtime.') })
    child.on('exit', () => { if (this.worker === child) this.unload('Higgs worker exited. Check memory and dependencies.') })
    return child
  }
  async generate(text: string, _voice: SpeechVoice, _speed: number, signal: AbortSignal, contextKey?: string): Promise<Uint8Array> {
    if (signal.aborted) throw new ChatError('Speech stopped.')
    if (this.job || this.pending || this.preparing) throw new ChatError('Higgs is busy. Stop the current operation first.')
    this.preparing = true
    const preferences = this.settings().localVoice.higgs
    const kind = contextKey?.startsWith('wake-ack') ? 'wake' : contextKey?.includes('error') ? 'error' : 'chat'
    const delivery = applyHiggsDelivery({ speechText: text, kind, settings: preferences, supported: this.supported })
    try {
      const status = await this.status()
      if (status.compatible === false) throw new ChatError(status.compatibilityMessage ?? 'Higgs runtime compatibility must be resolved before speech generation.')
      if (!delivery.spoken || delivery.spoken.length > 4000) throw new ChatError('Higgs supports up to 4000 characters per request. Use shorter replies.')
      if (signal.aborted) throw new ChatError('Speech stopped.')
      clearTimeout(this.idle)
      const child = this.start(), id = randomUUID()
      const result = new Promise<Uint8Array>((resolve, reject) => {
        const abort = () => { if (this.pending?.id === id) this.unload() }
        const timer = setTimeout(() => { if (this.pending?.id === id) this.unload('Higgs timed out after ten minutes. No other voice was substituted.') }, 600000)
        this.pending = { id, startedAt: Date.now(), resolve, reject, clean: () => { clearTimeout(timer); signal.removeEventListener('abort', abort) } }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) { abort(); return }
        child.stdin.write(JSON.stringify({
          id, text: delivery.spoken, device: preferences.device, language: preferences.language,
          referenceId: preferences.referenceId, contextKey,
        }) + '\n', error => { if (error && this.pending?.id === id) this.unload('Higgs input failed.') })
      })
      this.preparing = false
      return result
    } catch (error) { this.preparing = false; throw error }
  }
  dispose(): void { this.cancel() }
}
