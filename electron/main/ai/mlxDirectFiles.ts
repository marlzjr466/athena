import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AIChunk } from '../../../shared/chat'
import { fileDiff } from '../../../shared/agent'
import { ChatError, type ProjectTools, type StreamOptions } from './AIProvider'
import { ToolCallSession } from './toolCallSession'
import { checkSourceSyntax, requireValidSource } from './sourceSyntax'

export interface DirectFileRequest { operation: 'create' | 'read' | 'update' | 'rename' | 'delete'; path: string; destination?: string; request: string; content?: string; start: number; end: number; show: boolean }
const target = '(?:`([^`\\n]+)`|"([^"\\n]+)"|\'([^\'\\n]+)\'|([^\\s`"\',;:]+))'
const value = (m: RegExpMatchArray, offset = 1) => m.slice(offset, offset + 3).find(v => v !== undefined) ?? m[offset + 3].replace(/[?.!,;]+$/, '')
const safe = (path: string) => path.length <= 1000 && !path.startsWith('/') && !path.startsWith('~') && !/[\\\0*?]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..')
const fileLike = (path: string) => /(?:^|\/)\.?[\w@ -]+(?:\.[\w-]+)+$/.test(path) || /^(?:.*\/)?(?:README|LICENSE|Dockerfile|Makefile)$/.test(path)

/** Only explicit user imperatives qualify. Conditional, compound and quoted
 * requests stay with the existing agent; repository text is never parsed here. */
export function directFileRequest(request: string): DirectFileRequest | undefined {
  const text = request.trim().replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, '')
  const match = new RegExp('^(create|read|show|display|update|edit|modify|rename|move|delete|remove)\\s+(?:(?:a|an|the)\\s+)?(?:(?:new|empty)\\s+)?(?:(?:simple|small|typescript|javascript|json|markdown|text|source)\\s+)?(?:file\\s+)?(?:(?:named|called)\\s+)?' + target + '([\\s\\S]*)$', 'i').exec(text)
  if (!match) return
  const path = value(match, 2), tail = match[6].trim(), verb = match[1].toLowerCase()
  if (!fileLike(path)) return
  const operation = ({ show: 'read', display: 'read', edit: 'update', modify: 'update', move: 'rename', remove: 'delete' } as Record<string, DirectFileRequest['operation']>)[verb] ?? verb as DirectFileRequest['operation']
  const result: DirectFileRequest = { operation, path, request, start: 1, end: 400, show: /\b(show|contents?|confirm|diff)\b/i.test(tail) || operation === 'read' }
  if (operation === 'delete' || operation === 'read') {
    // Never turn “delete x if unused”, “don't delete x”, or additional actions
    // into an unconditional destructive operation.
    if (!/^[.?!]*(?:\s*(?:and\s+)?(?:please|only|now|then\s+)?(?:confirm(?:\s+(?:deletion|it(?:\s+is\s+gone)?))?|verify(?:\s+(?:absence|deletion|it(?:\s+is\s+gone)?))?|show\s+(?:me\s+)?(?:its\s+)?contents|lines?\s+\d+(?:\s*(?:-|to|through)\s*\d+)?|starting\s+at\s+line\s+\d+)[.?!]*)?$/i.test(tail)) return
    const lines = /(?:lines?|starting at line)\s+(\d+)(?:\s*(?:-|to|through)\s*(\d+))?/i.exec(tail)
    if (lines) { result.start = Number(lines[1]); result.end = Math.min(result.start + 399, Number(lines[2] ?? result.start + 399)) }
  } else if (operation === 'rename') {
    const destination = new RegExp('^to\\s+' + target + '(?:[.?!]|\\s+(?:and\\s+)?(?:verify|confirm)(?:\\s+(?:both\\s+paths|it))?[.?!]?)*$', 'i').exec(tail)
    if (!destination) return
    result.destination = value(destination)
    if (!fileLike(result.destination)) return
  } else {
    const prose = tail.split('```')[0]
    if (/\b(?:if|unless|only when|after)\b/i.test(prose)) return
    if (/\b(?:architecture|dependencies|related files|across|repository|project-wide|then\s+(?:delete|rename|move|create|edit|run)|and\s+(?:delete|rename|move|create|edit|run))\b/i.test(prose)) return
    if ([...prose.matchAll(/(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|json|md|py)\b/g)].some(m => m[0] !== path)) return
    const code = /```[^\n]*\n([\s\S]*?)\n```/.exec(tail)
    if (operation === 'create' && code && !tail.slice(code.index! + code[0].length).trim().match(/^(?:(?:and\s+)?(?:show|read|verify|confirm)[\w\s.,!?]*)?$/i)) return
    if (operation === 'create' && code) result.content = code[1] + '\n'
    if (operation === 'create' && /^(?:[.?!]|\s)*$/.test(tail)) result.content = ''
    if (operation === 'update' && !tail) return
  }
  return result
}

export const createDraftSchema = z.object({ content: z.string().max(60_000) }).strict()
export const editDraftSchema = z.object({ old_text: z.string().min(1).max(30_000), new_text: z.string().max(30_000) }).strict()
export type FileDraft = z.infer<typeof createDraftSchema> | z.infer<typeof editDraftSchema>
export type DraftFile = (task: DirectFileRequest, evidence: string, correction: string, signal: AbortSignal) => Promise<FileDraft>
function literalEdit(request: string): z.infer<typeof editDraftSchema> | undefined {
  const text = '(?:`([^`\\n]+)`|"([^"\\n]+)"|\'([^\'\\n]+)\'|([\\w +*/()=-]+?))'
  const match = new RegExp('\\b(?:to\\s+)?replace\\s+(?:the\\s+unique\\s+expression\\s+)?' + text + '\\s+with\\s+' + text + '(?=\\.\\s|[.!]?$)', 'i').exec(request)
  if (!match) return
  const take = (start: number) => match.slice(start, start + 3).find(v => v !== undefined) ?? match[start + 3].trim()
  return { old_text: take(1), new_text: take(5) }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const raw = (read: any): string => String(read.content ?? '').replace(/^\d+: ?/gm, '')
const quote = (path: string) => '`' + path.replace(/[`\r\n]/g, '') + '`'
const block = (text: string) => { const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${fence}\n${text}\n${fence}` }
const errorText = (e: any): string => typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)

export async function* executeDirectFile(task: DirectFileRequest, base: ProjectTools, options: StreamOptions, draft: DraftFile): AsyncIterable<AIChunk> {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.min(base.timeoutMs ?? 120000, 120000))])
  let committed: any, calls = 0
  const mutation = { create: 'create_file', update: 'edit_file', rename: 'rename_file', delete: 'delete_file', read: 'read_file' }[task.operation]
  const tools: ProjectTools = { ...base, async execute(name, input, abort) {
    const output = await base.execute(name, input, abort)
    const parsed = JSON.parse(output), result = parsed.result ?? parsed
    if (name === mutation && task.operation !== 'read' && result.ok && result.verified) committed = result
    return output
  } }
  const budget = Math.min(10, base.maxCalls ?? 10, options.contextSettings?.maxToolCalls ?? 10)
  const session = new ToolCallSession(tools, signal, budget)
  const call = async (name: string, input: Record<string, unknown>, allowMissing = false) => {
    if (session.exhausted) throw new ChatError('Direct file tool budget reached. Review completed operations in Activity.')
    const action = { type: 'function_call' as const, call_id: randomUUID(), name, arguments: JSON.stringify(input), status: 'completed' as const }
    session.validateBatch([action]); calls++
    const parsed = JSON.parse(await session.execute(action, options.contextSettings?.maxToolOutputChars ?? 8000)), result = parsed.result ?? parsed
    if (allowMissing && result.reason === 'file_not_found' && result.osCode === 'ENOENT') return { absent: true }
    if (result.error || result.ok === false) throw new ChatError(errorText(result.error ?? result))
    return result
  }
  try {
    if (!safe(task.path) || task.destination && !safe(task.destination)) throw new ChatError('Target must be an exact relative file path inside the authorized project.')
    base.assertAccess(); signal.throwIfAborted()
    if (!tools.definitions.some(d => d.name === mutation)) throw new ChatError('This operation is unavailable in the current permission mode.')
    let before: any, saved: any, content: string | undefined, diff = '', syntax = ''
    if (task.operation === 'create' && !(await call('get_file_metadata', { path: task.path }, true)).absent) throw new ChatError('The target already exists. Use an explicit update request; it was not overwritten.')
    if (task.operation !== 'create') {
      before = await call('read_file', { path: task.path, start_line: task.operation === 'read' ? task.start : 1, end_line: ['delete', 'rename'].includes(task.operation) ? 1 : task.end })
      if (typeof before.version !== 'string') throw new ChatError('The target file could not be read with a verified version.')
    }
    if (task.operation === 'read') {
      if (typeof before.content !== 'string') throw new ChatError('No file contents were returned. Request a fresh range.')
      yield { type: 'text', text: `Read ${quote(task.path)} — completed. Inspected lines ${before.start}–${before.end} of ${before.totalLines}.\n\n${block(raw(before))}${before.end < before.totalLines ? '\n\nOnly the displayed range was read.' : ''}` }
    } else {
      let input: Record<string, unknown> = { path: task.path, expected_version: before?.version }
      if (task.operation === 'rename') input.destination = task.destination
      if (task.operation === 'create' || task.operation === 'update') {
        // Only applicable instruction files, never general repository discovery.
        const guidance = tools.definitions.some(d => d.name === 'inspect_project_instructions') ? await call('inspect_project_instructions', { path: task.path }) : undefined
        let correction = ''
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted()
          try {
            const explicitEdit = task.operation === 'update' ? literalEdit(task.request) : undefined
            const proposal = task.operation === 'create' && task.content !== undefined ? { content: task.content } : explicitEdit ?? await draft(task, JSON.stringify({ current: before ? { ...before, content: raw(before) } : undefined, scopedGuidance: guidance }), correction, signal)
            if (task.operation === 'create') {
              content = createDraftSchema.parse(proposal).content
              if (task.content === undefined && /\b(?:example usage|usage example|demonstration)\b/i.test(content) && !/\b(?:example|demonstrat|demo|usage|test)\w*\b/i.test(task.request)) throw new ChatError('Remove the unsolicited usage example and demonstration code. Return only the requested implementation.')
              const check = await checkSourceSyntax(task.path, content); requireValidSource(check)
              syntax = check.status === 'passed' ? `${check.validator}: passed.` : 'Syntax validation unavailable for this format.'
              input = { path: task.path, content }
            } else {
              const patch = editDraftSchema.parse(proposal), text = raw(before)
              if (!text.includes(patch.old_text) || text.indexOf(patch.old_text) !== text.lastIndexOf(patch.old_text)) throw new ChatError('The proposed edit must match one unique section of the inspected file.')
              const next = text.replace(patch.old_text, () => patch.new_text)
              if (before.start === 1 && before.end === before.totalLines) {
                const check = await checkSourceSyntax(task.path, next); requireValidSource(check)
                syntax = check.status === 'passed' ? `${check.validator}: passed.` : 'Syntax validation unavailable for this format.'
              }
              diff = fileDiff(task.path, text, next)
              input = { path: task.path, expected_version: before.version, ...patch }
            }
            break
          } catch (error) {
            signal.throwIfAborted()
            if (attempt || task.content !== undefined) throw error
            correction = errorText(error)
          }
        }
      }
      const result = await call(mutation, input)
      if (!result.verified) throw new ChatError('The operation returned without confirmed filesystem verification.')
      const evidence = result.verification as Array<{ path: string; exists: boolean; version: string | null }>
      const targetPath = task.destination ?? task.path
      const targetResult = evidence?.find(e => e.path === targetPath)
      if (task.operation === 'delete') {
        if (targetResult?.exists !== false) throw new ChatError('Deletion was not verified as absent.')
        yield { type: 'text', text: `Delete ${quote(task.path)} — completed. Confirmed that the target no longer exists. Recovery is available in change history.` }
      } else {
        if (task.operation === 'rename' && !evidence.some(e => e.path === task.path && e.exists === false)) throw new ChatError('The previous path was not verified as absent.')
        saved = await call('read_file', { path: targetPath, start_line: 1, end_line: task.show || task.operation === 'create' ? 400 : 1 })
        if (!targetResult?.exists || saved.version !== targetResult.version || content !== undefined && saved.version !== hash(content)) throw new ChatError('The saved file no longer matches the approved content. Inspect external changes before retrying.')
        const checkedSyntax = (result.syntax ?? []).filter((s: any) => s.status === 'passed').map((s: any) => `${s.validator}: passed.`).join(' ')
        const label = task.operation === 'rename' ? `Rename ${quote(task.path)} → ${quote(targetPath)}` : `${task.operation === 'create' ? 'Create' : 'Update'} ${quote(targetPath)}`
        let response = `${label} — completed. Saved contents match the approved change.${task.operation === 'rename' ? ' Confirmed the previous path no longer exists.' : ''} ${checkedSyntax || syntax}`.trim()
        if (task.show && typeof saved.content === 'string') response += `\n\nActual saved contents${saved.end < saved.totalLines ? ` (lines ${saved.start}–${saved.end} of ${saved.totalLines})` : ''}:\n${block(raw(saved))}`
        if (/\bdiff\b/i.test(task.request) && diff) response += `\n\n${block(diff)}`
        yield { type: 'text', text: response }
      }
    }
  } catch (error) {
    const status = committed ? 'partially completed' : signal.aborted || /declined|cancelled/i.test(errorText(error)) ? 'cancelled' : 'failed'
    const evidence = committed ? ` Applied changes were verified by the filesystem service: ${committed.verification?.map((e: any) => `${e.path} (${e.exists ? 'saved' : 'absent'})`).join(', ')}. Final follow-up verification was interrupted or failed; completed work is preserved.` : 'No completed mutation was confirmed.'
    yield { type: 'text', text: `${task.operation} ${quote(task.path)} — ${status}. ${evidence}\n${signal.aborted ? 'Operation stopped. Pending actions were cancelled.' : errorText(error)}` }
  } finally {
    options.onBudget?.(`Direct file request: ${calls}/${budget} tool calls.`)
    await base.dispose?.()
  }
  yield { type: 'done' }
}
