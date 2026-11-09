import { z } from 'zod'

export const slashSourceSchema = z.enum(['Athena Built-in', 'Claude Project', 'Claude Global', 'Codex Project', 'Codex Global', 'Installed Skill'])
export type SlashSource = z.infer<typeof slashSourceSchema>
export const slashCommandMetaSchema = z.object({
  id: z.string().min(1).max(500), name: z.string().min(1).max(120), source: slashSourceSchema,
  arguments: z.string().max(12_000),
}).strict()
export type SlashCommandMeta = z.infer<typeof slashCommandMetaSchema>
export interface SlashCommandDefinition {
  id: string
  name: string
  description: string
  source: SlashSource
  sourceFile?: string
  scope: 'built-in' | 'project' | 'global'
  argumentHint?: string
  skillPath?: string
  execution: 'built-in' | 'prompt'
  provider?: 'athena' | 'claude' | 'codex'
  kind?: 'command' | 'skill'
  contentHash?: string
  compatibility?: 'athena-tools' | 'native-only'
  limitation?: string
}
export interface SlashCommandCatalog { commands: SlashCommandDefinition[]; globalEnabled: boolean; message?: string }
export const slashCatalogRequestSchema = z.object({ action: z.enum(['list', 'authorize-global', 'revoke-global']), sessionId: z.string().uuid(), surface: z.enum(['conversation', 'local']).optional() }).strict()

export const BUILTIN_SLASH_COMMANDS: SlashCommandDefinition[] = [
  { id: 'athena:help', name: '/help', description: 'Show available command help.', source: 'Athena Built-in', scope: 'built-in', execution: 'built-in' },
  { id: 'athena:model', name: '/model', description: 'Choose this conversation’s model.', source: 'Athena Built-in', scope: 'built-in', execution: 'built-in' },
  { id: 'athena:effort', name: '/effort', description: 'Choose reasoning effort where supported.', source: 'Athena Built-in', scope: 'built-in', execution: 'built-in' },
  { id: 'athena:clear', name: '/clear', description: 'Clear this conversation after confirmation.', source: 'Athena Built-in', scope: 'built-in', execution: 'built-in' },
  { id: 'athena:new', name: '/new', description: 'Start a new conversation.', source: 'Athena Built-in', scope: 'built-in', execution: 'built-in' },
  { id: 'athena:project', name: '/project', description: 'Choose an authorized project folder.', source: 'Athena Built-in', scope: 'built-in', execution: 'built-in' },
  { id: 'athena:sessions', name: '/sessions', description: 'Show conversation sessions.', source: 'Athena Built-in', scope: 'built-in', execution: 'built-in' },
]

// Only the beginning of a message is a command position. URLs, prose and paths
// containing slashes never open the menu.
export function slashQuery(text: string, caret: number): string | null {
  if (caret < 1 || caret > text.length) return null
  const before = text.slice(0, caret)
  const match = /^\s*(\/[\w:.-]*)$/.exec(before)
  return match ? match[1].toLowerCase() : null
}
export function commandAtStart(text: string): { name: string; arguments: string } | null {
  const match = /^\s*(\/[\w:.-]+)(?=$|\s)([\s\S]*)$/.exec(text)
  return match ? { name: match[1], arguments: match[2].replace(/^\s/, '') } : null
}
export type SlashResolution = { parsed: { name: string; arguments: string }; matches: SlashCommandDefinition[]; status: 'resolved' | 'ambiguous' | 'unknown' }
/** The same registry lookup is used by typing, paste, history recall and send. */
export function resolveSlashCommand(text: string, commands: SlashCommandDefinition[]): SlashResolution | null {
  const parsed = commandAtStart(text)
  if (!parsed) return null
  const matches = commands.filter((command) => command.name.toLowerCase() === parsed.name.toLowerCase())
  return { parsed, matches, status: matches.length === 1 ? 'resolved' : matches.length > 1 ? 'ambiguous' : 'unknown' }
}
export function filterSlashCommands(commands: SlashCommandDefinition[], query: string): SlashCommandDefinition[] {
  const term = query.slice(1).toLowerCase()
  return commands.filter((command) => command.name.toLowerCase().includes(term) || command.description.toLowerCase().includes(term)).slice(0, 60)
}
