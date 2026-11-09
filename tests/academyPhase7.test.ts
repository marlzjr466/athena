// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { academyModules, relevantAcademyModules } from '../shared/academyModules'

describe('Phase 7 guidance stays model-scoped and permission-neutral', () => {
  it('registers opt-in productivity, meeting, interview and examination guidance', () => {
    const ids = academyModules.map(item => item.id)
    expect(ids).toEqual(expect.arrayContaining(['google-workspace', 'microsoft-365', 'meeting-intelligence', 'interview-practice', 'coding-exam-practice']))
    expect(new Set(ids).size).toBe(ids.length)
    expect(academyModules.filter(item => ids.slice(-5).includes(item.id)).every(item => item.kind === 'skill')).toBe(true)
  })
  it('routes only relevant installed guidance and does not imply an account connection', () => {
    const enabled = ['google-workspace', 'microsoft-365', 'meeting-intelligence', 'interview-practice', 'coding-exam-practice'] as const
    const gmail = relevantAcademyModules(enabled, 'Draft a Gmail reply', false)
    expect(gmail.map(item => item.id)).toEqual(['google-workspace'])
    expect(gmail[0].instructions).toContain('No Google account connector')
    expect(relevantAcademyModules(enabled, 'Summarize this meeting transcript', false).map(item => item.id)).toEqual(['meeting-intelligence'])
    expect(relevantAcademyModules(enabled, 'Practice my interview', false).map(item => item.id)).toEqual(['interview-practice'])
    expect(relevantAcademyModules(enabled, 'Help with a coding challenge', false).map(item => item.id)).toEqual(['coding-exam-practice'])
    expect(relevantAcademyModules([], 'Draft a Gmail reply', false)).toEqual([])
  })
})
