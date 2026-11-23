// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SecureCredentialEntries } from '../electron/main/ai/secureCredentialEntry'

describe('shared credential retrieval', () => {
  it('coalesces concurrent startup reads across service instances', async () => {
    const transport = vi.fn(async (_request: { operation: string }) => 'test-only-value')
    const store = new SecureCredentialEntries(transport)
    await Promise.all(Array.from({ length: 10 }, () => store.entry('service', 'account').getPassword()))
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith({ operation: 'read', service: 'service', account: 'account' })
  })
  it('preserves authorization failure and never creates a missing replacement', async () => {
    const transport = vi.fn(async (_request: { operation: string }) => { throw new Error('Access denied') })
    const store = new SecureCredentialEntries(transport)
    await expect(store.entry('service', 'account').getPassword()).rejects.toThrow('Access denied')
    await expect(store.entry('service', 'account').getPassword()).rejects.toThrow('Access denied')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('distinguishes a missing item and updates the cached value only after a successful write', async () => {
    const transport = vi.fn(async (_request: { operation: string }) => null)
    const entry = new SecureCredentialEntries(transport).entry('service', 'account')
    expect(await entry.getPassword()).toBeNull()
    await entry.setPassword('new-test-only-value')
    expect(await entry.getPassword()).toBe('new-test-only-value')
    transport.mockRejectedValueOnce(new Error('Locked'))
    await expect(entry.setPassword('failed-value')).rejects.toThrow('Locked')
    expect(await entry.getPassword()).toBe('new-test-only-value')
    expect(transport.mock.calls.map(([r]) => r.operation)).toEqual(['read', 'write', 'write'])
  })
  it('reads again in a new app process without writing or deleting existing credentials', async () => {
    const transport = vi.fn(async (_request: { operation: string }) => 'test-only-value')
    for (let restart = 0; restart < 3; restart++) {
      expect(await new SecureCredentialEntries(transport).entry('service', 'account').getPassword()).toBe('test-only-value')
    }
    expect(transport).toHaveBeenCalledTimes(3)
    expect(transport.mock.calls.every(([r]) => r.operation === 'read')).toBe(true)
  })
})
