import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useVroidInstance } from '../src/three/useVroidInstance'

const mock = vi.hoisted(() => ({
  load: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock('../src/three/vroidAssets', () => ({
  loadVroidInstance: mock.load,
  disposeVroid: mock.dispose,
}))

beforeEach(() => vi.clearAllMocks())

describe('VRoid instance lifecycle', () => {
  it('retains outgoing VRM until the switch commits and disposes every independent scene', async () => {
    const first = { vrm: { name: 'first' }, clips: {}, animationErrors: {} }
    const second = { vrm: { name: 'second' }, clips: {}, animationErrors: {} }
    let resolveSecond!: (value: unknown) => void
    mock.load.mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve }))
    const view = renderHook(({ id }) => useVroidInstance(true, true, id), { initialProps: { id: 'vroid-athena' } })
    await waitFor(() => expect(view.result.current.instance).toBe(first))
    view.rerender({ id: 'imported-00000000-0000-4000-8000-000000000001' })
    expect(view.result.current.instance).toBeNull()
    expect(view.result.current.getInstance('vroid-athena')).toBe(first)
    expect(mock.dispose).not.toHaveBeenCalled()
    await act(async () => resolveSecond(second))
    expect(view.result.current.instance).toBe(second)
    act(() => view.result.current.displayed('imported-00000000-0000-4000-8000-000000000001'))
    expect(mock.dispose).toHaveBeenCalledExactlyOnceWith(first.vrm)
    view.unmount()
    expect(mock.dispose).toHaveBeenCalledWith(second.vrm)
  })
  it('restarts a cancelled load across React StrictMode effect remounts', async () => {
    const requests: Array<(value: unknown) => void> = []
    mock.load.mockImplementation(() => new Promise(resolve => requests.push(resolve)))
    const view = renderHook(() => useVroidInstance(true), { wrapper: StrictMode })
    expect(mock.load).toHaveBeenCalledTimes(2)
    const stale = { vrm: { name: 'stale' } }
    requests[0](stale)
    await waitFor(() => expect(mock.dispose).toHaveBeenCalledWith(stale.vrm))
    const current = { vrm: { name: 'current' } }
    requests[1](current)
    await waitFor(() => expect(view.result.current.instance).toBe(current))
    expect(view.result.current.status).toBe('ready')
    view.unmount()
    expect(mock.dispose).toHaveBeenCalledWith(current.vrm)
  })
})
