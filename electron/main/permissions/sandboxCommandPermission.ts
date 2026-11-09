import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRequest } from '../ai/agentCommands'
import { sensitiveContent } from '../ai/workspaceService'
import { rememberedSandboxCommandSchema, type RememberedScope } from '../../../shared/permissions'

const scripts = new Set(['test', 'test:unit', 'test:ci', 'lint', 'lint:check', 'typecheck', 'type-check', 'format:check'])
export function checkCommandArgs(manager: string, args: string[]): boolean {
  if (!['npm', 'pnpm', 'yarn'].includes(manager)) return false
  const script = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0]
  if (!scripts.has(script)) return false
  // No alternative workspace, injected process configuration, credentials or
  // source-changing flags. The sandbox remains the actual execution boundary.
  return args.every(arg => !/[\0\r\n]/.test(arg) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(arg)
    && !/^(?:\/|[A-Za-z]:[\\/])/.test(arg)
    && !/^--?(?:prefix|cwd|dir|workspace|workspaces|filter|config|userconfig|globalconfig|script-shell|node-options|exec|eval|fix|write|update|updateSnapshot|update-snapshots|u)(?:=|$)/i.test(arg))
    && !sensitiveContent(JSON.stringify(args))
}
export function packageFingerprint(root: string): string {
  const file = join(root, 'package.json')
  if (statSync(file).size > 1024 * 1024 || realpathSync(file) !== file) throw new Error('Package configuration cannot be safely scoped')
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
export function executableFingerprint(executable: string): string {
  const info = statSync(executable)
  if (!info.isFile() || realpathSync(executable) !== executable) throw new Error('Executable changed')
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
}
/** Constructed by trusted sandbox adapters, never parsed from a model tool argument. */
export function sandboxCommandScope(root: string, request: CommandRequest, executable: string, tool: string): RememberedScope | undefined {
  if (request.network || request.loopback || request.install || request.gitWrite || request.localServer || request.port !== undefined || request.approvedReadPaths?.length || (request.filesystemMode ?? 'project-only') !== 'project-only') return undefined
  if (!checkCommandArgs(request.executable, request.args)) return undefined
  try {
    const project = realpathSync(root), resolvedExecutable = realpathSync(executable)
    const command = rememberedSandboxCommandSchema.parse({ tool, manager: request.executable, executable: resolvedExecutable,
      executableIdentity: executableFingerprint(resolvedExecutable), args: request.args, packageHash: packageFingerprint(project),
      sandbox: 'project-offline-no-source-or-dependency-writes-v1' })
    return { operation: 'sandbox_check_command', project, resources: [project], command }
  } catch { return undefined }
}
