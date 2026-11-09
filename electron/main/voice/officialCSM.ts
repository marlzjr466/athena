import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Settings } from '../../../shared/settings'
import type { SpeechVoice } from '../../../shared/speech'
import { ATHENA_CSM_REFERENCE_ID, type CSMReference, type CSMStatus } from '../../../shared/officialCSM'
import { prepareLocalSpeech } from '../../../shared/localVoice'
import type { SpeechService } from './speechService'
import { ChatError } from '../ai/AIProvider'

interface Pending { id: string; startedAt: number; resolve(value: Uint8Array): void; reject(error: Error): void; clean(): void }
const ATHENA_REFERENCE_TRANSCRIPT = 'A rainbow is a meteorological phenomenon that is caused by reflection, refraction, and dispersion of light in water droplets resulting in a spectrum of light appearing in the sky.'
/** Separate official PyTorch runtime. It never calls Chatterbox or MLX. */
export class OfficialCSM implements SpeechService {
  readonly mimeType = 'audio/wav' as const
  private worker?: ChildProcessWithoutNullStreams
  private job?: ChildProcessWithoutNullStreams
  private pending?: Pending
  private preparing = false
  private idle?: ReturnType<typeof setTimeout>
  private buffer = ''
  private state: Omit<CSMStatus, 'references'> = { runtime: false, downloaded: false, loaded: false, busy: false, stage: 'Not loaded' }
  readonly python: string
  constructor(private settings: () => Settings, readonly source: string, readonly script: string, readonly root = join(homedir(), '.athena', 'models', 'csm-official'), private automaticReferenceSource = join(homedir(), '.athena', 'models', 'tts', 'profiles', 'athena-youthful-v2.wav')) { this.python = join(root, 'runtime', 'bin', 'python3') }
  private env(online = false): NodeJS.ProcessEnv {
    return { ...process.env, ATHENA_CSM_ROOT: this.root, ATHENA_CSM_SOURCE: this.source, NO_TORCH_COMPILE: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_OFFLINE: online ? '0' : '1', TRANSFORMERS_OFFLINE: online ? '0' : '1', OMP_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4', VECLIB_MAXIMUM_THREADS: '4' }
  }
  async status(): Promise<CSMStatus> {
    const references: CSMReference[] = []
    for (const file of await readdir(join(this.root, 'references')).catch(() => [])) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
      try { references.push(JSON.parse(await readFile(join(this.root, 'references', file), 'utf8'))) } catch { /* An incomplete import is not selectable. */ }
    }
    const automaticAudio = existsSync(join(this.root, 'references', `${ATHENA_CSM_REFERENCE_ID}.wav`)) || existsSync(join(this.root, 'references', `${ATHENA_CSM_REFERENCE_ID}.mp3`))
    return { ...this.state, runtime: existsSync(join(this.root, 'runtime-ready.json')), downloaded: existsSync(join(this.root, 'downloaded.json')), busy: Boolean(this.job || this.pending), automaticReferenceAvailable: existsSync(this.automaticReferenceSource) || automaticAudio || references.some(item => item.id === ATHENA_CSM_REFERENCE_ID), references }
  }
  private async ensureAutomaticReference(): Promise<string> {
    const folder = join(this.root, 'references')
    const extension = /\.mp3$/i.test(this.automaticReferenceSource) ? 'mp3' : 'wav'
    const audio = join(folder, `${ATHENA_CSM_REFERENCE_ID}.${extension}`)
    const metadata = join(folder, `${ATHENA_CSM_REFERENCE_ID}.json`)
    if (existsSync(audio) && existsSync(metadata)) return ATHENA_CSM_REFERENCE_ID
    if (!existsSync(this.automaticReferenceSource)) throw new ChatError('Sesame needs a matching voice recording to keep one voice. Import an authorized WAV and transcript in Settings → Voice → Sesame; no random voice was generated.')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    // Copy once: Sesame's anchor is independent of later Chatterbox/profile changes.
    // The official runtime decodes this MP3 through torchaudio; no alternate
    // speech engine or external service is involved.
    if (!existsSync(audio)) await copyFile(this.automaticReferenceSource, audio)
    const reference: CSMReference = { id: ATHENA_CSM_REFERENCE_ID, name: 'Athena US-English voice · automatic', transcript: ATHENA_REFERENCE_TRANSCRIPT, speaker: 0, seconds: 10.4 }
    await writeFile(metadata, JSON.stringify(reference), { mode: 0o600 })
    return ATHENA_CSM_REFERENCE_ID
  }
  private terminate(child?: ChildProcessWithoutNullStreams) {
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 2000)
    timer.unref(); child.once('exit', () => clearTimeout(timer))
  }
  unload(message = 'Sesame speech cancelled.'): void {
    clearTimeout(this.idle); this.idle = undefined
    const worker = this.worker, pending = this.pending
    this.worker = undefined; this.pending = undefined; this.buffer = ''; this.state.loaded = false
    this.state.stage = message === 'Sesame speech cancelled.' ? 'Unloaded' : 'Needs attention'
    if (message !== 'Sesame speech cancelled.') this.state.error = message
    this.terminate(worker)
    pending?.clean(); pending?.reject(new ChatError(message))
  }
  cancel(): void { const active = Boolean(this.job || this.pending), job = this.job; this.job = undefined; this.terminate(job); this.unload(); this.state.stage = active ? 'Cancelled; partial downloads can resume' : 'Unloaded; selected engine and references remain saved' }
  private run(command: string, args: string[], online = false): Promise<Record<string, any>> {
    if (this.job || this.pending) return Promise.reject(new ChatError('Sesame is busy. Cancel the current operation first.'))
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'pipe', env: this.env(online) }); this.job = child
      let buffer = '', result: Record<string, any> = {}
      const timer = setTimeout(() => { if (this.job === child) this.cancel() }, 30 * 60_000)
      child.stdout.on('data', data => {
        buffer += data.toString()
        if (buffer.length > 32000) buffer = buffer.slice(-16000)
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try { const value = JSON.parse(line); result = value; if (value.stage) this.state.stage = String(value.stage).slice(0, 240) } catch { /* pip output never reaches UI or logs */ }
        }
      })
      child.stderr.on('data', () => {})
      child.once('error', () => { clearTimeout(timer); if (this.job === child) this.job = undefined; reject(new ChatError('The isolated CSM Python runtime could not start.')) })
      child.once('close', code => {
        clearTimeout(timer)
        if (this.job !== child) { reject(new ChatError('CSM operation cancelled.')); return }
        this.job = undefined
        if (code !== 0 || result.ok === false) reject(new ChatError(typeof result.message === 'string' ? result.message : 'Official CSM dependency setup failed. The runtime remains separate from Chatterbox.'))
        else resolve(result)
      })
    })
  }
  async setup(): Promise<void> {
    this.state.error = undefined; this.state.stage = 'Installing isolated official PyTorch dependencies (indeterminate)'
    await mkdir(this.root, { recursive: true })
    if (!existsSync(this.python)) {
      // Use an existing Python 3.11 executable only to create a fresh venv; no inherited packages.
      const python = ['/opt/homebrew/bin/python3.11', join(homedir(), '.athena', 'models', 'tts', 'runtime', 'bin', 'python3')].find(existsSync)
      if (!python) throw new ChatError('Python 3.11 is required for the official pinned dependencies. Install Python 3.11, then retry setup.')
      await this.run(python, ['-m', 'venv', join(this.root, 'runtime')])
    }
    await this.run(this.python, ['-m', 'pip', 'install', '-r', join(this.source, 'requirements.txt')], true)
    await this.run(this.python, [this.script, 'inspect'])
    await writeFile(join(this.root, 'runtime-ready.json'), JSON.stringify({ inspectedAt: new Date().toISOString(), source: 'SesameAILabs/csm' }))
    this.state.stage = 'Runtime imports verified; download official models next'
  }
  async download(): Promise<void> {
    if (!existsSync(this.python)) throw new ChatError('Install the isolated official CSM runtime first.')
    this.unload(); this.state.error = undefined; this.state.stage = 'Downloading approved official models (indeterminate)'
    await this.run(this.python, [this.script, 'download'], true)
    this.state.stage = 'Model files downloaded; use Preview Voice to verify inference'
  }
  async importReference(file: string, transcript: string, speaker: number): Promise<string> {
    if (!existsSync(this.python)) throw new ChatError('Set up the isolated CSM runtime before importing reference audio.')
    if ((await stat(file)).size > 20 * 1024 * 1024 || !/\.wav$/i.test(file)) throw new ChatError('Use a WAV recording under 20 MB, lasting 1–20 seconds.')
    const folder = join(this.root, 'references'), id = randomUUID(), target = join(folder, `${id}.wav`)
    await mkdir(folder, { recursive: true }); await copyFile(file, target)
    try {
      const result = await this.run(this.python, [this.script, 'reference', target])
      if (!Number.isFinite(result.seconds)) throw new Error('Invalid duration')
      const reference: CSMReference = { id, name: basename(file), transcript, speaker, seconds: result.seconds }
      await writeFile(join(folder, `${id}.json`), JSON.stringify(reference), { mode: 0o600 })
      return id
    } catch (error) { await rm(target, { force: true }); throw error }
  }
  async removeReference(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ChatError('Invalid reference ID.')
    if (id === ATHENA_CSM_REFERENCE_ID) throw new ChatError('The automatic Athena voice anchor cannot be removed as a custom recording.')
    this.unload()
    await rm(join(this.root, 'references', `${id}.json`), { force: true })
    await rm(join(this.root, 'references', `${id}.wav`), { force: true })
    await rm(join(this.root, 'references', `${id}.mp3`), { force: true })
  }
  error(error: unknown): string {
    const message = error instanceof ChatError ? error.userMessage : 'Official CSM operation failed. Chatterbox remains available.'
    this.state.error = message; this.state.stage = 'Needs attention'; return message
  }
  private start(): ChildProcessWithoutNullStreams {
    if (this.worker) return this.worker
    if (!existsSync(this.python)) throw new ChatError('Install the official CSM runtime in Settings → Voice first.')
    const child = spawn(this.python, ['-u', this.script], { stdio: 'pipe', env: this.env() })
    this.worker = child; this.buffer = ''; this.state.stage = 'Loading official CSM model'; this.state.error = undefined
    child.stderr.on('data', () => {})
    child.stdout.on('data', data => {
      if (child !== this.worker) return
      this.buffer += data.toString()
      if (this.buffer.length > 8 * 1024 * 1024) { this.unload('CSM exceeded the audio output limit.'); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
        let result: Record<string, any>
        try { result = JSON.parse(line) } catch { this.unload('Official CSM returned invalid output.'); return }
        const pending = this.pending
        if (!pending || result.id !== pending.id) continue
        if (!result.ok || typeof result.wav !== 'string') { this.state.error = typeof result.message === 'string' ? result.message : 'Official CSM generation failed.'; this.unload(this.state.error); return }
        const bytes = Buffer.from(result.wav, 'base64')
        if (bytes.length < 44 || bytes.length > 4 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') { this.unload('Official CSM returned invalid WAV audio.'); return }
        this.state = { ...this.state, loaded: true, error: undefined, stage: 'Speech generated with official CSM watermark', device: result.metrics?.device, metrics: result.metrics ? { ...result.metrics, totalMs: Date.now() - pending.startedAt } : undefined }
        this.pending = undefined; pending.clean(); pending.resolve(bytes)
        this.idle = setTimeout(() => this.unload(), 120000); this.idle.unref()
      }
    })
    child.stdin.on('error', () => { if (this.worker === child) this.unload('Official CSM input disconnected.') })
    child.on('error', () => { if (this.worker === child) this.unload('Official CSM could not start. Check its runtime.') })
    child.on('exit', () => { if (this.worker === child) this.unload('Official CSM worker exited. Check memory and dependencies.') })
    return child
  }
  async generate(text: string, _voice: SpeechVoice, _speed: number, signal: AbortSignal, contextKey?: string): Promise<Uint8Array> {
    if (signal.aborted) throw new ChatError('Speech stopped.')
    if (this.job || this.pending || this.preparing) throw new ChatError('Official CSM is busy. Stop the current operation first.')
    this.preparing = true
    const input = prepareLocalSpeech(text, 'sesame-csm-official')
    try {
      if (!input || input.length > 4000) throw new ChatError('Official CSM supports up to 4000 characters per request. Use shorter replies.')
      const settings = this.settings().localVoice.officialCSM
      const referenceId = settings.referenceId ?? await this.ensureAutomaticReference()
      if (signal.aborted) throw new ChatError('Speech stopped.')
      clearTimeout(this.idle)
      const child = this.start(), id = randomUUID()
      const result = new Promise<Uint8Array>((resolve, reject) => {
        const abort = () => { if (this.pending?.id === id) this.unload() }
        const timer = setTimeout(() => { if (this.pending?.id === id) this.unload('Official CSM timed out after ten minutes. No other voice was substituted.') }, 600000)
        this.pending = { id, startedAt: Date.now(), resolve, reject, clean: () => { clearTimeout(timer); signal.removeEventListener('abort', abort) } }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) { abort(); return }
        child.stdin.write(JSON.stringify({ id, text: input, ...settings, referenceId, contextKey: settings.context ? contextKey : undefined }) + '\n', error => { if (error && this.pending?.id === id) this.unload('Official CSM input failed.') })
      })
      this.preparing = false
      return result
    } catch (error) { this.preparing = false; throw error }
  }
  dispose(): void { this.cancel() }
}
