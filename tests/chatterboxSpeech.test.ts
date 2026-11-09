// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../shared/settings'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
import { ChatterboxSpeech } from '../electron/main/voice/chatterboxSpeech'

let root: string, service: ChatterboxSpeech
const workers: Array<ReturnType<typeof worker>> = []
function worker() {
  const child = Object.assign(new EventEmitter(), { killed: false, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: vi.fn() }, kill: vi.fn() })
  child.kill.mockImplementation(() => { child.killed = true })
  return child
}
function reply(child: ReturnType<typeof worker>) {
  const request = JSON.parse(child.stdin.write.mock.calls[0][0])
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.write('WAVE', 8)
  child.stdout.emit('data', JSON.stringify({ id: request.id, ok: true, wav: bytes.toString('base64') }) + '\n')
  return request
}
beforeEach(() => {
  mocks.spawn.mockReset(); workers.length = 0; mocks.spawn.mockImplementation(() => { const child = worker(); workers.push(child); return child })
  root = mkdtempSync(join(tmpdir(), 'athena-chatterbox-test-'))
  for (const folder of ['runtime/bin', 'chatterbox-turbo', 'profiles']) mkdirSync(join(root, folder), { recursive: true })
  for (const file of ['runtime/bin/python3', 'chatterbox-turbo/model.safetensors', 'profiles/athena-youthful-us-v3.mp3']) writeFileSync(join(root, file), 'fixture')
  service = new ChatterboxSpeech(() => defaultSettings, '/test/chatterbox.py', root)
})
afterEach(() => { service.dispose(); rmSync(root, { recursive: true, force: true }) })
describe('original Chatterbox speech', () => {
  it('uses the exact original reference and keeps a single offline worker warm', async () => {
    const first = service.generate('Hello there.', 'coral', 1, new AbortController().signal)
    expect(reply(workers[0])).toMatchObject({ text: 'Hello there.', expressiveness: .65, reference: join(root, 'profiles/athena-youthful-us-v3.mp3') })
    await expect(first).resolves.toHaveLength(48)
    const second = service.generate('Good morning.', 'coral', 1, new AbortController().signal)
    const request = JSON.parse(workers[0].stdin.write.mock.calls[1][0])
    workers[0].stdout.emit('data', JSON.stringify({ id: request.id, ok: false }) + '\n')
    await expect(second).rejects.toThrow('Chatterbox')
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({ HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' })
  })
  it('cancels independently and ignores delayed output from the old worker', async () => {
    const abort = new AbortController()
    const first = service.generate('One.', 'coral', 1, abort.signal)
    abort.abort(); await expect(first).rejects.toThrow('Speech stopped')
    expect(workers[0].kill).toHaveBeenCalledWith('SIGTERM')
    const next = service.generate('Two.', 'coral', 1, new AbortController().signal)
    reply(workers[0]); reply(workers[1])
    await expect(next).resolves.toHaveLength(48)
  })
  it('rejects overlap and missing references without falling back to macOS', async () => {
    const first = service.generate('One.', 'coral', 1, new AbortController().signal)
    await expect(service.generate('Two.', 'coral', 1, new AbortController().signal)).rejects.toThrow('already preparing')
    reply(workers[0]); await first
    service.dispose()
    rmSync(join(root, 'profiles/athena-youthful-us-v3.mp3'))
    await expect(service.generate('Three.', 'coral', 1, new AbortController().signal)).rejects.toThrow('reference is missing')
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })
})
