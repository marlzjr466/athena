import { checkCommandArgs, executableFingerprint, packageFingerprint } from './sandboxCommandPermission'
import { sensitivePath } from '../ai/workspaceService'
import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { rememberedCommandSchema, rememberedScopeSchema, rememberedStateSchema, type RememberedScope, type RememberedState } from '../../../shared/permissions'
import { APPLICATIONS } from '../../../shared/desktopActions'
import type { PermissionPreferencesStore } from './permissionRepository'
import { log } from '../logger'

const empty = (): RememberedState => ({ enabled: true, rules: [] })
const inside = (root: string, target: string) => { const rel = relative(root, target); return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
function canonical(path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw new Error('Invalid scope path')
  let stat
  try { stat = lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return resolve(canonical(dirname(path)), basename(path))
  }
  if (stat.isSymbolicLink()) throw new Error('Symlink targets cannot be remembered')
  return realpathSync(path)
}
// Intentionally narrower than general file access: hidden configuration, key
// material and credential-looking targets can never receive remembered grants.
function ordinary(root: string, target: string): boolean {
  return inside(root, target) && !sensitivePath(target) && !relative(root, target).split(/[\\/]/).some(part => part.startsWith('.') || /(?:credential|secret|token|password|private.?key|id_rsa|id_ed25519|\.pem$|\.key$|\.p12$|\.pfx$)/i.test(part))
}
export function normalizeRememberedScope(input: unknown): RememberedScope | undefined {
  const parsed = rememberedScopeSchema.safeParse(input)
  if (!parsed.success) return undefined
  const scope = parsed.data
  if (scope.operation !== 'sandbox_check_command' && scope.command) return undefined
  try {
    const app = scope.operation === 'open_application' || scope.operation === 'focus_application'
    const browser = scope.operation === 'open_url'
    if (app || browser) {
      if (scope.project !== 'desktop' || scope.projectIdentity !== undefined || scope.resources.length !== 1) return undefined
      if (app) { if (!Object.hasOwn(APPLICATIONS, scope.resources[0])) return undefined }
      else {
        const url = new URL(scope.resources[0])
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /(?:token|secret|password|credential|oauth|callback|reset)/i.test(url.pathname)) return undefined
        scope.resources = [url.href]
      }
      return scope
    }
    const root = realpathSync(scope.project)
    if (!lstatSync(root).isDirectory() || root === dirname(root) || root.split(/[\\/]/).some(part => part.startsWith('.') || /^(?:etc|System|Library|Windows)$/i.test(part))) return undefined
    const info = lstatSync(root)
    const projectIdentity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
    if (scope.projectIdentity && scope.projectIdentity !== projectIdentity) return undefined
    if (scope.operation === 'sandbox_check_command') {
      const command = scope.command
      if (!command || scope.resources.length !== 1 || scope.resources[0] !== root || !checkCommandArgs(command.manager, command.args)
        || packageFingerprint(root) !== command.packageHash || executableFingerprint(command.executable) !== command.executableIdentity) return undefined
      return { operation: scope.operation, project: root, projectIdentity, resources: [root], command }
    }
    const resources = scope.resources.map(canonical)
    if (resources.some(target => !ordinary(root, target))) return undefined
    return { operation: scope.operation, project: root, projectIdentity, resources: [...new Set(resources)].sort() }
  } catch { return undefined }
}
const key = (scope: RememberedScope) => JSON.stringify(scope)

/** Part of PermissionService; storage remains the existing permissions.json. */
export class RememberedPermissions {
  private state: RememberedState
  constructor(private repository: PermissionPreferencesStore) {
    const restored = rememberedStateSchema.safeParse(repository.loadRemembered?.())
    this.state = restored.success ? restored.data : empty()
  }
  snapshot(): RememberedState { return structuredClone(this.state) }
  eligible(input: unknown): RememberedScope | undefined {
    return this.state.enabled && this.repository.saveRemembered ? normalizeRememberedScope(input) : undefined
  }
  allows(input: unknown, context: { sessionId?: string; origin?: string; taskId?: string } = {}): boolean {
    const scope = this.eligible(input)
    if (!scope) return false
    const rule = this.state.rules.find(rule => !rule.revokedAt && key(rule.scope) === key(scope) && JSON.stringify(normalizeRememberedScope(rule.scope)) === key(rule.scope))
    if (!rule) return false
    log('permission.automatic_approval', { ruleId: rule.id, operation: scope.operation, ...context })
    return true
  }
  grant(input: unknown): void {
    const scope = this.eligible(input)
    if (!scope) throw new Error('This permission cannot be remembered. Use Allow once.')
    if (this.state.rules.some(rule => !rule.revokedAt && key(rule.scope) === key(scope))) return
    if (this.state.rules.length >= 2000) throw new Error('Remembered permission history is full. Use Allow once.')
    const rule = { id: randomUUID(), scope, grantedAt: Date.now() }
    this.save({ ...this.state, rules: [...this.state.rules, rule] })
    log('permission.granted', { ruleId: rule.id, operation: scope.operation })
  }
  command(input: unknown): void {
    const command = rememberedCommandSchema.parse(input)
    if (command.action === 'enable') { this.save({ ...this.state, enabled: command.enabled }); log('permission.remembering_changed', { enabled: command.enabled }); return }
    const rules = this.state.rules.map(rule => !rule.revokedAt && (command.action === 'revoke-all' || rule.id === command.id) ? { ...rule, revokedAt: Date.now() } : rule)
    this.save({ ...this.state, rules })
    log('permission.revoked', { ruleId: command.action === 'revoke' ? command.id : 'all' })
  }
  private save(state: RememberedState): void {
    if (!this.repository.saveRemembered) throw new Error('Permission storage unavailable')
    this.repository.saveRemembered(state)
    this.state = state
  }
}
