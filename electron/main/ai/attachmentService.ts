import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, lstat, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { MAX_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_CHARACTERS, type Attachment } from '../../../shared/conversations'
import { ChatError, type PreparedAttachment } from './AIProvider'
import { sensitivePath, supportedSource } from './workspaceService'

export interface ImageDecoder { (bytes: Buffer): { png: Buffer; width: number; height: number } | Promise<{ png: Buffer; width: number; height: number }> }
export type DocumentParser = (bytes: Buffer, extension: string) => Promise<string>
interface WorkerResult { text?: string; error?: string; truncated?: boolean; png?: Uint8Array; width?: number; height?: number }
function parseInWorker(bytes: Buffer, extension: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(new URL('./documentWorker.js', import.meta.url)), { workerData: { bytes, extension }, resourceLimits: { maxOldGenerationSizeMb: 192 } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new ChatError('Document parsing timed out. Try a smaller document.')) }, 20_000)
    worker.once('message', (result: WorkerResult) => { clearTimeout(timer); void worker.terminate(); result.error ? reject(new ChatError(result.error)) : resolve(result) })
    worker.once('error', () => { clearTimeout(timer); reject(new ChatError('Document parsing failed. Try a text export.')) })
    worker.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new ChatError('Document parser stopped safely. Try a smaller document.')) })
  })
}
export async function parseDocument(bytes: Buffer, extension: string): Promise<string> {
  const result = await parseInWorker(bytes, extension)
  return (result.text ?? '') + (result.truncated ? '\n[Extraction truncated to 120,000 characters.]' : '')
}
export async function decodeAttachmentImage(bytes: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  const result = await parseInWorker(bytes, 'image')
  if (!result.png || !result.width || !result.height) throw new ChatError('This image could not be decoded.')
  return { png: Buffer.from(result.png), width: result.width, height: result.height }
}
export class AttachmentService {
  constructor(private directory: string, private allowed: () => boolean, private decodeImage: ImageDecoder, private parser: DocumentParser = parseDocument) {}
  private gate(): void { if (!this.allowed()) throw new ChatError('Enable Personal File Access in Settings → Privacy before attaching or reading files.') }
  private path(sessionId: string, id: string, suffix: string): string {
    if (![sessionId, id].every((value) => /^[a-f0-9-]{36}$/.test(value))) throw new ChatError('Invalid attachment reference.')
    return join(this.directory, 'chat-attachments', sessionId, `${id}.${suffix}`)
  }
  private async checkStorage(path: string, requirePermission = true): Promise<void> {
    const root = await realpath(this.directory)
    const parent = dirname(path)
    for (const directory of [dirname(parent), parent]) {
      if (!(await lstat(directory)).isDirectory()) throw new ChatError('Saved attachment storage is not a trusted directory.')
    }
    if (await realpath(parent) !== join(root, 'chat-attachments', basename(parent))) throw new ChatError('Saved attachment storage was redirected. Attach the file again.')
    if (requirePermission) this.gate()
  }
  private sanitizeName(name: string): string {
    const safe = basename(name).replace(/[\u0000-\u001f]/g, '').slice(0, 255)
    if (!safe || sensitivePath(safe)) throw new ChatError('Credential and secret files are excluded.')
    return safe
  }
  validateName(name: string): string { return this.sanitizeName(name) }
  async import(sessionId: string, name: string, input: Uint8Array): Promise<Attachment> {
    this.gate()
    name = this.sanitizeName(name)
    if (!input.length || input.length > MAX_ATTACHMENT_BYTES) throw new ChatError('Each attachment must be non-empty and no larger than 20 MB.')
    const bytes = Buffer.from(input), extension = extname(name).toLowerCase(), id = randomUUID()
    let stored: Buffer = bytes
    let text = '', kind: Attachment['kind'] = 'text', mime = 'text/plain'
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
      const signature = extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ['.jpg', '.jpeg'].includes(extension) ? bytes[0] === 255 && bytes[1] === 216 : extension === '.gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
      if (!signature) throw new ChatError('Image contents do not match its file type.')
      const image = await this.decodeImage(bytes)
      if (!image.width || !image.height || image.width * image.height > 32_000_000 || image.png.length > MAX_ATTACHMENT_BYTES) throw new ChatError('Image is unreadable or exceeds 32 megapixels. Resize it first.')
      stored = image.png; kind = 'image'; mime = 'image/png'
    } else if (extension === '.pdf' || extension === '.docx' || extension === '.xlsx') {
      if (extension === '.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new ChatError('Invalid PDF file.')
      text = await this.parser(bytes, extension)
      // PDF text is extracted locally. Scans/images should be attached as images.
      if (!text.replace(/Page \d+/g, '').trim()) throw new ChatError('No readable text found. Attach scanned pages as images for vision analysis.')
    } else if (supportedSource(name)) {
      if (bytes.includes(0)) throw new ChatError('Binary files are not supported.')
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new ChatError('Text attachments must use UTF-8 encoding.') }
      if (text.length > MAX_TEXT_ATTACHMENT_CHARACTERS) throw new ChatError(`Text attachments are limited to ${MAX_TEXT_ATTACHMENT_CHARACTERS.toLocaleString()} characters. Select a smaller excerpt.`)
    } else throw new ChatError('Unsupported file type. Attach an image, PDF, DOCX, XLSX, text, CSV, or source file.')
    this.gate()
    const savedPath = this.path(sessionId, id, 'bin')
    const storage = join(this.directory, 'chat-attachments')
    await mkdir(storage, { recursive: true, mode: 0o700 })
    if (!(await lstat(storage)).isDirectory() || await realpath(storage) !== join(await realpath(this.directory), 'chat-attachments')) throw new ChatError('Saved attachment storage was redirected.')
    await mkdir(dirname(savedPath), { recursive: true, mode: 0o700 })
    await this.checkStorage(savedPath)
    await writeFile(savedPath, stored, { mode: 0o600, flag: 'wx' })
    if (text) await writeFile(this.path(sessionId, id, 'txt'), text, { mode: 0o600, flag: 'wx' })
    return { id, name, mime, kind, size: stored.length, characters: text.length, origin: 'file' }
  }
  /** Clipboard text is already user-provided content. Keep it local without requiring
   * project/file access, and only expose it to a provider when the user sends. */
  async importPastedText(sessionId: string, name: string, text: string): Promise<Attachment> {
    name = this.sanitizeName(name)
    if (!text.length) throw new ChatError('The pasted text is empty.')
    if (text.length > MAX_TEXT_ATTACHMENT_CHARACTERS) throw new ChatError(`Pasted text is limited to ${MAX_TEXT_ATTACHMENT_CHARACTERS.toLocaleString()} characters. Import a smaller document or split it into sections.`)
    if (text.includes('\u0000')) throw new ChatError('Pasted content contains binary data. Attach it as a supported file instead.')
    const bytes = Buffer.from(text, 'utf8')
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new ChatError('The pasted text exceeds Athena’s 20 MB attachment limit. Split it into smaller sections.')
    const id = randomUUID(), storage = join(this.directory, 'chat-attachments'), savedPath = this.path(sessionId, id, 'bin')
    await mkdir(storage, { recursive: true, mode: 0o700 })
    if (!(await lstat(storage)).isDirectory() || await realpath(storage) !== join(await realpath(this.directory), 'chat-attachments')) throw new ChatError('Saved attachment storage was redirected.')
    await mkdir(dirname(savedPath), { recursive: true, mode: 0o700 })
    await this.checkStorage(savedPath, false)
    await writeFile(savedPath, bytes, { mode: 0o600, flag: 'wx' })
    await writeFile(this.path(sessionId, id, 'txt'), text, { mode: 0o600, flag: 'wx' })
    return { id, name, mime: 'text/plain', kind: 'text', size: bytes.length, characters: text.length, origin: 'paste' }
  }
  async replaceText(sessionId: string, attachment: Attachment, text: string): Promise<{ size: number; characters: number }> {
    const requirePermission = attachment.origin !== 'paste'
    if (requirePermission) this.gate()
    if (attachment.kind !== 'text') throw new ChatError('Only text attachments can be edited.')
    if (!text.length) throw new ChatError('The text attachment cannot be empty.')
    if (text.length > MAX_TEXT_ATTACHMENT_CHARACTERS) throw new ChatError(`Text attachments are limited to ${MAX_TEXT_ATTACHMENT_CHARACTERS.toLocaleString()} characters.`)
    if (text.includes('\u0000')) throw new ChatError('Pasted content contains binary data. Attach it as a supported file instead.')
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ChatError('The text attachment exceeds Athena’s 20 MB attachment limit.')
    const write = async (path: string, content: Buffer) => {
      await this.checkStorage(path, requirePermission)
      const file = await open(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
      try { if (!(await file.stat()).isFile()) throw new ChatError('Saved attachment is not a regular file.'); await file.writeFile(content) }
      finally { await file.close() }
    }
    await write(this.path(sessionId, attachment.id, 'txt'), Buffer.from(text, 'utf8'))
    await write(this.path(sessionId, attachment.id, 'bin'), bytes)
    return { size: bytes.length, characters: text.length }
  }
  async preview(sessionId: string, attachment: Attachment): Promise<{ preview?: string; text?: string }> {
    const prepared = await this.prepare(sessionId, attachment)
    return prepared.kind === 'image' ? { preview: prepared.data } : { text: prepared.data }
  }
  async original(sessionId: string, attachment: Attachment): Promise<Buffer> {
    return this.readStored(sessionId, attachment.id, 'bin', attachment.origin !== 'paste')
  }
  private async readStored(sessionId: string, id: string, suffix: 'bin' | 'txt', requirePermission = true): Promise<Buffer> {
    if (requirePermission) this.gate()
    const path = this.path(sessionId, id, suffix)
    await this.checkStorage(path, requirePermission)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size > MAX_ATTACHMENT_BYTES) throw new ChatError('Saved attachment is not a regular file within the size limit.')
      const buffer = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < buffer.length) {
        if (requirePermission) this.gate()
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      await this.checkStorage(path, requirePermission)
      const after = await lstat(path)
      if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== before.size) throw new ChatError('Saved attachment changed while reading. Attach the file again.')
      if (requirePermission) this.gate()
      const bytes = buffer.subarray(0, length)
      return Buffer.from(bytes)
    } finally { await file.close() }
  }
  async prepare(sessionId: string, attachment: Attachment): Promise<PreparedAttachment> {
    const requirePermission = attachment.origin !== 'paste'
    const bytes = await this.readStored(sessionId, attachment.id, attachment.kind === 'image' ? 'bin' : 'txt', requirePermission)
    return { id: attachment.id, name: attachment.name, kind: attachment.kind, data: attachment.kind === 'image' ? `data:image/png;base64,${bytes.toString('base64')}` : new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  }
}
