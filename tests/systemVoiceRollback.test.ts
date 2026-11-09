// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LocalMacSpeech } from '../electron/main/voice/localVoiceServices'
import { ChatterboxSpeech } from '../electron/main/voice/chatterboxSpeech'
import { resolve } from 'node:path'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { OllamaProvider } from '../electron/main/ai/OllamaProvider'
import { ChatController } from '../electron/main/ai/chatController'
import { defaultSettings } from '../shared/settings'

describe('neural voice rollback', () => {
  it('preserves the original Chatterbox voice without a system fallback or legacy MLX manager', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.build.extraResources[0].filter).toContain('chatterbox.py')
    expect(pkg.build.extraResources[0].filter).not.toContain('**/*')
    const main = readFileSync('electron/main/main.ts', 'utf8')
    expect(main).toContain('new ChatterboxSpeech(')
    expect(main).not.toContain('new LocalMacSpeech(')
    expect(main).not.toContain('LocalVoiceManager')
    expect(main).not.toContain('LocalOnlySpeech')
  })
  it.runIf(process.env.ATHENA_CHATTERBOX_LIVE_TEST === '1')('generates the original natural voice using the existing reference and supports cancellation/reload', async () => {
    const voice = new ChatterboxSpeech(() => defaultSettings, resolve('voice-service/chatterbox.py'))
    const text = "Hey, I'm Athena. It's good to hear from you again."
    try {
      const started = Date.now()
      const bytes = await voice.generate(text, 'coral', 1, new AbortController().signal)
      expect(Buffer.from(bytes).toString('ascii', 0, 4)).toBe('RIFF')
      expect(bytes.length).toBeGreaterThan(24000)
      const abort = new AbortController()
      const pending = voice.generate('This generation is being interrupted.', 'coral', 1, abort.signal)
      abort.abort()
      await expect(pending).rejects.toThrow('Speech stopped')
      const next = await voice.generate('Welcome back. How can I help?', 'coral', 1, new AbortController().signal)
      expect(next.length).toBeGreaterThan(24000)
      expect(Buffer.from(next).equals(Buffer.from(bytes))).toBe(false)
      console.log('Natural voice restored:', { engine: 'chatterbox-turbo', reference: 'athena-youthful-us-v3.mp3', bytes: bytes.length, reloadBytes: next.length, elapsedMs: Date.now() - started })
    } finally { voice.dispose() }
  }, 180000)
  it.runIf(process.env.ATHENA_SYSTEM_VOICE_LIVE_TEST === '1')('answers distinct spoken requests with local Ollama and synthesizes each actual answer', async () => {
    const service = new OllamaService(() => 'http://127.0.0.1:11434')
    const model = await service.modelDetails('qwen2.5-coder:3b')
    const provider = new OllamaProvider(service, model.name, { ...defaultSettings.localAI, model: model.name, contextLength: 4096, maxOutputTokens: 256, temperature: 0, keepAliveMinutes: 1 }, model)
    const controller = new ChatController({ provider: async () => provider, origin: 'athena-local', effectiveModel: () => model.name, phase: () => {}, changed: () => {} })
    const speech = new LocalMacSpeech(() => defaultSettings)
    try {
      const first = await controller.answerHandsFree({ text: 'What is the capital of France? Answer with the city name only.' })
      const second = await controller.answerHandsFree({ text: 'What is the capital of Japan? Answer with the city name only.' })
      expect(first.ok).toBe(true); expect(second.ok).toBe(true)
      expect(first.text).toMatch(/Paris/i); expect(second.text).toMatch(/Tokyo/i)
      expect(first.text).not.toBe(second.text)
      for (const response of [first, second]) {
        expect(response.text).not.toMatch(/choose|select.*option/i)
        const bytes = await speech.generate(response.text!, 'coral', 1, new AbortController().signal)
        expect(Buffer.from(bytes).toString('ascii', 0, 4)).toBe('RIFF')
        expect(bytes.length).toBeGreaterThan(1000)
      }
      console.log('Local voice verification:', { first: first.text, second: second.text, speech: 'macOS WAV' })
    } finally { controller.dispose() }
  }, 120000)
})
