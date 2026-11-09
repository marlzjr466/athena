import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Settings } from '../../../shared/settings'
import type { SpeechVoice } from '../../../shared/speech'
import { deliveryStyle, prepareLocalSpeech } from '../../../shared/localVoice'
import { ChatError } from '../ai/AIProvider'
import type { SpeechService } from './speechService'

interface Pending { id: string; resolve(bytes: Uint8Array): void; reject(error: Error): void; cleanup(): void }

/** Original Chatterbox voice, with the existing US Amy reference. No Sesame or system-voice fallback. */
export class ChatterboxSpeech implements SpeechService {
  readonly mimeType = 'audio/wav' as const
  private worker?: ChildProcessWithoutNullStreams
  private pending?: Pending
  private buffer = ''
  private idle?: ReturnType<typeof setTimeout>
  constructor(private settings: () => Settings, private script: string, private root = join(homedir(), '.athena', 'models', 'tts')) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.worker && !this.worker.killed && this.worker.exitCode === null) return this.worker
    const python = join(this.root, 'runtime', 'bin', 'python3')
    if (!existsSync(python) || !existsSync(join(this.root, 'chatterbox-turbo', 'model.safetensors'))) throw new ChatError('The installed Chatterbox voice files are missing. Restore the local voice runtime/model; Athena will not switch to a system voice.')
    const worker = spawn(python, ['-u', this.script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ATHENA_TTS_ROOT: this.root, HF_HOME: join(this.root, 'hub'), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4', VECLIB_MAXIMUM_THREADS: '4' } })
    this.worker = worker; this.buffer = ''
    worker.stderr.on('data', () => { /* Drain library diagnostics; never forward private speech or local paths. */ })
    worker.stdout.on('data', chunk => {
      if (this.worker !== worker) return
      this.buffer += chunk.toString('utf8')
      if (this.buffer.length > 16 * 1024 * 1024) { this.stop('Natural voice output exceeded the audio limit.'); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
        let result: { id?: string; ok?: boolean; wav?: string }
        try { result = JSON.parse(line) } catch { this.stop('The natural voice worker returned invalid audio.'); return }
        const pending = this.pending
        if (!pending || result.id !== pending.id) continue
        if (!result.ok || typeof result.wav !== 'string') { this.stop('Chatterbox could not generate this speech. Check its installed files and try Preview Voice.'); return }
        const bytes = Buffer.from(result.wav, 'base64')
        if (bytes.length < 44 || bytes.length > 8 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') { this.stop('Chatterbox returned invalid WAV audio.'); return }
        this.pending = undefined; pending.cleanup(); pending.resolve(bytes)
        this.idle = setTimeout(() => this.stop(), 120000); this.idle.unref()
      }
    })
    worker.on('error', () => { if (this.worker === worker) this.stop('The natural voice runtime could not start.') })
    worker.on('exit', () => { if (this.worker === worker) this.stop('The natural voice worker stopped. Try Preview Voice again.') })
    return worker
  }

  async generate(text: string, _voice: SpeechVoice, _speed: number, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new ChatError('Speech stopped.')
    if (this.pending) throw new ChatError('Athena is already preparing speech. Stop speaking before starting another preview.')
    clearTimeout(this.idle); this.idle = undefined
    const preferences = this.settings().localVoice
    const profile = preferences.profileId
    if (profile !== 'athena-youthful' && !/^[a-f0-9-]{36}$/.test(profile)) throw new ChatError('The selected natural voice profile is invalid.')
    const file = join(this.root, 'profiles', profile === 'athena-youthful' ? 'athena-youthful-us-v3.mp3' : `${profile}.wav`)
    if (!existsSync(file) || !realpathSync(file).startsWith(realpathSync(join(this.root, 'profiles')) + sep)) throw new ChatError('The original natural voice reference is missing. Restore the selected profile; Athena will not substitute a different voice.')
    const spoken = prepareLocalSpeech(text, 'chatterbox-turbo')
    if (!spoken || spoken.length > 4000) throw new ChatError('Speech must contain between 1 and 4000 characters.')
    const worker = this.start(), id = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = () => { if (this.pending?.id === id) this.stop() }
      const timer = setTimeout(() => { if (this.pending?.id === id) this.stop('Natural voice generation timed out.') }, 120000)
      this.pending = { id, resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort) } }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      worker.stdin.write(JSON.stringify({ id, text: spoken, reference: file, expressiveness: preferences.expressiveness, style: deliveryStyle(text, preferences.style) }) + '\n', error => { if (error && this.pending?.id === id) this.stop('The natural voice worker disconnected.') })
    })
  }

  stop(message = 'Speech stopped.'): void {
    clearTimeout(this.idle); this.idle = undefined
    const worker = this.worker, pending = this.pending
    this.worker = undefined; this.pending = undefined; this.buffer = ''
    if (worker && !worker.killed) worker.kill('SIGTERM')
    if (pending) { pending.cleanup(); pending.reject(new ChatError(message)) }
  }
  dispose(): void { this.stop() }
}
