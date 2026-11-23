import type { OperationRisk } from '../../../shared/generation'
import type { ProjectTools } from './AIProvider'

/** Classification is independent of concurrency and authorization. Only a
 * verified read may bypass the replay prompt; idempotent writes still need
 * current-state/version validation and the existing repeat safeguard. */
export function classifyOperation(tools: ProjectTools, name: string, input: unknown): OperationRisk {
  if (!tools.definitions.some(tool => tool.name === name)) return 'unknown'
  if (tools.operationRisk) return tools.operationRisk(name, input)
  return tools.readOnly?.(name) === true ? 'read-only' : 'unknown'
}

/** Conservative direct-command allowlist. Shell syntax, scripts, config
 * overrides and unrecognized options are never inferred safe. The caller must
 * use Athena's sandbox/argument-array executor with Git hooks/fsmonitor and
 * external diff/textconv disabled. This classification authorizes nothing. */
export function classifyCommandOperation(executable: string, args: readonly string[]): OperationRisk {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || /[\0\r\n;&|`$<>]/.test(arg))) return 'unknown'
  if (executable === 'echo') return 'read-only'
  if (args.length === 1 && (['node', 'npm', 'pnpm', 'yarn', 'python3', 'cargo', 'curl'].includes(executable) && args[0] === '--version' || ['node', 'npm', 'pnpm', 'yarn'].includes(executable) && args[0] === '-v')) return 'read-only'
  if (executable !== 'git' || !args.length) return 'unknown'
  const [command, ...options] = args
  if (command === 'status' && options.every(arg => ['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all', '--ignored', '--no-optional-locks'].includes(arg))) return 'read-only'
  if (command === 'branch') {
    if (options.every(arg => ['--list', '-a', '--all', '-r', '--remotes', '--show-current', '-v', '-vv', '--verbose', '--no-color'].includes(arg))) return 'read-only'
    if (options.some(arg => ['-d', '-D', '--delete', '-m', '-M', '--move'].includes(arg))) return 'destructive'
    if (options.length === 1 && /^[A-Za-z0-9][A-Za-z0-9/_-]{0,99}$/.test(options[0])) return 'non-idempotent'
    return 'unknown'
  }
  if (command === 'diff' && options.every(arg => ['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--cached', '--staged', '--check', '--no-ext-diff', '--no-textconv', '--no-color', '--exit-code', '--quiet'].includes(arg))) return 'read-only'
  if (command === 'log' && options.every(arg => ['--oneline', '--no-decorate', '--decorate', '--no-color', '--no-ext-diff', '--no-textconv'].includes(arg) || /^-(?:[1-9]\d{0,2})$/.test(arg) || /^--max-count=[1-9]\d{0,2}$/.test(arg))) return 'read-only'
  if (command === 'rev-parse' && options.length === 1 && ['--show-toplevel', '--is-inside-work-tree'].includes(options[0])) return 'read-only'
  if (['reset', 'clean', 'checkout', 'restore', 'rebase'].includes(command) || command === 'push' && options.some(arg => /^(?:--force|--force-with-lease|-f|--delete|--mirror)(?:=|$)/.test(arg))) return 'destructive'
  if (['commit', 'push', 'fetch', 'pull', 'merge', 'switch'].includes(command)) return 'non-idempotent'
  if (command === 'add') return 'idempotent'
  return 'unknown'
}
