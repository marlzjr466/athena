import { describe, expect, it } from 'vitest'
import { projectCommandLease } from '../electron/main/ai/projectCommandLease'

describe('project command coordination', () => {
  it('serializes one project while another project remains independent', async () => {
    const signal = new AbortController().signal
    const first = await projectCommandLease.acquire('/project/a', signal)
    let secondStarted = false
    const second = projectCommandLease.acquire('/project/a', signal).then(release => { secondStarted = true; return release })
    const independent = await projectCommandLease.acquire('/project/b', signal)
    expect(secondStarted).toBe(false)
    independent(); first()
    const release = await second
    expect(secondStarted).toBe(true)
    release()
  })

  it('removes a cancelled waiter without taking the next lease', async () => {
    const first = await projectCommandLease.acquire('/project/c', new AbortController().signal)
    const cancelled = new AbortController()
    const waiting = projectCommandLease.acquire('/project/c', cancelled.signal)
    cancelled.abort()
    await expect(waiting).rejects.toThrow('cancelled')
    first()
    const next = await projectCommandLease.acquire('/project/c', new AbortController().signal)
    next()
  })
})
