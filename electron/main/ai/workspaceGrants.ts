import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import { workspaceSchema } from '../../../shared/conversations'
import { log } from '../logger'

const grantSchema = z.object({
  reference: workspaceSchema,
  root: z.string().max(4096).refine((value) => isAbsolute(value) && value !== sep),
  device: z.number().int().nonnegative(), inode: z.number().int().nonnegative(),
  // macOS may assign a different device number to the same volume after a reboot.
  // Older grants lack this field and still require the original device check.
  birthtimeMs: z.number().positive().optional(),
})
export type WorkspaceGrant = z.infer<typeof grantSchema>

// Main-process-only authorization records, not conversation metadata. Never sent
// to the renderer or provider. An app preference cannot grant OS-level access.
export class WorkspaceGrants {
  private file: string
  private grants: WorkspaceGrant[] = []
  constructor(private directory: string) {
    this.file = join(directory, 'workspace-grants.json')
    if (existsSync(this.file)) {
      try {
        const document = z.object({ version: z.literal(1), grants: z.array(grantSchema).max(4000) }).parse(JSON.parse(readFileSync(this.file, 'utf8')))
        this.grants = document.grants
      } catch { log('workspace.grants_invalid') }
    }
  }
  list(): WorkspaceGrant[] { return structuredClone(this.grants) }
  private save(grants: WorkspaceGrant[]): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, grants }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.file)
    this.grants = grants
  }
  remember(grant: WorkspaceGrant): void {
    this.save([...this.grants.filter((entry) => entry.reference.id !== grant.reference.id && entry.root !== grant.root), grantSchema.parse(grant)])
  }
  forget(id: string): void { this.save(this.grants.filter((entry) => entry.reference.id !== id)) }
  clear(): void { this.save([]) }
}
