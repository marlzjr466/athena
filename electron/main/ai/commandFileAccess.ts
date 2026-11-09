import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { FilesystemAccessError } from './filesystemErrors'
import { credentialNamedFile, developerConfigurationPath, protectedMacPath } from './workspaceService'

/** Internal command grants are exact, existing files in the command workspace.
 * The tool router obtains consent; the runner independently checks boundaries. */
export function validateCommandReadPaths(root: string, paths: readonly string[] = []): string[] {
  if (paths.length > 20) throw new FilesystemAccessError('A command can request at most 20 exact file reads.', 'invalid_path', 'command_read_scope')
  const canonicalRoot = realpathSync(root)
  return [...new Set(paths.map((path) => {
    if (!path || path.length > 1000 || path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) throw new FilesystemAccessError('Command read paths must name exact files without traversal.', 'invalid_path', 'command_read_scope', path)
    const absolute = resolve(canonicalRoot, path), within = relative(canonicalRoot, absolute)
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) || !credentialNamedFile(absolute) || protectedMacPath(dirname(absolute)) || developerConfigurationPath(absolute) || within.split(sep).slice(0, -1).some((part) => part.startsWith('.') && part !== '.tmp')) {
      throw new FilesystemAccessError('Command read approval applies only to a credential-named file inside this working directory, outside protected configuration directories.', 'filesystem_policy_denied', 'command_read_scope', absolute)
    }
    const info = lstatSync(absolute)
    if (info.isSymbolicLink() || realpathSync(absolute) !== absolute) throw new FilesystemAccessError('Command read approvals cannot follow symbolic links.', 'symlink_escape_denied', 'command_read_scope', absolute, true)
    if (!info.isFile()) throw new FilesystemAccessError('Command read approval must name a regular file, not a directory.', 'invalid_path', 'command_read_scope', absolute, true)
    return absolute
  }))]
}

export interface CommandFilesystemDenial {
  reason: 'filesystem_policy_denied'
  policyRule: 'command_credential_filename'
  paths: string[]
  macOSAccessAttempted: true
  recovery: string
}

/** Classify only paths denied by a known sandbox rule. Unrelated EPERM errors
 * must still be investigated as OS or other sandbox failures. */
export function commandFilesystemDenial(root: string, output: string, approved: readonly string[] = []): CommandFilesystemDenial | undefined {
  const paths = new Set<string>()
  for (const match of output.matchAll(/(?:EPERM|EACCES):[^\n]*?\b(?:open|stat|lstat|scandir|access)\s+['"]([^'"\r\n]+)['"]/g)) {
    if (!/credential/i.test(match[1])) continue
    try {
      const [path] = validateCommandReadPaths(root, [match[1]])
      if (!approved.includes(path)) paths.add(path)
    } catch { /* Not eligible for the exact-file command approval. */ }
  }
  if (!paths.size) return
  return { reason: 'filesystem_policy_denied', policyRule: 'command_credential_filename', paths: [...paths], macOSAccessAttempted: true, recovery: 'These paths match the command sandbox credential-read denial. Request approval through execute_command read_paths for these exact files; retry only that command after approval. Do not change ownership or ACLs. Approval allows reads only and does not override independent macOS restrictions; formatting warnings still need separate fixes.' }
}
