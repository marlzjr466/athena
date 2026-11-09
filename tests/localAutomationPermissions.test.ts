import { describe, expect, it, vi } from 'vitest'
import type { ProjectTools } from '../electron/main/ai/AIProvider'
import { gateLocalTools } from '../electron/main/ai/chatContextService'
import { automationPermissionDefaults } from '../shared/automation'

function fixture() {
  const permissions = { ...automationPermissionDefaults }
  const base: ProjectTools = {
    definitions: [
      { name: 'read_file', description: 'read', parameters: {} },
      { name: 'edit_file', description: 'edit', parameters: {} },
      { name: 'delete_file', description: 'delete', parameters: {} },
      { name: 'web_search', description: 'search', parameters: {} },
      { name: 'open_application', description: 'open', parameters: {} },
      { name: 'get_current_datetime', description: 'clock', parameters: {} },
      { name: 'athena_navigate', description: 'native action', parameters: {} },
    ],
    assertAccess: vi.fn(),
    execute: vi.fn(async name => name),
  }
  return { permissions, base, gated: gateLocalTools(base, () => permissions) }
}

describe('local automation permission enforcement', () => {
  it('filters file, browser, desktop and destructive operations while preserving local clock and registry tools', () => {
    const { gated } = fixture()
    expect(gated.definitions.map(tool => tool.name)).toEqual(['get_current_datetime', 'athena_navigate'])
  })

  it('rechecks permission state at execution time even after a tool was advertised', async () => {
    const { permissions, base } = fixture()
    permissions.fileReading = true
    const current = gateLocalTools(base, () => permissions)
    expect(current.definitions.map(tool => tool.name)).toContain('read_file')
    permissions.fileReading = false
    await expect(current.execute('read_file', {}, new AbortController().signal)).rejects.toThrow('fileReading')
    expect(base.execute).not.toHaveBeenCalled()
  })

  it('requires both file modification and destructive permission for deletes', async () => {
    const { permissions, base } = fixture()
    permissions.fileModification = true
    const current = gateLocalTools(base, () => permissions)
    await expect(current.execute('delete_file', {}, new AbortController().signal)).rejects.toThrow('destructiveOperations')
    expect(base.execute).not.toHaveBeenCalled()
  })
})
