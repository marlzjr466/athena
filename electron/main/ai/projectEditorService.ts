import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { projectEditorCommandSchema, type ProjectEditorResult } from '../../../shared/projectEditor'
import { VSCodeApplication } from '../desktop/vscodeApplication'
import { ChatError } from './AIProvider'
import type { ChatController } from './chatController'
import type { WorkspaceService } from './workspaceService'

const vscode = new VSCodeApplication()

export class ProjectEditorService {
  private opening = new Map<string, Promise<ProjectEditorResult>>()
  constructor(private chat: ChatController, private workspaces: WorkspaceService, private editor = vscode) {}
  private async authorize(sessionId: string, workspaceId: string): Promise<string> {
    const session = this.chat.getSession(sessionId)
    if (!session || this.chat.selectedSessionId() !== sessionId || session.workspaces[0]?.id !== workspaceId) throw new ChatError('The project conversation changed. Select it again before opening VS Code.')
    const root = await this.workspaces.authorizedRoot(workspaceId)
    if (!(await stat(root)).isDirectory()) throw new ChatError('The project folder is no longer a directory. Select the project folder again.')
    await access(root, constants.R_OK | constants.X_OK)
    if (this.chat.selectedSessionId() !== sessionId || this.chat.getSession(sessionId)?.workspaces[0]?.id !== workspaceId || !this.workspaces.authorized(workspaceId)) throw new ChatError('Project access or the conversation changed. Select the project again before opening VS Code.')
    return root
  }
  async run(input: unknown): Promise<ProjectEditorResult> {
    const parsed = projectEditorCommandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'Invalid project editor request.' }
    const command = parsed.data
    if (command.action === 'status') return { ok: true, available: await this.editor.available() }
    const key = `${command.sessionId}:${command.workspaceId}`
    const pending = this.opening.get(key)
    if (pending) return pending
    const operation = this.open(command.sessionId, command.workspaceId).finally(() => this.opening.delete(key))
    this.opening.set(key, operation)
    return operation
  }
  private async open(sessionId: string, workspaceId: string): Promise<ProjectEditorResult> {
    try {
      const root = await this.authorize(sessionId, workspaceId)
      await this.editor.openFolder(root, async () => {
        if (await this.authorize(sessionId, workspaceId) !== root) throw new ChatError('The project folder changed. Select it again before opening VS Code.')
      })
      return { ok: true, available: true }
    } catch (error) {
      if (error instanceof ChatError) return { ok: false, message: error.userMessage }
      if (error instanceof Error && error.message === 'vscode-unavailable') return { ok: false, available: false, message: 'Visual Studio Code is no longer available. Install or repair it, then return to Athena.' }
      const code = (error as NodeJS.ErrnoException)?.code
      return { ok: false, message: code === 'ENOENT' || code === 'ENOTDIR' ? 'The project folder or VS Code installation is missing. Select the folder again and check that VS Code is installed.' : code === 'EPERM' || code === 'EACCES' ? 'Access was denied. Check this project folder’s operating-system permissions and VS Code installation, then try again.' : 'Could not open the project in Visual Studio Code. Try opening VS Code manually, then retry from Athena.' }
    }
  }
}
