// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rename, symlink, writeFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { createApprovedFileTools } from '../electron/main/ai/approvedFileTools'
import { contextDefaults } from '../shared/context'
import type { SourceReference } from '../shared/conversations'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'athena-approved-files-')), session = randomUUID()
  let allowed = true
  const service = new AttachmentService(root, () => allowed, () => { throw new Error('unused') })
  const attachment = await service.import(session, 'notes.txt', Buffer.from('first\nsecond\nthird'))
  const sources: SourceReference[] = [], settings = contextDefaults()
  const tools = createApprovedFileTools(service, session, [attachment], () => allowed, sources, settings)
  return { root, session, service, attachment, tools, sources, settings, revoke: () => { allowed = false }, call: async (name: string, args: unknown) => JSON.parse(await tools.execute(name, args, new AbortController().signal)) }
}
describe('approved attachment capabilities', () => {
  it('lists only supplied attachments and reads accurate bounded line references', async () => {
    const f = await fixture()
    expect((await f.call('list_approved_files', { offset: 0 })).files).toEqual([{ attachment_id: f.attachment.id, name: 'notes.txt', characters: 18 }])
    const result = await f.call('open_file', { attachment_id: f.attachment.id, start_line: 2, end_line: 2 })
    expect(result).toMatchObject({ snapshot: true, content: '2: second', nextLine: 3, totalLines: 3 })
    expect(f.sources).toEqual([{ workspace: 'Attachments', path: 'notes.txt', start: 2, end: 2 }])
  })
  it('rejects other chats, absolute paths, unknown IDs, invalid ranges and cancellation', async () => {
    const f = await fixture(), other = await f.service.import(randomUUID(), 'other.txt', Buffer.from('private'))
    for (const args of [ { attachment_id: other.id, start_line: 1, end_line: 1 }, { attachment_id: f.attachment.id, start_line: 2, end_line: 1 }, { attachment_id: f.attachment.id, start_line: 1, end_line: 2, path: '/etc/passwd' } ]) expect((await f.call('open_file', args)).error).toBeTruthy()
    await expect(f.tools.execute('list_approved_files', { offset: 0 }, AbortSignal.abort())).rejects.toThrow('cancelled')
    f.revoke()
    await expect(f.call('open_file', { attachment_id: f.attachment.id, start_line: 1, end_line: 2 })).rejects.toThrow('access stopped')
    expect(f.sources).toEqual([])
  })
  it('discards data if permission is revoked during a read', async () => {
    const f = await fixture(), prepare = f.service.prepare.bind(f.service)
    vi.spyOn(f.service, 'prepare').mockImplementation(async (...args) => { const result = await prepare(...args); f.revoke(); return result })
    await expect(f.call('open_file', { attachment_id: f.attachment.id, start_line: 1, end_line: 2 })).rejects.toThrow('access stopped')
    expect(f.sources).toEqual([])
  })
  it('bounds escaped multibyte output using the configured minimum budget', async () => {
    const f = await fixture()
    const file = await f.service.import(f.session, 'large.txt', Buffer.from(Array(1000).fill('hello "\\ 世界').join('\n')))
    const tools = createApprovedFileTools(f.service, f.session, [file], () => true, [], { ...f.settings, maxToolOutputChars: 2000 })
    const output = await tools.execute('open_file', { attachment_id: file.id, start_line: 1, end_line: 1000 }, new AbortController().signal)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(2000)
    expect(JSON.parse(output).nextLine).toBeGreaterThan(1)
  })
  it('rejects symlinked cache files and redirected session directories', async () => {
    const f = await fixture(), path = join(f.root, 'chat-attachments', f.session, `${f.attachment.id}.txt`)
    await rename(path, path + '.original'); await symlink(path + '.original', path)
    await expect(f.service.prepare(f.session, f.attachment)).rejects.toThrow()
    const second = await fixture(), directory = join(second.root, 'chat-attachments', second.session)
    await rename(directory, directory + '-original'); await symlink(directory + '-original', directory)
    await expect(second.service.prepare(second.session, second.attachment)).rejects.toThrow('trusted directory')
  })
  it('rejects oversized saved attachments without reading them', async () => {
    const f = await fixture()
    await truncate(join(f.root, 'chat-attachments', f.session, `${f.attachment.id}.txt`), 21 * 1024 * 1024)
    await expect(f.service.prepare(f.session, f.attachment)).rejects.toThrow('size limit')
  })
  it('exposes sent attachments only, coexists with project read_file, and stops on session switch', async () => {
    const f = await fixture(), chat = new ChatController({ provider: async () => { throw new Error('unused') }, changed: vi.fn(), phase: vi.fn() })
    const session = chat.current(); session.config.model = 'gpt-4.1'
    const service = new AttachmentService(f.root, () => true, () => { throw new Error('unused') })
    const file = await service.import(session.id, 'sent.txt', Buffer.from('sent content'))
    const pending = await service.import(session.id, 'pending.txt', Buffer.from('not sent'))
    session.attachments.push(pending)
    const workspaces = new WorkspaceService(() => true)
    session.workspaces.push(await workspaces.connect(f.root))
    const context = new ChatContextService(chat, service, workspaces, { files: async () => [], folder: async () => undefined }, () => true)
    const message = { id: randomUUID(), role: 'user' as const, content: 'Read this', status: 'complete' as const, createdAt: 1, attachments: [file] }
    session.messages.push(message)
    // An older message has been compacted out of the current provider input.
    const prepared = await context.prepare(session, [], new AbortController().signal)
    const tools = prepared.projectTools!
    expect(tools.definitions.map((entry) => entry.name)).toEqual(expect.arrayContaining(['read_file', 'open_file', 'list_approved_files']))
    expect(await tools.execute('list_approved_files', { offset: 0 }, new AbortController().signal)).not.toContain(pending.id)
    expect(await tools.execute('open_file', { attachment_id: file.id, start_line: 1, end_line: 1 }, new AbortController().signal)).toContain('sent content')
    const disabled = new ChatContextService(chat, service, workspaces, { files: async () => [], folder: async () => undefined }, () => false)
    await expect(disabled.prepare(session, [], new AbortController().signal)).rejects.toThrow('Personal File Access is disabled')
    chat.command({ action: 'create' })
    await expect(tools.execute('open_file', { attachment_id: file.id, start_line: 1, end_line: 1 }, new AbortController().signal)).rejects.toThrow()
    chat.dispose()
  })
  it('does not open a selected file when permission is disabled while the picker is open', async () => {
    const f = await fixture(), chat = new ChatController({ provider: async () => { throw new Error('unused') }, changed: vi.fn(), phase: vi.fn() })
    let allowed = true
    const file = join(f.root, 'selected.txt'); await writeFile(file, 'personal content')
    const context = new ChatContextService(chat, f.service, new WorkspaceService(() => allowed), { files: async () => { allowed = false; return [file] }, folder: async () => undefined }, () => allowed)
    const read = vi.spyOn(f.service, 'import')
    expect(await context.run({ action: 'pick-files', sessionId: chat.current().id })).toMatchObject({ ok: false })
    expect(read).not.toHaveBeenCalled()
    chat.dispose()
  })
})
