import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { VoiceClip } from '../../../shared/voice'
import type { Settings } from '../../../shared/settings'
import type { SpeechVoice } from '../../../shared/speech'
import { ChatError } from '../ai/AIProvider'
import type { TranscriptionService } from './transcriptionService'
import type { SpeechService } from './speechService'

const run = promisify(execFile)
const whisperLocations = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp']

async function whisperBinary(explicit?: string): Promise<string> {
  if (explicit) { if (!isAbsolute(explicit) || !(await stat(explicit)).isFile()) throw new ChatError('Select an installed Whisper executable'); return explicit }
  for (const path of whisperLocations) { try { if ((await stat(path)).isFile()) return path } catch { /* try next */ } }
  throw new ChatError('Local speech recognition is unavailable. Install whisper.cpp and configure a GGML model in My Athena → Local AI setup → Local voice.')
}

export class LocalWhisperTranscription implements TranscriptionService {
  constructor(private settings: () => Settings) {}
  async transcribe(clip: VoiceClip, signal: AbortSignal, options?: { language?: string; binary?: string; model?: string }): Promise<string> {
    const selected = this.settings().localAI
    if (selected.speechEngine !== 'whisper-cli' && !options?.model) throw new ChatError('Local speech recognition is disabled in My Athena → Local AI setup → Local voice.')
    const binary = await whisperBinary(options?.binary)
    const model = options?.model || selected.speechModelPath
    if (!isAbsolute(model) || !(await stat(model).catch(() => null))?.isFile()) throw new ChatError('Select an existing local Whisper model file in My Athena → Local AI setup → Local voice.')
    if (clip.mimeType !== 'audio/wav') throw new ChatError('This recording could not be converted to local WAV audio. Please record again.')
    const directory = await mkdtemp(join(tmpdir(), 'athena-whisper-'))
    try {
      const audioPath = join(directory, 'speech.wav'), outputPath = join(directory, 'transcript')
      await writeFile(audioPath, clip.bytes, { mode: 0o600 })
      // A smaller beam keeps short voice commands responsive and avoids
      // unnecessary sustained CPU use without changing the installed model.
      await run(binary, ['-t', '4', '-bs', '3', '-m', model, '-f', audioPath, '-l', options?.language || 'en', '-nt', '-np', '-otxt', '-of', outputPath], { signal, timeout: 90_000, maxBuffer: 64 * 1024 })
      const transcript = (await readFile(`${outputPath}.txt`, 'utf8').catch(() => '')).trim()
      if (!transcript) throw new ChatError('No clear speech was recognized.')
      return transcript
    } catch (error) {
      if (signal.aborted) throw new ChatError('Voice input cancelled.')
      if (error instanceof ChatError) throw error
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
      if (code === 'ENOENT' || code === 'EACCES') throw new ChatError('Local Whisper could not start. Check its installation in My Athena → Local AI setup → Local voice.')
      if (code === 'ETIMEDOUT') throw new ChatError('Speech recognition took too long. Please try a shorter phrase.')
      // whisper.cpp exits non-zero when it cannot decode an utterance. Keep
      // implementation details out of Athena's spoken clarification path.
      throw new ChatError('I could not clearly understand that speech.')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

export class LocalMacSpeech implements SpeechService {
  readonly mimeType = 'audio/wav' as const
  constructor(private settings: () => Settings) {}
  async generate(text: string, _voice: SpeechVoice, speed: number, signal: AbortSignal): Promise<Uint8Array> {
    const directory = await mkdtemp(join(tmpdir(), 'athena-speech-'))
    try {
      const source = join(directory, 'speech.aiff'), result = join(directory, 'speech.wav')
      const voice = this.settings().localAI.speechVoice
      await run('/usr/bin/say', ['-v', voice, '-r', String(Math.round(175 * speed)), '-o', source, text.slice(0, 3800)], { signal, timeout: 60_000, maxBuffer: 4096 })
      signal.throwIfAborted()
      await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', source, result], { signal, timeout: 30_000, maxBuffer: 4096 })
      const bytes = await readFile(result)
      if (bytes.length > 8 * 1024 * 1024) throw new ChatError('Local speech audio exceeded the playback limit.')
      return bytes
    } catch (error) {
      if (signal.aborted) throw new ChatError('Speech stopped.')
      if (error instanceof ChatError) throw error
      throw new ChatError('macOS could not synthesize Athena’s voice. Check the selected system voice in Settings → Voice.')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

export class RoutedTranscription implements TranscriptionService {
  constructor(private settings: () => Settings, private cloud: TranscriptionService, private local: TranscriptionService) {}
  transcribe(clip: VoiceClip, signal: AbortSignal): Promise<string> {
    const settings = this.settings()
    if (settings.aiMode === 'unconfigured') throw new ChatError('Choose an online provider before using online dictation. Floating Athena uses local hands-free voice separately.')
    if (settings.aiMode === 'local' || settings.aiMode === 'subscription') return this.local.transcribe(clip, signal)
    if (settings.strictOffline) throw new ChatError('Strict Offline Mode blocks cloud speech recognition.')
    return this.cloud.transcribe(clip, signal)
  }
}
