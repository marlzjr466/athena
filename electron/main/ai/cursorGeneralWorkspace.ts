import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { ChatError } from './AIProvider'
import type { WorkspaceGrant, WorkspaceGrants } from './workspaceGrants'

const workspaceName = 'Cursor General Chat'
const managedWorkspace = (dataRoot: string, root: string): boolean => {
  const name = relative(dataRoot, root)
  return name === 'cursor-general-chat' || /^cursor-general-chat-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(name)
}

/** A separately granted, app-owned workspace for Cursor conversations without a project. */
export class CursorGeneralWorkspace {
  constructor(private readonly userDataDirectory: string, private readonly grants: WorkspaceGrants) {}

  async authorize(): Promise<{ root: string; assertAccess(): Promise<void> }> {
    try {
      const dataRoot = await realpath(this.userDataDirectory)
      const inspect = async (root: string, create = false) => {
        if (create) await mkdir(root, { mode: 0o700 })
        const info = await lstat(root)
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
          throw new ChatError('Athena’s private Cursor chat workspace is not a safe directory. No Cursor request was started.')
        }
        return info
      }
      const previous = this.grants.list().filter((entry) => entry.reference.name === workspaceName && managedWorkspace(dataRoot, entry.root)).at(-1)
      let root = previous?.root ?? resolve(dataRoot, 'cursor-general-chat')
      if (!previous) await mkdir(root, { recursive: true, mode: 0o700 })
      let info = await inspect(root)
      const fingerprint = createHash('sha256').update(root).digest('hex')
      let grant: WorkspaceGrant
      if (previous) {
        if (previous.reference.fingerprint !== fingerprint || previous.inode !== info.ino || previous.birthtimeMs !== undefined && previous.birthtimeMs !== info.birthtimeMs) {
          throw new ChatError('Athena’s Cursor chat workspace no longer matches its saved authorization. It was not accessed.')
        }
        if (previous.birthtimeMs === undefined && previous.device !== info.dev) {
          // A legacy grant cannot prove that a changed device number still refers
          // to the same folder. Use a new empty workspace; never enter the old one.
          root = resolve(dataRoot, `cursor-general-chat-${randomUUID()}`)
          info = await inspect(root, true)
          grant = { reference: { id: randomUUID(), name: workspaceName, fingerprint: createHash('sha256').update(root).digest('hex') }, root, device: info.dev, inode: info.ino, birthtimeMs: info.birthtimeMs > 0 ? info.birthtimeMs : undefined }
          this.grants.remember(grant)
        } else {
          grant = previous
          if (previous.birthtimeMs === undefined && info.birthtimeMs > 0) {
            grant = { ...previous, birthtimeMs: info.birthtimeMs }
            this.grants.remember(grant)
          }
        }
      } else {
        grant = { reference: { id: randomUUID(), name: workspaceName, fingerprint }, root, device: info.dev, inode: info.ino, birthtimeMs: info.birthtimeMs > 0 ? info.birthtimeMs : undefined }
        this.grants.remember(grant)
      }
      await chmod(root, 0o700)
      await this.assertGrant(grant)
      return { root, assertAccess: () => this.assertGrant(grant) }
    } catch (error) {
      if (error instanceof ChatError) throw error
      throw new ChatError('Could not authorize Athena’s private Cursor chat workspace. Check Athena’s application data folder and retry.')
    }
  }

  private async assertGrant(grant: WorkspaceGrant): Promise<void> {
    const stillGranted = this.grants.list().some((entry) => entry.reference.id === grant.reference.id && entry.root === grant.root && entry.device === grant.device && entry.inode === grant.inode && entry.birthtimeMs === grant.birthtimeMs)
    if (!stillGranted) throw new ChatError('Cursor chat workspace authorization was revoked. Retry to create a fresh Athena-owned workspace grant.')
    try {
      const info = await lstat(grant.root)
      if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== grant.inode || (grant.birthtimeMs === undefined ? info.dev !== grant.device : info.birthtimeMs !== grant.birthtimeMs) || await realpath(grant.root) !== grant.root) throw new Error('root changed')
    } catch { throw new ChatError('Athena’s Cursor chat workspace changed or is unavailable. No files outside its saved grant are accessible.') }
  }
}
