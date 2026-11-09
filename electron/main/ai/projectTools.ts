import { z } from 'zod'
import type { SourceReference } from '../../../shared/conversations'
import { ChatError, type ProjectTools } from './AIProvider'
import { credentialNamedFile, type WorkspaceService } from './workspaceService'
import { contextDefaults, type ContextSettings } from '../../../shared/context'
import { FilesystemAccessError, filesystemToolError } from './filesystemErrors'

const path = z.string().max(1000).describe('Project-relative path by default; use an accessible absolute path only when Full Mac Access is authorized. Empty string selects the default workspace. Parent traversal and protected paths are forbidden.')
const offset = z.number().int().min(0).max(10_000).describe('Pagination offset; start at 0 and use nextOffset to continue.')
const definitions = [
  { name: 'list_directory', description: 'List allowed files and folders directly inside a project directory, with metadata. Use returned paths to explore nested directories. Paginated; does not read source contents.', schema: z.object({ path, offset }).strict() },
  { name: 'read_file', description: 'Read current source contents with real line numbers. Up to 400 lines per call and 2 MiB per file. Character limits can truncate BEFORE the requested end_line: continue at the actual returned end + 1 (nextStartLine), never the requested end. Reuse unchanged ranges already read. Never infer contents from a filename alone.', schema: z.object({ path, start_line: z.number().int().min(1).max(1_000_000), end_line: z.number().int().min(1).max(1_000_000) }).strict() },
  { name: 'search_files', description: 'Recursively search allowed filenames/paths. glob supports *, ** and ?. Examples: **/*.tsx, src/**/auth*.ts. query is a case-insensitive path substring; use empty query to match all glob results. Scope path to a subtree for large projects.', schema: z.object({ path, query: z.string().max(200), glob: z.string().max(200), offset }).strict() },
  { name: 'search_code', description: 'Recursively search current source contents using exact text, a whole symbol, or a regular expression. Returns actual path/line excerpts. Regex runs with a deadline. Scope path/glob and paginate when needed.', schema: z.object({ path, query: z.string().min(1).max(200), glob: z.string().max(200), mode: z.enum(['exact', 'symbol', 'regex']), case_sensitive: z.boolean(), offset }).strict() },
  { name: 'get_project_structure', description: 'Get a bounded project tree and identify configuration/entry-point candidates, without reading every source file. Start here for architecture questions, then read relevant configs and implementations. Explore subtrees if truncated.', schema: z.object({ path, depth: z.number().int().min(1).max(8) }).strict() },
  { name: 'get_file_metadata', description: 'Get size, extension, modification time and type for an allowed file/directory. Does not read file contents.', schema: z.object({ path }).strict() },
] as const

function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new ChatError('Project tool cancelled or timed out.'))
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

export function supportsProjectTools(model: string | null): boolean {
  // The models endpoint has no capability fields. Restrict to known Responses
  // function-calling families; unknown/special-purpose models use retrieval.
  return /^(gpt-(?:4o|4\.1|5|6)(?:[.-]|$)|o[134](?:-|$)|claude-(?:sonnet|opus|haiku|3|4)(?:[.-]|$))/.test(model ?? '') && !/chat|audio|realtime|transcri|tts|image|search|deep-research/.test(model ?? '')
}

export function createProjectTools(service: WorkspaceService, id: string, name: string, sources: SourceReference[], stillSelected: () => boolean, _budget = 48_000, settings: ContextSettings = contextDefaults(), beforeAction?: (name: string, input: unknown, signal: AbortSignal) => Promise<void>, approveCredential?: (name: string, path: string, signal: AbortSignal) => Promise<void>): ProjectTools {
  let calls = 0
  const fileError = (error: unknown, requestedPath: string, operation: string) => filesystemToolError(error, requestedPath, operation, service.filesystemMode(), name)
  const seen = new Set<string>()
  const declinedReads = new Set<string>()
  const assertAccess = () => { if (!stillSelected() || !service.authorized(id)) throw new ChatError('Project access was disconnected or permission was lost. Select this project folder again.') }
  return {
    definitions: definitions.map(({ name, description, schema }) => {
      const { $schema: _schema, ...parameters } = z.toJSONSchema(schema)
      return { name, description, parameters }
    }),
    assertAccess,
    invalidate: () => seen.clear(),
    async execute(tool, input, signal) {
      assertAccess()
      if (signal.aborted) throw new ChatError('Project exploration cancelled.')
      if (++calls > settings.maxToolCalls) return JSON.stringify({ error: 'Configured project tool-call budget reached. Preserve verified progress and continue only on a new user request.' })
      const definition = definitions.find((entry) => entry.name === tool)
      if (!definition) return JSON.stringify({ error: 'Unknown project tool. Only advertised read-only tools are allowed.' })
      const parsed = definition.schema.safeParse(input)
      if (!parsed.success) return JSON.stringify({ error: 'Invalid tool arguments. Use the advertised schema and authorized paths.', issues: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) })
      // Claude/Codex configuration has its existing, separately approved path.
      const developerConfig = service.filesystemMode() !== 'project-only' && parsed.data.path.split(/[\\/]/).some((part) => part === '.claude' || part === '.codex')
      const credentialRead = (tool === 'read_file' || tool === 'get_file_metadata') && credentialNamedFile(parsed.data.path) && !developerConfig
      let approved = false
      if (credentialRead) {
        try {
          if (declinedReads.has(`${tool}:${parsed.data.path}`)) throw new FilesystemAccessError('This exact credential read was declined. Continue only after new user direction; no repeated approval was requested.', 'operation_requires_approval', 'credential_file_approval', parsed.data.path)
          await service.credentialApprovalTarget(id, parsed.data.path)
          if (!approveCredential) throw new FilesystemAccessError('This credential-named file needs explicit per-read user approval. No file content was read.', 'operation_requires_approval', 'credential_file_approval', parsed.data.path)
          await approveCredential(tool, parsed.data.path, signal)
          assertAccess(); signal.throwIfAborted()
          approved = true
        } catch (error) {
          assertAccess(); signal.throwIfAborted()
          if (error instanceof FilesystemAccessError && error.reason === 'operation_requires_approval' && /declined/i.test(error.userMessage)) declinedReads.add(`${tool}:${parsed.data.path}`)
          return JSON.stringify(fileError(error, parsed.data.path, tool))
        }
      }
      const authorized = <T>(action: () => Promise<T>): Promise<T> => approved ? service.withApprovedCredentialRead(id, parsed.data.path, action) : action()
      if (beforeAction) {
        try {
          // Reject excluded, escaped or unavailable paths before promising an
          // inspection. The real operation still revalidates after speech.
          if ('end_line' in parsed.data && 'start_line' in parsed.data && typeof parsed.data.end_line === 'number' && typeof parsed.data.start_line === 'number' && parsed.data.end_line < parsed.data.start_line) throw new ChatError('end_line must be greater than or equal to start_line.')
          await authorized(() => service.metadata(id, parsed.data.path, AbortSignal.any([signal, AbortSignal.timeout(5000)])))
          await beforeAction(tool, parsed.data, signal)
          assertAccess(); signal.throwIfAborted()
        } catch (error) {
          assertAccess(); signal.throwIfAborted()
          return JSON.stringify(fileError(error, parsed.data.path, tool))
        }
      }
      const key = `${tool}:${JSON.stringify(parsed.data)}`
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      try {
        const result = await authorized(() => withinDeadline((async () => {
          let result: unknown
          switch (tool) {
          case 'list_directory': { const args = definitions[0].schema.parse(input); result = await service.directory(id, args.path, args.offset, deadline); break }
          case 'read_file': {
            const args = definitions[1].schema.parse(input)
            if (args.end_line < args.start_line) throw new ChatError('end_line must be greater than or equal to start_line.')
            result = await service.readRange(id, args.path, args.start_line, args.end_line, deadline, settings.maxFileReadChars); break
          }
          case 'search_files': { const args = definitions[2].schema.parse(input); result = await service.search(id, { ...args, mode: 'path', caseSensitive: false, limit: settings.maxSearchResults }, deadline); break }
          case 'search_code': { const args = definitions[3].schema.parse(input); result = await service.search(id, { ...args, caseSensitive: args.case_sensitive, limit: settings.maxSearchResults }, deadline); break }
          case 'get_project_structure': { const args = definitions[4].schema.parse(input); result = await service.structure(id, args.path, args.depth, deadline); break }
          case 'get_file_metadata': { const args = definitions[5].schema.parse(input); result = await service.metadata(id, args.path, deadline); break }
          }
          return result
        })(), deadline))
        assertAccess()
        if (deadline.aborted) throw new ChatError('Project tool timed out. Narrow the directory, pattern or line range.')
        const data = result as Record<string, unknown>
        const versionKey = `${key}:${data.version}`
        if (tool === 'read_file' && seen.has(versionKey)) return JSON.stringify({ notice: 'This exact range and file version were already returned in the active context. Reuse that evidence or request another range.', path: data.path, version: data.version })
        const max = settings.maxToolOutputChars - 256
        const encode = () => JSON.stringify({ project: name, untrusted_data: true, ...data, ...(tool === 'read_file' ? { nextStartLine: Number(data.end) < Number(data.totalLines) ? Number(data.end) + 1 : null } : {}) })
        let output = encode()
        while (Buffer.byteLength(output) > max) {
          data.truncated = true
          if (Array.isArray(data.entries) && data.entries.length) data.entries.pop()
          else if (Array.isArray(data.matches) && data.matches.length) {
            data.matches.pop()
            data.nextOffset = Number('offset' in parsed.data ? parsed.data.offset : 0) + data.matches.length
          } else if (typeof data.content === 'string' && data.content.length) {
            const lines = data.content.split('\n'); lines.pop(); data.content = lines.join('\n')
            data.end = Number(data.start) + lines.length - 1
          } else if (Array.isArray(data.configurationFiles) && data.configurationFiles.length) data.configurationFiles.pop()
          else return JSON.stringify({ error: 'Result exceeds context budget. Request a smaller scope.' })
          output = encode()
        }
        if (Array.isArray(data.entries) && data.truncated && tool === 'list_directory') data.nextOffset = data.entries.length ? Number(data.entries.at(-1).cursor) + 1 : Number('offset' in parsed.data ? parsed.data.offset : 0)
        if (Array.isArray(data.configurationFiles) && Array.isArray(data.entries)) data.configurationFiles = data.configurationFiles.filter((path) => (data.entries as Array<{ path: string }>).some((entry) => entry.path === path))
        output = encode()
        const evidence: SourceReference[] = []
        if (tool === 'read_file' && data.content) evidence.push({ workspace: name, path: String(data.path), start: Number(data.start), end: Number(data.end) })
        if (tool === 'search_code') for (const match of data.matches as Array<{ path: string; line: number }>) evidence.push({ workspace: name, path: match.path, start: match.line, end: match.line })
        for (const source of evidence) if (!sources.some((entry) => entry.path === source.path && entry.workspace === source.workspace && entry.start === source.start && entry.end === source.end)) sources.push(source)
        if (tool === 'read_file') seen.add(versionKey)
        return output
      } catch (error) {
        assertAccess()
        if (signal.aborted) throw new ChatError('Project exploration cancelled.')
        return JSON.stringify(deadline.aborted ? { error: 'Tool timed out. Request a smaller scope.', reason: 'timeout', requestedPath: parsed.data.path, authorizationScope: service.filesystemMode(), project: name } : fileError(error, parsed.data.path, tool))
      }
    },
  }
}
