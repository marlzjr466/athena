import type { Settings } from '../../../shared/settings'
import type { SpeechVoice } from '../../../shared/speech'
import type { SpeechService } from './speechService'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Engine extends SpeechService { dispose(): void }
/** Only routes explicitly selected engines. Legacy MLX Sesame settings remain inert. */
export class SelectedLocalSpeech implements SpeechService {
  readonly mimeType = 'audio/wav' as const
  private selected?: Engine
  private selectedKey?: string
  private readonly cached = new Map<string, Uint8Array>()
  private readonly pendingCached = new Map<string, Promise<{ bytes: Uint8Array; cached: boolean }>>()
  private lane: Promise<void> = Promise.resolve()
  constructor(private settings: () => Settings, private chatterbox: Engine, private official: Engine, private higgs: Engine, private cacheDirectory?: string) {}
  private selectionKey(): string {
    const settings = this.settings().localVoice
    return JSON.stringify({
      engine: settings.engine,
      profileId: settings.profileId,
      style: settings.style,
      expressiveness: settings.expressiveness,
      officialCSM: settings.officialCSM,
      higgs: settings.higgs,
    })
  }
  private engine(): Engine {
    // `sesame-csm` is the legacy value written by the removed community/MLX
    // integration. Treat it as the official CSM selection so an existing
    // user's explicit Sesame choice cannot silently route to Chatterbox.
    const engine = this.settings().localVoice.engine
    if (engine === 'sesame-csm' || engine === 'sesame-csm-official') return this.official
    if (engine === 'higgs-tts-3-4b') return this.higgs
    return this.chatterbox
  }
  private select(engine: Engine): Engine {
    const key = this.selectionKey()
    if (this.selected && (this.selected !== engine || this.selectedKey !== key)) {
      this.selected.dispose()
      this.cached.clear()
    }
    this.selected = engine
    this.selectedKey = key
    return engine
  }
  async generate(text: string, voice: SpeechVoice, speed: number, signal: AbortSignal, contextKey?: string): Promise<Uint8Array> {
    const requestedSelection = this.selectionKey()
    const previous = this.lane
    let release!: () => void
    this.lane = new Promise<void>(resolve => { release = resolve })
    try {
      await previous
      if (signal.aborted || requestedSelection !== this.selectionKey()) throw new Error('Speech stopped or voice settings changed.')
      const bytes = await this.select(this.engine()).generate(text, voice, speed, signal, contextKey)
      if (signal.aborted || requestedSelection !== this.selectionKey()) throw new Error('Speech stopped or voice settings changed.')
      return bytes
    } finally { release() }
  }
  private validWav(bytes: Uint8Array): boolean {
    const buffer = Buffer.from(bytes)
    return buffer.length >= 44 && buffer.length <= 4 * 1024 * 1024
      && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE'
  }
  private cachePath(cacheKey: string): string | undefined {
    if (!this.cacheDirectory || !cacheKey.startsWith('wake-ack:v3:')) return undefined
    return join(this.cacheDirectory, `${createHash('sha256').update(cacheKey).digest('hex')}.wav`)
  }
  async generateCached(text: string, voice: SpeechVoice, speed: number, signal: AbortSignal, cacheKey: string, contextKey?: string): Promise<{ bytes: Uint8Array; cached: boolean }> {
    if (signal.aborted) throw new Error('Speech stopped.')
    this.select(this.engine())
    const existing = this.cached.get(cacheKey)
    if (existing) return { bytes: existing.slice(), cached: true }
    let pending = this.pendingCached.get(cacheKey)
    const joined = Boolean(pending)
    if (!pending) {
      pending = (async () => {
        const path = this.cachePath(cacheKey)
        if (path) {
          const stored = await readFile(path).catch(() => undefined)
          if (stored && this.validWav(stored)) {
            this.cached.set(cacheKey, stored)
            return { bytes: stored, cached: true }
          }
        }
        const bytes = await this.generate(text, voice, speed, signal, contextKey)
        if (bytes.length) {
          this.cached.set(cacheKey, bytes.slice())
          while (this.cached.size > 12) this.cached.delete(this.cached.keys().next().value!)
          if (path && this.validWav(bytes)) {
            const temp = `${path}.${randomUUID()}.tmp`
            try { await mkdir(this.cacheDirectory!, { recursive: true, mode: 0o700 }); await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path) }
            catch { /* Failure to persist a speed cache must not fail genuine speech. */ }
          }
        }
        return { bytes, cached: false }
      })()
      this.pendingCached.set(cacheKey, pending)
      void pending.finally(() => { if (this.pendingCached.get(cacheKey) === pending) this.pendingCached.delete(cacheKey) }).catch(() => {})
    }
    const result = await pending
    if (signal.aborted) throw new Error('Speech stopped.')
    return { bytes: result.bytes.slice(), cached: result.cached || joined }
  }
  dispose(): void { this.cached.clear(); this.pendingCached.clear(); this.chatterbox.dispose(); this.official.dispose(); this.higgs.dispose(); this.selected = undefined; this.selectedKey = undefined }
}
