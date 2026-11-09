// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { defaultSettings, mergeSettings, restoreSettings } from '../shared/settings'
import { ATHENA_CSM_REFERENCE_ID, officialCSMCommandSchema } from '../shared/officialCSM'
import { SelectedLocalSpeech } from '../electron/main/voice/selectedLocalSpeech'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
import { OfficialCSM } from '../electron/main/voice/officialCSM'
import { shouldWarmSesameWake, wakeAcknowledgementCacheKey } from '../electron/main/voice/wakeAcknowledgement'

function child() {
  const input = Object.assign(new EventEmitter(), { write: vi.fn() })
  const process = Object.assign(new EventEmitter(), { stdin: input, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() })
  process.kill.mockImplementation(() => { process.signalCode = 'SIGTERM'; process.emit('exit', null); process.emit('close', null) })
  return process
}
let root: string, service: OfficialCSM
const workers: ReturnType<typeof child>[] = []
beforeEach(() => {
  mocks.spawn.mockReset(); workers.length = 0; mocks.spawn.mockImplementation(() => { const process = child(); workers.push(process); return process })
  root = mkdtempSync(join(tmpdir(), 'athena-official-csm-'))
  mkdirSync(join(root, 'runtime/bin'), { recursive: true }); writeFileSync(join(root, 'runtime/bin/python3'), '')
  const reference = join(root, 'athena-reference.wav')
  writeFileSync(reference, Buffer.alloc(48))
  service = new OfficialCSM(() => defaultSettings, '/official', '/worker.py', root, reference)
})
afterEach(() => { service.dispose(); rmSync(root, { recursive: true, force: true }) })
function reply(worker: ReturnType<typeof child>, index = 0, ok = true) {
  const request = JSON.parse(worker.stdin.write.mock.calls[index][0])
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.write('WAVE', 8)
  worker.stdout.emit('data', JSON.stringify({ id: request.id, ok, wav: bytes.toString('base64'), message: ok ? undefined : 'Official MPS unsupported', metrics: { device: 'cpu', contextSegments: 0 } }) + '\n')
  return request
}
describe('official CSM', () => {
  it('defaults to Chatterbox and persists independent official settings without changing its reference', () => {
    expect(defaultSettings.localVoice.engine).toBe('chatterbox-turbo')
    const referenceId = crypto.randomUUID()
    const saved = mergeSettings(defaultSettings, { localVoice: { ...defaultSettings.localVoice, engine: 'sesame-csm-official', officialCSM: { device: 'mps', speaker: 1, context: false, referenceId } } })
    const restored = restoreSettings(JSON.parse(JSON.stringify(saved)))
    expect(restored.localVoice).toEqual(saved.localVoice)
    expect(restored.localVoice.profileId).toBe(defaultSettings.localVoice.profileId)
    expect(restored.localVoice.expressiveness).toBe(defaultSettings.localVoice.expressiveness)
  })
  it('prepares one private Sesame wake clip before microphone activation', () => {
    const settings = structuredClone(defaultSettings)
    expect(shouldWarmSesameWake(settings)).toBe(false)
    settings.localVoice.engine = 'sesame-csm-official'
    expect(settings.voiceInteraction.handsFreeEnabled).toBe(false)
    expect(shouldWarmSesameWake(settings)).toBe(true)
    const wakeKey = wakeAcknowledgementCacheKey(settings, "I'm listening.")
    expect(wakeKey).toContain('wake-ack:v3:')
    expect(wakeKey).toContain(ATHENA_CSM_REFERENCE_ID)
    settings.voiceMuted = true
    expect(shouldWarmSesameWake(settings)).toBe(false)
  })
  it('routes only explicit official selection, never falls back after an error', async () => {
    const settings = structuredClone(defaultSettings)
    const chatterbox = { generate: vi.fn(async () => new Uint8Array([1])), dispose: vi.fn() }
    const official = { generate: vi.fn(async () => { throw new Error('gated access') }), dispose: vi.fn() }
    const higgs = { generate: vi.fn(async () => new Uint8Array([3])), dispose: vi.fn() }
    const router = new SelectedLocalSpeech(() => settings, chatterbox, official, higgs), abort = new AbortController()
    await router.generate('Hello', 'coral', 1, abort.signal, 'session-a')
    settings.localVoice.engine = 'sesame-csm-official'
    await expect(router.generate('Hello', 'coral', 1, abort.signal, 'session-b')).rejects.toThrow('gated access')
    expect(chatterbox.generate).toHaveBeenCalledTimes(1); expect(chatterbox.dispose).toHaveBeenCalledOnce()
    expect(official.generate).toHaveBeenCalledWith('Hello', 'coral', 1, abort.signal, 'session-b')
    expect(higgs.generate).not.toHaveBeenCalled()
    settings.localVoice.engine = 'chatterbox-turbo'; await router.generate('Hello', 'coral', 1, abort.signal)
    expect(official.dispose).toHaveBeenCalledOnce()
    router.dispose()
  })
  it('reuses a verified wake WAV across service instances without another CSM generation', async () => {
    const settings = structuredClone(defaultSettings)
    settings.localVoice.engine = 'sesame-csm-official'
    const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8)
    const official = { generate: vi.fn(async () => wav), dispose: vi.fn() }
    const chatterbox = { generate: vi.fn(async () => new Uint8Array([1])), dispose: vi.fn() }
    const directory = join(root, 'wake-cache')
    const key = 'wake-ack:v3:stable-sesame-profile'
    const unused = { generate: vi.fn(async () => new Uint8Array([3])), dispose: vi.fn() }
    const first = new SelectedLocalSpeech(() => settings, chatterbox, official, unused, directory)
    const generated = await first.generateCached("I'm listening.", 'coral', 1, new AbortController().signal, key)
    expect(generated.cached).toBe(false)
    first.dispose()
    const second = new SelectedLocalSpeech(() => settings, chatterbox, official, unused, directory)
    const restored = await second.generateCached("I'm listening.", 'coral', 1, new AbortController().signal, key)
    expect(restored.cached).toBe(true)
    expect(restored.bytes).toEqual(wav)
    expect(official.generate).toHaveBeenCalledTimes(1)
    second.dispose()
  })
  it('uses one offline stdio worker and passes distinct conversation keys and exact speaker settings', async () => {
    const first = service.generate('[chuckle] Hello.', 'coral', 1, new AbortController().signal, 'session-a')
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    expect(reply(workers[0])).toMatchObject({ text: 'Hello.', device: 'cpu', speaker: 0, contextKey: 'session-a', referenceId: ATHENA_CSM_REFERENCE_ID })
    await expect(first).resolves.toHaveLength(48)
    const second = service.generate('Second.', 'coral', 1, new AbortController().signal, 'session-b')
    await vi.waitFor(() => expect(workers[0].stdin.write).toHaveBeenCalledTimes(2))
    expect(reply(workers[0], 1)).toMatchObject({ contextKey: 'session-b' }); await second
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({ HF_HUB_OFFLINE: '1', NO_TORCH_COMPILE: '1' })
    expect((await service.status()).references).toEqual([expect.objectContaining({ id: ATHENA_CSM_REFERENCE_ID, speaker: 0 })])
  })
  it('cancels, rejects overlap, ignores late old-worker output and preserves device errors', async () => {
    const abort = new AbortController(), first = service.generate('First', 'coral', 1, abort.signal)
    await expect(service.generate('Overlap', 'coral', 1, abort.signal)).rejects.toThrow('busy')
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    abort.abort(); await expect(first).rejects.toThrow('cancelled')
    const second = service.generate('Second', 'coral', 1, new AbortController().signal)
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    reply(workers[0]); reply(workers[1], 0, false)
    await expect(second).rejects.toThrow('MPS unsupported')
    expect((await service.status()).loaded).toBe(false)
  })
  it('fails clearly rather than generating an unanchored random voice when no reference exists', async () => {
    const missing = new OfficialCSM(() => defaultSettings, '/official', '/worker.py', root, join(root, 'absent.wav'))
    await expect(missing.generate('Hello', 'coral', 1, new AbortController().signal)).rejects.toThrow('needs a matching voice recording')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('requires reference authorization, transcripts and safe IDs', () => {
    expect(officialCSMCommandSchema.safeParse({ action: 'import-reference', transcript: 'Hi', speaker: 0, authorized: false }).success).toBe(false)
    expect(officialCSMCommandSchema.safeParse({ action: 'import-reference', transcript: ' ', speaker: 0, authorized: true }).success).toBe(false)
    expect(officialCSMCommandSchema.safeParse({ action: 'remove-reference', id: '../../chatterbox' }).success).toBe(false)
  })
  it('preserves the cloned official implementation and its built-in watermark', () => {
    const expected = { 'generator.py': 'aba5e081ebd374a5515ae1abbe7baf6047e748d3f48d8a13564c104822311f33', 'models.py': '68ce09b6d04f123d087d4fadd1f259568b9b57f0ebc44c3597b646d47ed9b250', 'watermarking.py': 'c6a8e9e1ddae00bf67420f823b9b825abd0e243acfa295a19cfdabdc9142b6d4' }
    for (const [file, hash] of Object.entries(expected)) expect(createHash('sha256').update(readFileSync(`vendor/sesame-csm-official/${file}`)).digest('hex')).toBe(hash)
    const worker = readFileSync('voice-service/official_csm.py', 'utf8')
    expect(worker).toContain('load_csm_1b(device=device)'); expect(worker).toContain('MODEL.generate('); expect(worker).toContain('Segment(')
    expect(worker).not.toContain('from mlx'); expect(worker).not.toContain('ChatterboxSpeech')
  })
})
