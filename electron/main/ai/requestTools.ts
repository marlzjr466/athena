import type { ProjectToolDefinition, ProjectTools } from './AIProvider'
import { classifyOperation } from './operationRisk'

const discovery = 'discover_athena_tools'
const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 2) ?? [])
const stopWords = new Set(['the', 'with', 'and', 'for', 'this', 'that', 'project', 'can', 'you', 'please', 'from', 'how'])
const initialBytes = 7200

function rank(definitions: ProjectToolDefinition[], query: string) {
  const terms = [...words(query)].filter(word => !stopWords.has(word))
  return definitions.map(tool => {
    const name = words(tool.name), description = words(tool.description)
    const score = terms.reduce((sum, term) => sum + (name.has(term) ? 5 : description.has(term) ? 1 : 0), 0)
    return { tool, score: query.toLowerCase().includes(tool.name.toLowerCase()) ? score + 100 : score }
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).map(entry => entry.tool)
}

/** Per execution and downstream of authorization. Discovery only changes which
 * original schemas are advertised on the next round. It never dispatches a tool. */
export function requestTools(full: ProjectTools | undefined, query: string) {
  const all = [...new Map(full?.definitions.map(tool => [tool.name, tool])).values()]
  const paged = all.length > 8 && Buffer.byteLength(JSON.stringify(all)) > initialBytes && !all.some(tool => tool.name === discovery)
  let initial = all
  if (paged) {
    initial = []
    let bytes = 0
    // Multi-step file operations need a read/version guard before editing. Keep
    // these dependencies together even when the user only names the end result.
    const preferred: string[] = []
    if (/\b(file|files|project|repository|architecture|modules?|read|inspect|code|component|implement|build|create|edit|update|patch|rename|delete)\b/i.test(query))
      preferred.push('read_file', 'get_file_metadata', 'inspect_project_instructions', 'search_code', 'get_project_structure')
    if (/\b(implement|build|fix|create|edit|update|patch|refactor)\b/i.test(query))
      preferred.push('edit_file', 'create_file', 'apply_patch', 'run_tests')
    for (const action of ['rename', 'delete', 'move']) if (words(query).has(action)) preferred.push(action + '_file')
    const candidates = [...new Set([...preferred.map(name => all.find(tool => tool.name === name)).filter(tool => !!tool), ...rank(all, query)])]
    for (const tool of candidates) {
      const size = Buffer.byteLength(JSON.stringify(tool))
      if (bytes + size > initialBytes || initial.length >= 12) continue
      initial.push(tool)
      bytes += size
    }
  }
  const directory: ProjectToolDefinition = { name: discovery,
    description: 'Find authorized tools by task keywords or exact tool name. Use an empty query to browse names. Matching tools become callable on the next round. Page starts at 1.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, page: { type: 'integer', minimum: 1 } }, required: ['query'], additionalProperties: false } }
  let visible = paged ? [...initial, directory] : all
  let next: ProjectToolDefinition[] | undefined
  const project: ProjectTools | undefined = !full ? undefined : {
    ...full, get definitions() { return visible },
    operationRisk: (name, args) => paged && name === discovery ? 'read-only' : classifyOperation(full, name, args),
    readOnly: name => paged && name === discovery || !!full.readOnly?.(name),
    parallelSafe: name => name !== discovery && !!full.parallelSafe?.(name),
    execute: async (name, args, signal) => {
      full.assertAccess()
      signal.throwIfAborted()
      if (!paged || name !== discovery) return full.execute(name, args, signal)
      const { query, page = 1 } = (args ?? {}) as { query?: string; page?: number }
      if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(page) || page < 1)
        return JSON.stringify({ error: 'Supply a query and an optional positive page number.' })
      const matches = query.trim() ? rank(all, query.trim()) : all
      const selected = matches.slice((page - 1) * 4, page * 4)
      next = [...new Set([...(next ?? []), ...selected])]
      return JSON.stringify({ matches: selected.map(tool => tool.name), page, pages: Math.ceil(matches.length / 4) })
    },
  }
  return { all, initial, paged, project, advance() {
    if (next) { visible = [...new Set([...initial, ...next, directory])]; next = undefined }
    return visible
  } }
}
