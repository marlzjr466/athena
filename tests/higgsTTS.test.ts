// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings } from '../shared/settings'
import { higgsCommandSchema } from '../shared/higgsTTS'
import { HiggsTTS } from '../electron/main/voice/higgsTTS'
import { shouldWarmLocalWake, wakeAcknowledgementCacheKey } from '../electron/main/voice/wakeAcknowledgement'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

function child() {
  const input = Object.assign(new EventEmitter(), { write: vi.fn() })
  const process = Object.assign(new EventEmitter(), { stdin: input, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() })
  process.kill.mockImplementation(() => { process.signalCode = 'SIGTERM'; process.emit('exit', null); process.emit('close', null) })
  return process
}
let root: string, service: HiggsTTS
const workers: ReturnType<typeof child>[] = []
beforeEach(() => {
  mocks.spawn.mockReset(); workers.length = 0; mocks.spawn.mockImplementation(() => { const process = child(); workers.push(process); return process })
  root = mkdtempSync(join(tmpdir(), 'athena-higgs-'))
  mkdirSync(join(root, 'runtime/bin'), { recursive: true }); writeFileSync(join(root, 'runtime/bin/python3'), '')
  writeFileSync(join(root, 'downloaded.json'), JSON.stringify({ source: 'bosonai/higgs-tts-3-4b' }))
  service = new HiggsTTS(() => {
    const settings = structuredClone(defaultSettings)
    settings.localVoice.engine = 'higgs-tts-3-4b'
    return settings
  }, '/worker.py', '/requirements-higgs.txt', root)
})
afterEach(() => { service.dispose(); rmSync(root, { recursive: true, force: true }) })
function reply(worker: ReturnType<typeof child>, index = 0, ok = true) {
  const request = JSON.parse(worker.stdin.write.mock.calls[index][0])
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.write('WAVE', 8)
  worker.stdout.emit('data', JSON.stringify({ id: request.id, ok, wav: bytes.toString('base64'), message: ok ? undefined : 'insufficient unified memory', metrics: { device: 'mps', firstAudioMs: 12, generationMs: 12 } }) + '\n')
  return request
}
describe('official Higgs TTS 3', () => {
  it('persists the compatibility blocker and prevents both generation and costly downloads', async () => {
    writeFileSync(join(root, 'runtime-ready.json'), '{}')
    writeFileSync(join(root, 'compatibility.json'), JSON.stringify({ compatible: false, message: 'Unsupported architecture higgs_multimodal_qwen3' }))
    expect(await service.status()).toMatchObject({ runtime: true, compatible: false, loaded: false })
    await expect(service.download()).rejects.toThrow('Unsupported architecture')
    await expect(service.generate('Hello', 'coral', 1, new AbortController().signal)).rejects.toThrow('Unsupported architecture')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('warms cached Higgs acknowledgements without changing the selected engine', () => {
    const settings = structuredClone(defaultSettings)
    expect(shouldWarmLocalWake(settings)).toBe(false)
    settings.localVoice.engine = 'higgs-tts-3-4b'
    expect(shouldWarmLocalWake(settings)).toBe(true)
    expect(wakeAcknowledgementCacheKey(settings, "I'm listening.")).toContain('higgs-tts-3-4b')
  })
  it('sends official control tokens and Higgs-only settings to one offline worker', async () => {
    const first = service.generate("Oh, really? That's actually pretty funny!", 'coral', 1, new AbortController().signal, 'athena-local:session')
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    const request = reply(workers[0])
    expect(request.text).toContain('<|sfx:laughter|>')
    expect(request.device).toBe('mps')
    expect(request.language).toBe('en')
    await expect(first).resolves.toHaveLength(48)
    expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({ HF_HUB_OFFLINE: '1', ATHENA_HIGGS_ROOT: root })
  })
  it('reports memory errors instead of switching engines and requires authorization for references', async () => {
    const pending = service.generate('Hello', 'coral', 1, new AbortController().signal)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    reply(workers[0], 0, false)
    await expect(pending).rejects.toThrow('memory')
    expect((await service.status()).loaded).toBe(false)
    expect(higgsCommandSchema.safeParse({ action: 'import-reference', transcript: 'Hi', authorized: false }).success).toBe(false)
    expect(higgsCommandSchema.safeParse({ action: 'remove-reference', id: '../../chatterbox' }).success).toBe(false)
  })
  it('keeps the adapter free of SGLang, MLX, Chatterbox, and Sesame runtimes', () => {
    const worker = readFileSync('voice-service/higgs_tts.py', 'utf8')
    expect(worker).toContain('bosonai/higgs-tts-3-4b')
    expect(worker).toContain('trust_remote_code=True')
    expect(worker).not.toMatch(/^\s*(?:import|from)\s+sglang/m)
    expect(worker).not.toContain('from mlx')
    expect(worker).not.toContain('ChatterboxSpeech')
    expect(worker).not.toContain('load_csm_1b')
    expect(readFileSync('voice-service/requirements-higgs.txt', 'utf8')).not.toContain('sglang')
  })
})
