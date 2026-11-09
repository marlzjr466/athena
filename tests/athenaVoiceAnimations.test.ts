import { describe, expect, it } from 'vitest'
import { Group } from 'three'
import { animateAthena, type AnimationOptions } from '../src/three/AthenaAnimations'

const base: AnimationOptions = { state: 'idle', intensity: 1, hover: true, reduced: false }

function settle(body: Group, head: Group, options: AnimationOptions) {
  for (let i = 0; i < 35; i++) animateAthena(body, head, i / 30, 1 / 30, options)
}

describe('voice-priority character poses', () => {
  it('leans and tilts toward the user immediately on listening, even if a stale flight remains', () => {
    const body = new Group(), head = new Group()
    settle(body, head, { ...base, state: 'listening', flight: {} as AnimationOptions['flight'] })
    expect(body.rotation.x).toBeGreaterThan(0.04)
    expect(head.rotation.z).toBeLessThan(-0.07)
    expect(head.rotation.x).toBeLessThan(-0.04)
    expect(body.position.y).not.toBe(0)
  })
  it('transitions back toward neutral without a snapped frozen pose', () => {
    const body = new Group(), head = new Group()
    settle(body, head, { ...base, state: 'listening' })
    const tilt = head.rotation.z
    animateAthena(body, head, 2, 1 / 30, base)
    expect(head.rotation.z).toBeGreaterThan(tilt)
    expect(head.rotation.z).toBeLessThan(0)
    settle(body, head, base)
    expect(Math.abs(body.rotation.x)).toBeLessThan(0.005)
  })
})
