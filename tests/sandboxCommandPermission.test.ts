// @vitest-environment node
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sandboxCommandScope } from '../electron/main/permissions/sandboxCommandPermission'
import { RememberedPermissions } from '../electron/main/permissions/rememberedPermissions'
import { PermissionRepository } from '../electron/main/permissions/permissionRepository'
import type { CommandRequest } from '../electron/main/ai/agentCommands'
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'athena-check-grant-'))); dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
  const executable = join(root, 'npm'); writeFileSync(executable, 'fixture executable')
  const request: CommandRequest = { executable: 'npm', args: ['test', '--', '__tests__/src/pages/registry/model/lifecycleAvailability.test.ts', '__tests__/src/pages/registry/model/miniAppRequestFreeze.test.ts', '__tests__/src/pages/registry/registry-app-detail/actionAvailability.test.ts', '--watchman=false', '--coverage=false'], network: false, install: false, gitWrite: false, filesystemMode: 'project-only' }
  const scope = sandboxCommandScope(root, request, executable, 'cursor-terminal')!
  const permissions = new RememberedPermissions(new PermissionRepository(join(root, 'preferences')))
  return { root, executable, request, scope, permissions }
}
describe('remembered offline check commands', () => {
  it('offers a scope for the exact screenshot command and restores matching approval from disk', () => {
    const f = fixture(); expect(f.scope).toBeDefined(); f.permissions.grant(f.scope)
    expect(new RememberedPermissions(new PermissionRepository(join(f.root, 'preferences'))).allows(f.scope)).toBe(true)
    expect(f.permissions.allows({ ...f.scope, command: { ...f.scope.command, args: ['test', '--', 'other.test.ts'] } })).toBe(false)
    expect(f.permissions.allows({ ...f.scope, command: { ...f.scope.command, tool: 'execute_command' } })).toBe(false)
    f.permissions.command({ action: 'revoke-all' }); expect(f.permissions.allows(f.scope)).toBe(false)
  })
  it.each([{ network: true }, { loopback: true }, { install: true }, { gitWrite: true }, { localServer: true }, { filesystemMode: 'full-read-write' as const }, { approvedReadPaths: ['/tmp/credentials.json'] }])('does not remember expanded privileges: %j', extra => {
    const f = fixture(); expect(sandboxCommandScope(f.root, { ...f.request, ...extra }, f.executable, 'cursor-terminal')).toBeUndefined()
  })
  it.each([['install'], ['run', 'deploy'], ['exec', 'node'], ['test', '--prefix=/elsewhere'], ['test', '--', '../outside.ts'], ['test', '--', '--updateSnapshot'], ['test', '--', '--fix'], ['test', '--', '--config=other.js']])('rejects unsafe or unrecognized command %j', (...args) => {
    const f = fixture(); expect(sandboxCommandScope(f.root, { ...f.request, args }, f.executable, 'cursor-terminal')).toBeUndefined()
  })
  it('invalidates a grant when package scripts or the executable change', () => {
    const f = fixture(); f.permissions.grant(f.scope)
    writeFileSync(join(f.root, 'package.json'), '{"scripts":{"test":"different-command"}}')
    expect(f.permissions.allows(f.scope)).toBe(false)
    const updated = sandboxCommandScope(f.root, f.request, f.executable, 'cursor-terminal')!
    expect(f.permissions.allows(updated)).toBe(false)
    f.permissions.grant(updated); writeFileSync(f.executable, 'updated executable content')
    expect(f.permissions.allows(updated)).toBe(false)
  })
})
