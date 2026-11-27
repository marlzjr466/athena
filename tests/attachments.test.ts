// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { ChatContextService, relevantText } from '../electron/main/ai/chatContextService'
import { ChatController } from '../electron/main/ai/chatController'
import { defaultSettings } from '../shared/settings'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const encoder = new TextEncoder()
const hooks = () => ({ provider: async () => ({ testConnection: async () => true, streamMessage: async function* () { yield { type: 'done' as const } } }), changed: vi.fn(), phase: vi.fn() })
describe('local attachments and session authorization', () => {
  it('stores long pasted text locally without file permission and preserves it through provider preparation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athena-pasted-text-'))
    const service = new AttachmentService(directory, () => false, () => { throw new Error() })
    const chat = new ChatController(hooks()), sessionId = chat.snapshot().sessionId!
    const context = new ChatContextService(chat, service, new WorkspaceService(() => false), { files: async () => [], folder: async () => undefined }, () => false)
    const text = 'const answer = 42;\n'.repeat(1600)
    const imported = await context.run({ action: 'import-pasted', sessionId, name: 'Pasted code.ts', text })
    expect(imported).toEqual({ ok: true })
    const attachment = chat.snapshot().attachments![0]
    expect(attachment.origin).toBe('paste')
    expect((await context.run({ action: 'preview', sessionId, id: attachment.id })).text).toBe(text)
    const prepared = await context.prepare(chat.current(), [{ id: randomUUID(), role: 'user', content: 'Review this', status: 'complete', createdAt: 1, attachments: [attachment] }], new AbortController().signal)
    expect(prepared.attachments[0].data).toContain('const answer = 42;')
    expect(prepared.notice).toContain('excerpted')
    chat.dispose()
  })
  it('delivers a complete active pasted task specification even when a code excerpt would be shortened', async () => {
    const directory = await mkdtemp(join(tmpdir(),'athena-task-instructions-'))
    const store = new AttachmentService(directory, () => false, () => { throw Error() })
    const chat = new ChatController(hooks()), id = chat.current().id
    try {
      const context = new ChatContextService(chat,store,new WorkspaceService(()=>false),{files:async()=>[],folder:async()=>undefined},()=>false)
      const text = 'Retain each task constraint.\n'.repeat(1700) + 'Verify the authenticated endpoint last.'
      expect((await context.run({action:'import-pasted',sessionId:id,name:'Provisioning instructions.md',text})).ok).toBe(true)
      const result = await context.prepare(chat.current(),[{id:randomUUID(),role:'user',status:'complete',createdAt:1,content:'Implement this specification.',attachments:chat.snapshot().attachments}],new AbortController().signal)
      expect(result.attachments[0].data).toBe(text)
    } finally { chat.dispose(); await rm(directory,{recursive:true,force:true}) }
  })
  it('persists source/CSV and extracted documents with UUID storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athena-attachments-')), parser = vi.fn(async () => 'Extracted document text')
    const service = new AttachmentService(directory, () => true, () => { throw new Error() }, parser), id = randomUUID()
    for (const name of ['notes.md', 'source.tsx', 'data.csv', 'letter.docx', 'report.pdf']) {
      const file = await service.import(id, name, encoder.encode(name.endsWith('.pdf') ? '%PDF-1.7 file' : 'File contents'))
      expect(file.id).not.toContain(name)
      const restored = await new AttachmentService(directory, () => true, () => { throw new Error() }, parser).preview(id, file)
      expect(restored.text).toBe(/pdf|docx/.test(name) ? 'Extracted document text' : 'File contents')
      await expect(service.preview(randomUUID(), file)).rejects.toThrow()
    }
    expect(parser).toHaveBeenCalledTimes(2)
  })
  it('passes a complete 41-section review document through Antigravity preparation', async () => {
    const service = new AttachmentService(await mkdtemp(join(tmpdir(), 'athena-review-')), () => true, () => { throw new Error() })
    const chat = new ChatController(hooks()), session = chat.current()
    session.config.model = 'gemini-4-argon'
    const context = new ChatContextService(chat, service, new WorkspaceService(() => true), { files: async () => [], folder: async () => undefined }, () => true,
      undefined, undefined, undefined, undefined, undefined, undefined, () => ({ ...defaultSettings, aiMode: 'antigravity' }))
    const full = Array.from({ length: 41 }, (_, index) => `SECTION ${index + 1}: ${'Review this detail. '.repeat(39)}`).join('\n')
    const attachment = await service.import(session.id, 'review.txt', encoder.encode(full))
    const messages = [{ id: randomUUID(), role: 'user' as const, content: 'Please review the attached content.', status: 'complete' as const, createdAt: 1, attachments: [attachment] }]
    const prepared = await context.prepare(session, messages, new AbortController().signal)
    expect(prepared.attachments[0].data).toBe(full)
    expect(prepared.notice).not.toContain('excerpted')
    chat.dispose()
  })
  it('preserves a 131,193-byte pasted attachment for Antigravity instead of rejecting it at 120,000 bytes', async () => {
    const service = new AttachmentService(await mkdtemp(join(tmpdir(), 'athena-large-paste-')), () => false, () => { throw new Error() })
    const chat = new ChatController(hooks()), session = chat.current()
    session.config.model = 'gemini-4-argon'
    const context = new ChatContextService(chat, service, new WorkspaceService(() => false), { files: async () => [], folder: async () => undefined }, () => false,
      undefined, undefined, undefined, undefined, undefined, undefined, () => ({ ...defaultSettings, aiMode: 'antigravity' }))
    const full = 'L'.repeat(131_193)
    const attachment = await service.importPastedText(session.id, 'Pasted code.log', full)
    const messages = [{ id: randomUUID(), role: 'user' as const, content: 'This is the response', status: 'complete' as const, createdAt: 1, attachments: [attachment] }]
    const prepared = await context.prepare(session, messages, new AbortController().signal)
    expect(prepared.attachments[0].data).toBe(full)
    expect(prepared.notice).not.toContain('excerpted')
    chat.dispose()
  })
  it('validates types, sizes, credential names, binary and malformed UTF-8', async () => {
    const service = new AttachmentService(await mkdtemp(join(tmpdir(), 'athena-file-validation-')), () => true, () => { throw new Error() }), id = randomUUID()
    for (const [name, bytes] of [['program.exe', encoder.encode('data')], ['.env', encoder.encode('TOKEN=private')], ['binary.txt', new Uint8Array([0])], ['invalid.txt', new Uint8Array([255])], ['empty.txt', new Uint8Array()], ['huge.txt', new Uint8Array(21 * 1024 * 1024)], ['wrong.png', encoder.encode('not an image')]] as const) await expect(service.import(id, name, bytes)).rejects.toThrow()
  })
  it('normalizes images, enforces dimensions, and rechecks permission on preview', async () => {
    let allowed = true
    const bytes = Buffer.from([137,80,78,71,13,10,26,10,1]), decode = vi.fn(() => ({ png: bytes, width: 20, height: 20 }))
    const service = new AttachmentService(await mkdtemp(join(tmpdir(), 'athena-image-')), () => allowed, decode), id = randomUUID()
    const image = await service.import(id, 'test.png', bytes)
    expect((await service.preview(id, image)).preview).toContain('data:image/png;base64,')
    allowed = false; await expect(service.prepare(id, image)).rejects.toThrow('Personal File Access')
    allowed = true; decode.mockReturnValue({ png: bytes, width: 10000, height: 10000 })
    await expect(service.import(id, 'too-large.png', bytes)).rejects.toThrow('32 megapixels')
  })
  it('cannot preview another session’s attachment or pass arbitrary renderer paths', async () => {
    const service = new AttachmentService(await mkdtemp(join(tmpdir(), 'athena-context-')), () => true, () => { throw new Error() })
    const chat = new ChatController(hooks()), first = chat.snapshot().sessionId!
    const context = new ChatContextService(chat, service, new WorkspaceService(() => true), { files: async () => [], folder: async () => undefined }, () => true)
    expect((await context.run({ action: 'import', sessionId: first, name: 'notes.txt', bytes: encoder.encode('private notes') })).ok).toBe(true)
    const attachment = chat.snapshot().attachments![0]
    expect((await context.run({ action: 'preview', sessionId: first, id: attachment.id })).text).toBe('private notes')
    chat.command({ action: 'create' })
    expect((await context.run({ action: 'preview', sessionId: chat.snapshot().sessionId, id: attachment.id })).ok).toBe(false)
    expect((await context.run({ action: 'import', sessionId: first, name: 'file.txt', path: '/etc/passwd', bytes: encoder.encode('test') })).ok).toBe(false)
    chat.dispose()
  })
  it('saves the selected conversation attachment through the user-selected destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athena-download-'))
    const service = new AttachmentService(directory, () => true, () => { throw new Error() })
    const chat = new ChatController(hooks()), sessionId = chat.snapshot().sessionId!
    const destination = join(directory, 'saved-notes.md')
    const saveFile = vi.fn(async () => destination)
    const context = new ChatContextService(chat, service, new WorkspaceService(() => true), { files: async () => [], folder: async () => undefined, saveFile }, () => true)
    expect((await context.run({ action: 'import', sessionId, name: 'notes.md', bytes: encoder.encode('# Saved notes') })).ok).toBe(true)
    const id = chat.snapshot().attachments![0].id
    expect(await context.run({ action: 'download', sessionId, id })).toMatchObject({ ok: true, saved: true })
    expect(saveFile).toHaveBeenCalledWith('notes.md')
    expect(await readFile(destination, 'utf8')).toBe('# Saved notes')
    chat.command({ action: 'create' })
    expect((await context.run({ action: 'download', sessionId: chat.snapshot().sessionId, id })).ok).toBe(false)
    chat.dispose()
  })
  it('reuses attachments on follow-ups and gates vision by selected model', async () => {
    const service = new AttachmentService(await mkdtemp(join(tmpdir(), 'athena-followup-')), () => true, () => ({ png: Buffer.from('png'), width: 1, height: 1 }))
    const chat = new ChatController(hooks()), id = chat.snapshot().sessionId!, session = chat.current()
    const context = new ChatContextService(chat, service, new WorkspaceService(() => true), { files: async () => [], folder: async () => undefined }, () => true)
    const file = await service.import(id, 'notes.txt', encoder.encode('Remember: the project is Athena.'))
    const messages = [{ id: randomUUID(), role: 'user' as const, content: 'Read this', status: 'complete' as const, createdAt: 1, attachments: [file] }, { id: randomUUID(), role: 'user' as const, content: 'What does the attached file say about the project?', status: 'complete' as const, createdAt: 2 }]
    expect((await context.prepare(session, messages, new AbortController().signal)).attachments[0].data).toContain('Athena')
    const image = await service.import(id, 'test.png', Buffer.from([137,80,78,71,13,10,26,10]))
    messages[0].attachments = [image]
    const withoutVision = await context.prepare(session, messages, new AbortController().signal)
    expect(withoutVision.attachments).toEqual([])
    expect(withoutVision.notice).toContain('not sent')
    expect(withoutVision.notice).toContain('vision')
    session.config.model = 'gpt-4.1'
    expect((await context.prepare(session, messages, new AbortController().signal)).attachments[0].kind).toBe('image'); chat.dispose()
  })
  it('retrieves bounded relevant excerpts from long documents', () => {
    const text = [...Array(300)].map((_, index) => index === 200 ? 'Authentication is configured here.' : `Unrelated line ${index}`).join('\n')
    const extracted = relevantText(text, 'Where is authentication?', 1500)
    expect(extracted).toContain('201: Authentication'); expect(Buffer.byteLength(extracted)).toBeLessThan(1600)
  })
})

describe('video references through the normal attachment service',()=>{
  it('stores validated video bytes, keeps workspace permissions, and prevents text-provider misuse',async()=>{
    const root=await mkdtemp(join(tmpdir(),'athena-video-reference-'))
    let allowed=true
    const service=new AttachmentService(root,()=>allowed,()=>{throw new Error('video must not use image decoder')})
    const session=randomUUID(),bytes=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex')
    const file=await service.import(session,'reference.mp4',bytes)
    expect(file).toMatchObject({kind:'video',mime:'video/mp4'})
    expect(await service.original(session,file)).toEqual(bytes)
    await expect(service.prepare(session,file)).rejects.toThrow('Create video')
    await expect(service.import(session,'fake.mp4',new TextEncoder().encode('fake video'))).rejects.toThrow('do not match')
    await expect(service.original(randomUUID(),file)).rejects.toThrow()
    allowed=false;await expect(service.original(session,file)).rejects.toThrow('Personal File Access')
  })
})
