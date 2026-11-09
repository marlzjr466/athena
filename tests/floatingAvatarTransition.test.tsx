import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FloatingAvatarTransition } from '../src/three/FloatingAvatarTransition'

const runtime = vi.hoisted(() => ({ frame: () => {}, invalidate: vi.fn(), gl: { domElement: { style: { opacity: '1' } } }, time: 0 }))
vi.mock('@react-three/fiber', () => ({
  useThree: () => runtime,
  useFrame: (callback: () => void) => { runtime.frame = callback },
}))
beforeEach(() => {
  runtime.time = 0
  runtime.gl.domElement.style.opacity = '1'
  runtime.invalidate.mockClear()
  vi.spyOn(performance, 'now').mockImplementation(() => runtime.time)
})
const child = (variant: string) => <span data-testid="displayed">{variant}</span>
function tick(ms: number) { act(() => { runtime.time += ms; runtime.frame() }) }
function rig(container: HTMLElement) { Object.assign(container.querySelector('group')!, { rotation: { y: 0 } }) }

describe('shared avatar transition', () => {
  it('uses the same out/in transition for independent imported model IDs', () => {
    const first = 'imported-00000000-0000-4000-8000-000000000001'
    const second = 'imported-00000000-0000-4000-8000-000000000002'
    const view = render(<FloatingAvatarTransition variant={first} reduced={false}>{child}</FloatingAvatarTransition>)
    rig(view.container)
    view.rerender(<FloatingAvatarTransition variant={second} ready={false} reduced={false}>{child}</FloatingAvatarTransition>)
    tick(1000)
    expect(screen.getByTestId('displayed')).toHaveTextContent(first)
    view.rerender(<FloatingAvatarTransition variant={second} ready reduced={false}>{child}</FloatingAvatarTransition>)
    tick(16); tick(450); tick(450)
    expect(screen.getByTestId('displayed')).toHaveTextContent(second)
    expect(runtime.gl.domElement.style.opacity).toBe('1')
  })
  it('does not substitute Classic for a saved VRoid selection while it loads', () => {
    const view = render(<FloatingAvatarTransition variant="vroid-athena" reduced={false} ready={false}>{child}</FloatingAvatarTransition>)
    rig(view.container)
    tick(16)
    expect(screen.queryByTestId('displayed')).toBeNull()
    view.rerender(<FloatingAvatarTransition variant="vroid-athena" reduced={false} ready>{child}</FloatingAvatarTransition>)
    tick(16)
    expect(screen.getByTestId('displayed')).toHaveTextContent('vroid-athena')
    tick(220)
    expect(Number(runtime.gl.domElement.style.opacity)).toBeGreaterThan(0)
    expect(Number(runtime.gl.domElement.style.opacity)).toBeLessThan(1)
    tick(250)
    expect(runtime.gl.domElement.style.opacity).toBe('1')
  })
  it('holds the outgoing avatar until ready, rotates both ways, and self-invalidates demand frames', () => {
    const view = render(<FloatingAvatarTransition variant="classic" reduced={false}>{child}</FloatingAvatarTransition>)
    rig(view.container)
    view.rerender(<FloatingAvatarTransition variant="vroid-athena" reduced={false} ready={false}>{child}</FloatingAvatarTransition>)
    tick(1000)
    expect(screen.getByTestId('displayed')).toHaveTextContent('classic')
    view.rerender(<FloatingAvatarTransition variant="vroid-athena" reduced={false} ready>{child}</FloatingAvatarTransition>)
    tick(16); tick(220)
    expect((view.container.querySelector('group') as unknown as { rotation: { y: number } }).rotation.y).toBeGreaterThan(0)
    expect(runtime.invalidate).toHaveBeenCalled()
    tick(240)
    expect(screen.getByTestId('displayed')).toHaveTextContent('vroid-athena')
    tick(220)
    expect((view.container.querySelector('group') as unknown as { rotation: { y: number } }).rotation.y).toBeLessThan(0)
    tick(250)
    view.rerender(<FloatingAvatarTransition variant="enhanced" reduced={false}>{child}</FloatingAvatarTransition>)
    tick(16); tick(450); tick(450)
    expect(screen.getByTestId('displayed')).toHaveTextContent('enhanced')
    expect(runtime.gl.domElement.style.opacity).toBe('1')
  })
  it('settles on the latest selection after rapid reversals and cleans up opacity', () => {
    const view = render(<FloatingAvatarTransition variant="vroid-athena" reduced={false}>{child}</FloatingAvatarTransition>)
    rig(view.container)
    view.rerender(<FloatingAvatarTransition variant="classic" reduced={false}>{child}</FloatingAvatarTransition>)
    tick(16); tick(200)
    view.rerender(<FloatingAvatarTransition variant="enhanced" reduced={false}>{child}</FloatingAvatarTransition>)
    tick(250)
    view.rerender(<FloatingAvatarTransition variant="vroid-athena" reduced={false}>{child}</FloatingAvatarTransition>)
    tick(450); tick(16); tick(450); tick(450)
    expect(screen.getByTestId('displayed')).toHaveTextContent('vroid-athena')
    expect(runtime.gl.domElement.style.opacity).toBe('1')
    view.unmount()
    expect(runtime.gl.domElement.style.opacity).toBe('1')
  })
})
