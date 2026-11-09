import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Group } from 'three'
import { createSplashScene } from '../src/startup/splashScene'

const mock = vi.hoisted(() => ({
  load: vi.fn(), disposeModel: vi.fn(), renderers: [] as any[], controllers: [] as any[], observers: [] as any[],
}))
vi.mock('../src/three/vroidAssets', () => ({ loadVroidInstance: mock.load, disposeVroid: mock.disposeModel }))
vi.mock('../src/three/vroidAnimation', () => ({ VroidAnimationController: class {
  activeName = 'idle'
  dispose = vi.fn()
  update = vi.fn()
  play = vi.fn()
  constructor() { mock.controllers.push(this) }
} }))
vi.mock('three', async importOriginal => ({ ...await importOriginal<typeof import('three')>(), WebGLRenderer: class {
  domElement = document.createElement('canvas')
  renderLists = { dispose: vi.fn() }
  setAnimationLoop = vi.fn()
  setPixelRatio = vi.fn()
  setClearColor = vi.fn()
  setSize = vi.fn()
  render = vi.fn()
  dispose = vi.fn()
  forceContextLoss = vi.fn()
  constructor() { mock.renderers.push(this) }
} }))
beforeEach(() => {
  vi.clearAllMocks(); mock.renderers.length = 0; mock.controllers.length = 0; mock.observers.length = 0
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); constructor() { mock.observers.push(this) } })
})
afterEach(() => vi.unstubAllGlobals())
const instance = () => ({ vrm: { scene: new Group(), update: vi.fn() }, fit: { scale: 1, offsetY: 0 }, animationExpressionNames: {} })
const options = (signal: AbortSignal) => ({ signal, reduced: false, presentation: () => ({ durationMs: 6000, startedAt: Date.now(), stage: 'intro' as const }) })

describe('startup scene resource ownership', () => {
  it('loads only idle/wave once and releases the scene, mixer, GPU, and observer on abort', async () => {
    const model = instance(); mock.load.mockResolvedValue(model)
    const abort = new AbortController(), host = document.createElement('div')
    const cleanup = createSplashScene(host, options(abort.signal))
    await Promise.resolve()
    expect(mock.load).toHaveBeenCalledExactlyOnceWith(false, undefined, 'vroid-athena', { animations: ['idle', 'goodbye'], signal: abort.signal })
    expect(host.dataset.model).toBe('ready')
    abort.abort(); cleanup()
    expect(mock.controllers[0].dispose).toHaveBeenCalledOnce()
    expect(mock.disposeModel).toHaveBeenCalledExactlyOnceWith(model.vrm)
    expect(mock.renderers[0].setAnimationLoop).toHaveBeenLastCalledWith(null)
    expect(mock.renderers[0].dispose).toHaveBeenCalledOnce()
    expect(mock.renderers[0].forceContextLoss).toHaveBeenCalledOnce()
    expect(mock.observers[0].disconnect).toHaveBeenCalledOnce()
    expect(host.querySelector('canvas')).toBeNull()
  })
  it('disposes a model whose decode completes after the splash has closed', async () => {
    let resolve!: (value: unknown) => void
    mock.load.mockImplementation(() => new Promise(done => { resolve = done }))
    const cleanup = createSplashScene(document.createElement('div'), options(new AbortController().signal))
    cleanup()
    const model = instance(); resolve(model); await Promise.resolve()
    expect(mock.disposeModel).toHaveBeenCalledExactlyOnceWith(model.vrm)
    expect(mock.controllers).toHaveLength(0)
    expect(mock.renderers[0].dispose).toHaveBeenCalledOnce()
  })
  it('leaves the HTML presentation intact and releases WebGL after asset failure', async () => {
    mock.load.mockRejectedValue(new Error('Missing idle animation'))
    const host = document.createElement('div')
    createSplashScene(host, options(new AbortController().signal))
    await Promise.resolve(); await Promise.resolve()
    expect(host.dataset.fallback).toBe('true')
    expect(host.querySelector('canvas')).toBeNull()
    expect(mock.renderers[0].dispose).toHaveBeenCalledOnce()
  })
})
