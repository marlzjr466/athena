import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { FilesystemAccessError } from './filesystemErrors'
import { credentialNamedFile, developerConfigurationPath, protectedMacPath, sensitivePath } from './workspaceService'

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

/** Source writes are opt-in and limited to project directories named
 * in the command's approval request. Reject hidden/protected trees and every
 * symlink component so a command cannot turn a narrow grant into a path escape. */
export function validateCommandWritePaths(root: string, paths: readonly string[] = []): string[] {
  if (paths.length > 20) throw new FilesystemAccessError('A command can request writes to at most 20 exact project directories.', 'invalid_path', 'command_write_scope')
  const canonicalRoot = realpathSync(root)
  return [...new Set(paths.map((path) => {
    if (!path || path.length > 1000 || path.includes('\0') || path.includes('\\') || isAbsolute(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new FilesystemAccessError('Command write paths must be project-relative directory paths without traversal.', 'invalid_path', 'command_write_scope', path)
    }
    const absolute = resolve(canonicalRoot, path), within = relative(canonicalRoot, absolute)
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) || sensitivePath(path) || protectedMacPath(absolute) || developerConfigurationPath(absolute) || path.split('/').some((part) => part.startsWith('.'))) {
      throw new FilesystemAccessError('Command write approval is limited to ordinary, visible directories inside the authorized project. Protected paths and hidden configuration remain blocked.', 'filesystem_policy_denied', 'command_write_scope', absolute)
    }
    let current = canonicalRoot
    for (const part of within.split(sep)) {
      current = resolve(current, part)
      const info = lstatSync(current, { throwIfNoEntry: false })
      if (!info) continue // The kernel grant covers new descendants, never their parent or siblings.
      if (info.isSymbolicLink() || realpathSync(current) !== current) throw new FilesystemAccessError('Command write approval cannot follow symbolic links.', 'symlink_escape_denied', 'command_write_scope', current, true)
      if (!info.isDirectory()) throw new FilesystemAccessError('Command write scope must name a directory.', 'invalid_path', 'command_write_scope', current, true)
    }
    return current
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
