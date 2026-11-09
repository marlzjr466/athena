import type { FilesystemAccessMode } from '../../../shared/permissions'
import { ChatError } from './AIProvider'

export type FilesystemFailureReason = 'filesystem_policy_denied' | 'operation_requires_approval' | 'macos_permission_denied' | 'file_not_found' | 'invalid_path' | 'symlink_escape_denied' | 'readonly_filesystem' | 'filesystem_io_error'

/** A policy rejection is distinct from an OS error: no filesystem permission
 * change can fix a request that Athena rejected before opening the target. */
export class FilesystemAccessError extends ChatError {
  constructor(
    message: string,
    readonly reason: FilesystemFailureReason,
    readonly policyRule: string,
    readonly normalizedPath?: string,
    readonly macOSAccessAttempted = false,
  ) { super(message); this.name = 'FilesystemAccessError' }
}

export function filesystemToolError(error: unknown, requestedPath: string, operation: string, scope: FilesystemAccessMode, project: string, effectiveToolAuthorization = 'filesystem-read') {
  const code = (error as NodeJS.ErrnoException)?.code
  const typed = error instanceof FilesystemAccessError ? error : undefined
  const reason: FilesystemFailureReason = typed?.reason ?? (
    code === 'EACCES' || code === 'EPERM' ? 'macos_permission_denied'
      : code === 'ENOENT' ? 'file_not_found'
        : code === 'ENOTDIR' || code === 'EINVAL' ? 'invalid_path'
          : code === 'EROFS' ? 'readonly_filesystem'
            : error instanceof ChatError && /declined|cancelled.*approval/i.test(error.userMessage) ? 'operation_requires_approval'
              : 'filesystem_io_error')
  const message = typed?.userMessage ?? (reason === 'macos_permission_denied'
    ? 'macOS denied this location. Review System Settings → Privacy & Security → Files and Folders or Full Disk Access for Athena.'
    : reason === 'file_not_found' ? 'File or directory not found (ENOENT). List the parent directory; this is not a permission denial.'
      : reason === 'invalid_path' ? 'A path component is invalid or not a directory. Check the target path.'
        : reason === 'readonly_filesystem' ? 'The filesystem is read-only. Athena did not change the target.'
          : error instanceof ChatError ? error.userMessage : 'Filesystem I/O failed. No access or change is implied.')
  return {
    error: message, reason, requestedPath, normalizedPath: typed?.normalizedPath ?? (error as NodeJS.ErrnoException)?.path,
    // A lexical policy rejection happens before realpath/open. Do not pretend
    // it proved a canonical target or that macOS refused the request.
    osCode: typed ? null : code ?? null,
    authorizationScope: scope, effectiveToolAuthorization, operation, project,
    policyRule: typed?.policyRule ?? null,
    macOSAccessAttempted: typed?.macOSAccessAttempted ?? Boolean(code),
    recovery: reason === 'operation_requires_approval'
      ? typed?.policyRule === 'authorization_refresh_required' ? 'Explicitly continue the preserved task to refresh authorization. Completed operations must not be replayed.'
        : 'Request approval for this exact operation in the parent conversation. Do not retry after a decline without new user direction.'
      : reason === 'filesystem_policy_denied' ? 'Inspect the policy rule. Full Mac Access does not override protected resources. Use an eligible exact-file read approval or a redacted copy; do not change ownership or ACLs.'
        : reason === 'macos_permission_denied' ? 'Check macOS privacy access for Athena. An Athena approval cannot override macOS restrictions.' : undefined,
  }
}
