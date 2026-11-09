// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyStudio } from '../electron/main/ai/academyStudio'
import { academyStudioCommandSchema } from '../shared/academyStudio'
import type { LocalModel } from '../shared/localAI'
import type { OllamaService } from '../electron/main/ai/ollamaService'
import type { CodingPracticeRunner } from '../electron/main/ai/codingPractice'
import type { TranscriptionService } from '../electron/main/voice/transcriptionService'
import { randomUUID } from 'node:crypto'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'athena-studio-')); directories.push(path); return path }
const alpha: LocalModel = { name: 'qwen2.5:3b', size: 1, capabilities: ['completion'] }
const beta: LocalModel = { ...alpha, name: 'qwen2.5-coder:3b' }
const ollama = (call: ReturnType<typeof vi.fn>) => ({ call } as unknown as OllamaService)
const answer = (text: string) => new Response(JSON.stringify({ message: { content: text } }))

describe('Phase 7 local Practice & Notes', () => {
  it('uses only local Ollama, stores private meeting notes and retains only transcript-backed points', async () => {
    const path = await directory()
    const call = vi.fn(async (_endpoint: string, _request?: unknown, _signal?: AbortSignal) => answer(JSON.stringify({ summary: 'A draft recap.', decisions: [
      { text: 'Use the new design', quote: 'We approved the new design.' }, { text: 'Invented decision', quote: 'not in the transcript' },
    ], actionItems: [{ text: 'Sam will test it', quote: 'Sam will test it tomorrow.', owner: 'Sam' }] })))
    const service = new AcademyStudio(path, ollama(call))
    const transcript = 'We approved the new design. Sam will test it tomorrow.'
    const note = await service.prepareMeeting(alpha, transcript)
    expect(note).toMatchObject({ model: alpha.name, summary: 'A draft recap.', transcript })
    expect(note.decisions).toHaveLength(1)
    expect(note.actionItems).toHaveLength(1)
    expect(service.meetingMarkdown(note.id)).toContain('Source quote: “Sam will test it tomorrow.”')
    expect(call).toHaveBeenCalledOnce()
    const [endpoint, request] = call.mock.calls[0]
    expect(endpoint).toBe('api/chat')
    expect(request).toMatchObject({ model: alpha.name, stream: false, format: 'json' })
    expect((await readFile(join(path, 'studio.json'), 'utf8'))).toContain(transcript)
    expect(new AcademyStudio(path, ollama(call)).snapshot().meetings[0].id).toBe(note.id)
  })
  it('does not save malformed local output or unsupported models', async () => {
    const path = await directory()
    const call = vi.fn(async () => answer('{not json'))
    const service = new AcademyStudio(path, ollama(call))
    await expect(service.prepareMeeting(alpha, 'The team discussed a release tomorrow.')).rejects.toThrow('invalid meeting-note structure')
    expect(service.snapshot().meetings).toHaveLength(0)
    await expect(service.prepareMeeting({ ...alpha, capabilities: ['embedding'] }, 'The team discussed a release tomorrow.')).rejects.toThrow('chat completion')
    expect(call).toHaveBeenCalledOnce()
    expect(academyStudioCommandSchema.safeParse({ action: 'prepare-meeting', model: alpha.name, transcript: 'short' }).success).toBe(false)
  })
  it('asks one practice question, stores feedback on the original model, and rejects duplicate answers', async () => {
    const path = await directory()
    const replies = ['How would you design a React state boundary?', 'Clear answer; add a concrete tradeoff.']
    const call = vi.fn(async () => answer(replies.shift() ?? ''))
    const service = new AcademyStudio(path, ollama(call))
    const question = await service.startInterview(alpha, 'technical', 'React architecture')
    expect(question).toMatchObject({ model: alpha.name, mode: 'technical', topic: 'React architecture', question: 'How would you design a React state boundary?' })
    expect(question.answer).toBeUndefined()
    await expect(service.answerInterview(beta, question.id, 'Use composition.')).rejects.toThrow('assigned')
    const completed = await service.answerInterview(alpha, question.id, 'Use composition and a stable state owner.')
    expect(completed.feedback).toContain('concrete tradeoff')
    await expect(service.answerInterview(alpha, question.id, 'Replay')).rejects.toThrow('already submitted')
    expect(call).toHaveBeenCalledTimes(2)
    expect(new AcademyStudio(path, ollama(call)).snapshot().interviews[0].feedback).toBe(completed.feedback)
  })
  it('cancels an in-flight local request without recording a fabricated result', async () => {
    const path = await directory()
    const call = vi.fn((_path: string, _request: unknown, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
    const service = new AcademyStudio(path, ollama(call))
    const pending = service.startInterview(alpha, 'practice', 'Algorithms')
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    expect(service.cancel()).toBe(true)
    await expect(pending).rejects.toThrow('cancelled')
    expect(service.snapshot().interviews).toHaveLength(0)
    expect(service.cancel()).toBe(false)
  })
  it('preserves malformed storage and does not overwrite it', async () => {
    const path = await directory()
    await writeFile(join(path, 'studio.json'), '{invalid')
    const service = new AcademyStudio(path, ollama(vi.fn()))
    await expect(service.startInterview(alpha, 'quick', 'TypeScript')).rejects.toThrow('existing file was preserved')
    expect(await readFile(join(path, 'studio.json'), 'utf8')).toBe('{invalid')
  })
  it('deletes only the selected local record', async () => {
    const path = await directory()
    const call = vi.fn(async () => answer('What is a hash map?'))
    const service = new AcademyStudio(path, ollama(call))
    const first = await service.startInterview(alpha, 'quick', 'Hash maps')
    const second = await service.startInterview(beta, 'quick', 'Algorithms')
    service.remove('interview', first.id)
    expect(service.snapshot().interviews.map(item => item.id)).toEqual([second.id])
  })
  it('persists isolated coding evidence per model and migrates older Studio storage', async () => {
    const path = await directory()
    await writeFile(join(path, 'studio.json'), JSON.stringify({ version: 1, meetings: [], interviews: [] }))
    const runner = { run: vi.fn(async (model: string, challenge: string) => ({ id: randomUUID(), model, challenge, createdAt: new Date().toISOString(), passed: 1, total: 2, results: [{ name: 'first', passed: true, detail: '1' }, { name: 'second', passed: false, detail: '0' }] })) } as unknown as CodingPracticeRunner
    const service = new AcademyStudio(path, ollama(vi.fn()), runner)
    const result = await service.runCodingPractice(alpha.name, 'sum-pairs', 'function solve() { return 0 }')
    expect(result).toMatchObject({ passed: 1, total: 2, model: alpha.name })
    expect(service.snapshot().attempts).toHaveLength(1)
    expect(new AcademyStudio(path, ollama(vi.fn())).snapshot().attempts[0].id).toBe(result.id)
    service.remove('coding-attempt', result.id)
    expect(service.snapshot().attempts).toHaveLength(0)
  })
  it('rejects unapproved or oversized meeting audio before transcription', async () => {
    const path = await directory()
    const service = new AcademyStudio(path, ollama(vi.fn()))
    const transcription = { transcribe: vi.fn() } as unknown as TranscriptionService
    await writeFile(join(path, 'invalid.txt'), 'not audio')
    await expect(service.transcribeMeetingAudio(join(path, 'invalid.txt'), transcription)).rejects.toThrow('Choose a WAV')
    expect(transcription.transcribe).not.toHaveBeenCalled()
  })
  it.runIf(process.platform === 'darwin')('decodes explicitly selected audio locally and returns an editable transcript without saving notes', async () => {
    const path = await directory()
    const pcm = Buffer.alloc(16_000 * 2)
    const wav = Buffer.alloc(44 + pcm.length)
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
    wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44)
    const source = join(path, 'authorized.wav'); await writeFile(source, wav)
    const transcription = { transcribe: vi.fn(async () => 'The team agreed to run tests tomorrow.') } as unknown as TranscriptionService
    const service = new AcademyStudio(path, ollama(vi.fn()))
    expect(await service.transcribeMeetingAudio(source, transcription)).toBe('The team agreed to run tests tomorrow.')
    expect(transcription.transcribe).toHaveBeenCalledOnce()
    expect(service.snapshot().meetings).toHaveLength(0)
  })
})
