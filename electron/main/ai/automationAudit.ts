import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { redactOutput } from './agentCommands'

export function safeAutomationDiagnostic(message:string):string {
  return redactOutput(message)
    .replace(/https?:\/\/[^\s]+/gi,'[address]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[account]')
    .replace(/[“"].*?[”"]/g,'[label]')
    .replace(/(?:\/Users\/|[A-Z]:\\Users\\)[^\s]+/g,'[local path]').slice(0,1000)
}

const auditEntrySchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  actionId: z.string().regex(/^(?:athena|browser)\.[a-zA-Z0-9.]+$/),
  permission: z.string().max(80),
  status: z.enum(['started', 'completed', 'failed', 'denied', 'cancelled']),
  durationMs: z.number().int().nonnegative().optional(),
  diagnostics:z.record(z.string().max(60),z.string().max(1000)).optional(),
}).strict()
const auditFileSchema = z.object({ version: z.literal(1), entries: z.array(auditEntrySchema).max(2000) }).strict()
export type AutomationAuditEntry = z.infer<typeof auditEntrySchema>

/** Bounded, local-only audit history. Inputs, message text, URLs, and credentials are never stored. */
export class AutomationAuditLog {
  private queue: Promise<void> = Promise.resolve()
  constructor(private directory: string) {}

  async recent() {
    await this.queue
    try {
      const data=auditFileSchema.parse(JSON.parse(await readFile(join(this.directory,'audit.json'),'utf8')))
      return data.entries.slice(-30).reverse()
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') return []
      throw new Error('Automation history is unreadable.')
    }
  }

  record(entry: Omit<AutomationAuditEntry, 'id' | 'createdAt'>): Promise<void> {
    const validated = auditEntrySchema.parse({ ...entry, id: randomUUID(), createdAt: new Date().toISOString() })
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const path = join(this.directory, 'audit.json')
      let previous: z.infer<typeof auditFileSchema> = { version: 1, entries: [] }
      try { previous = auditFileSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Automation audit history is unreadable; the action was stopped.')
      }
      const next = auditFileSchema.parse({ version: 1, entries: [...previous.entries, validated].slice(-2000) })
      const temporary = join(this.directory, `.audit-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try { await rename(temporary, path) }
      catch (error) { await import('node:fs/promises').then(fs => fs.unlink(temporary).catch(() => {})); throw error }
    })
    this.queue = operation.catch(() => {})
    return operation
  }
}

export function automationAuditPath(userDataDirectory: string): string { return dirname(join(userDataDirectory, 'automation', 'audit.json')) }
