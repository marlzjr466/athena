// @vitest-environment node
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
const ps = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync: ps }))
import { managedProcessLifecycle, ownsDetachedProcess } from '../electron/main/ai/ownedProcess'

const child = (pid = 987654) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }) as ChildProcess
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); ps.mockReset() })
describe('owned detached process lifecycle', () => {
  it('never owns Athena, its parent, another parent, or a shared process group', () => {
    expect(ownsDetachedProcess(child(process.pid))).toBe(false)
    expect(ownsDetachedProcess(child(process.ppid))).toBe(false)
    ps.mockReturnValue(`1 987654`)
    expect(ownsDetachedProcess(child())).toBe(false)
    ps.mockReturnValue(`${process.pid} ${process.pid}`)
    expect(ownsDetachedProcess(child())).toBe(false)
    ps.mockReturnValue(`${process.pid} 987654`)
    expect(ownsDetachedProcess(child())).toBe(true)
  })
  it('waits for exit, cleans once, and never sends a delayed kill after close', async () => {
    vi.useFakeTimers()
    const processChild = child(), cleanup = vi.fn()
    ps.mockReturnValue(`${process.pid} 987654`)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const lifecycle = managedProcessLifecycle(processChild, cleanup)
    const stopped = lifecycle.dispose()
    expect(lifecycle.dispose()).toBe(stopped)
    expect(kill).toHaveBeenCalledWith(-987654, 'SIGTERM')
    processChild.emit('close', 0)
    await stopped
    await vi.advanceTimersByTimeAsync(3000)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledOnce()
  })
  it('reports an unowned live process without signalling it', async () => {
    vi.useFakeTimers()
    ps.mockReturnValue(`1 987654`)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const stopped = managedProcessLifecycle(child(), vi.fn()).dispose()
    const assertion = expect(stopped).rejects.toThrow('replacement was not started')
    await vi.advanceTimersByTimeAsync(2100)
    await assertion
    expect(kill).not.toHaveBeenCalled()
  })
})
