import { describe, expect, it } from 'vitest'
import { parseLocalIntent, transition } from '../shared/behavior'
import { commandSchema } from '../shared/contracts'

describe('companion behavior', () => {
  it('transitions from rest through movement and acknowledgment', () => {
    expect(transition('idle', 'MOVE')).toBe('moving')
    expect(transition('floating', 'DRAG')).toBe('moving')
    expect(transition('moving', 'ACKNOWLEDGE')).toBe('happy')
    expect(transition('happy', 'REST')).toBe('idle')
  })
  it('does not interrupt listening or work with random motion', () => {
    expect(transition('listening', 'MOVE')).toBe('listening')
    expect(transition('working', 'MOVE')).toBe('working')
    expect(transition('speaking', 'SLEEP')).toBe('speaking')
  })
  it('can enter an error state and recover', () => {
    expect(transition('working', 'FAIL')).toBe('error')
    expect(transition('error', 'REST')).toBe('idle')
  })
})
describe('approved command routing', () => {
  it.each([['Athena, stay here.', 'pin'], ['Resume floating', 'unpin'], ['make yourself smaller', 'smaller'], ['Open your settings', 'open-settings'], ['Stop floating', 'pin']])('routes %s', (input, expected) => {
    expect(parseLocalIntent(input)).toBe(expected)
  })
  it('does not infer actions from arbitrary prose or shell input', () => {
    expect(parseLocalIntent('do not hide')).toBe('unknown')
    expect(parseLocalIntent('open settings && rm -rf /')).toBe('unknown')
    expect(parseLocalIntent('Run Terminal')).toBe('unknown')
    expect(commandSchema.safeParse('exec').success).toBe(false)
    expect(commandSchema.safeParse({ command: 'show' }).success).toBe(false)
  })
})
