import { z } from 'zod'
import type { Attachment, SourceReference } from '../../../shared/conversations'
import { contextDefaults, type ContextSettings } from '../../../shared/context'
import { ChatError, type ProjectTools } from './AIProvider'
import type { AttachmentService } from './attachmentService'

const listSchema = z.object({ offset: z.number().int().min(0).max(100_000) }).strict()
const openSchema = z.object({ attachment_id: z.string().uuid(), start_line: z.number().int().min(1).max(1_000_000), end_line: z.number().int().min(1).max(1_000_000) }).strict()

// Only attachments already sent in this conversation are capabilities. Pending
// uploads, original filesystem paths and attachments in other chats are not.
export function createApprovedFileTools(service: AttachmentService, sessionId: string, files: Attachment[], allowed: () => boolean, sources: SourceReference[], settings: ContextSettings = contextDefaults(), beforeAction?: (name: string, input: unknown, signal: AbortSignal) => Promise<void>): ProjectTools {
  const approved = new Map(files.filter((file) => file.kind !== 'image').map((file) => [file.id, { ...file }]))
  const assertAccess = () => { if (!allowed()) throw new ChatError('Approved file access stopped: the conversation changed or Personal File Access was disabled.') }
  const definitions = [
    { name: 'list_approved_files', description: 'List text/document snapshots explicitly attached and sent in this conversation. Returns attachment IDs for open_file. These are saved copies, not access to the original disk paths. Images use the separate vision attachment flow.', schema: listSchema },
    { name: 'open_file', description: 'Open and read a bounded line range from an approved attachment snapshot. Use attachment_id from list_approved_files. Read-only; does not launch an OS application or execute a file. Text extracted from PDFs/DOCX uses extracted-text line numbers, not page numbers. For live connected project source, use read_file instead.', schema: openSchema },
  ]
  return {
    definitions: definitions.map(({ name, description, schema }) => {
      const { $schema: _schema, ...parameters } = z.toJSONSchema(schema)
      return { name, description, parameters }
    }),
    assertAccess,
    parallelSafe: () => true,
    async execute(name, input, signal) {
      const check = () => { assertAccess(); if (signal.aborted) throw new ChatError('Approved file reading cancelled.') }
      check()
      try {
        if (name === 'list_approved_files') {
          const { offset } = listSchema.parse(input), all = [...approved.values()]
          const entries = all.slice(offset, offset + 20).map(({ id, name, characters }) => ({ attachment_id: id, name, characters }))
          while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries)) > settings.maxToolOutputChars - 256) entries.pop()
          return JSON.stringify({ untrusted_data: true, files: entries, nextOffset: offset + entries.length < all.length ? offset + entries.length : null })
        }
        if (name !== 'open_file') throw new ChatError('Unknown approved-file tool.')
        const args = openSchema.parse(input), file = approved.get(args.attachment_id)
        if (!file) throw new ChatError('This file was not sent in this conversation. Ask the user to attach it first.')
        if (args.end_line < args.start_line) throw new ChatError('end_line must be greater than or equal to start_line.')
        await beforeAction?.(name, input, signal)
        check()
        const prepared = await service.prepare(sessionId, file)
        check()
        const lines = prepared.data.split('\n'), end = Math.min(args.end_line, args.start_line + 399, lines.length)
        const limit = Math.min(settings.maxFileReadChars, settings.maxToolOutputChars - 1536)
        const selected: string[] = []
        let bytes = 0
        for (let index = args.start_line - 1; index < end; index++) {
          const line = `${index + 1}: ${lines[index]}`
          const size = Buffer.byteLength(JSON.stringify(line)) + 1
          if (bytes + size > limit) break
          selected.push(line); bytes += size
        }
        const actualEnd = args.start_line + selected.length - 1
        if (selected.length) {
          const reference = { workspace: 'Attachments', path: file.name, start: args.start_line, end: actualEnd }
          if (!sources.some((entry) => JSON.stringify(entry) === JSON.stringify(reference))) sources.push(reference)
        }
        return JSON.stringify({ untrusted_data: true, attachment_id: file.id, name: file.name, snapshot: true, start: args.start_line, end: actualEnd, totalLines: lines.length, content: selected.join('\n'), nextLine: selected.length && actualEnd < lines.length ? actualEnd + 1 : null, notice: !selected.length ? 'No lines returned: range is past EOF or a line exceeds the output limit. Request a smaller document if needed.' : undefined })
      } catch (error) {
        check()
        return JSON.stringify({ error: error instanceof ChatError ? error.userMessage : error instanceof z.ZodError ? 'Invalid approved-file arguments.' : 'Saved file unavailable. Ask the user to attach it again.' })
      }
    },
  }
}
