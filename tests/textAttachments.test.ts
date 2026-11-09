import { describe, expect, it } from 'vitest'
import { inferPastedTextName } from '../shared/textAttachments'

describe('pasted text attachment naming', () => {
  it('detects common code and log formats without changing content', () => {
    expect(inferPastedTextName('```typescript\nconst value = 1\n```')).toBe('Pasted code.ts')
    expect(inferPastedTextName('{"ok":true}')).toBe('Pasted code.json')
    expect(inferPastedTextName('ERROR request failed\nstack trace')).toBe('Pasted code.log')
  })
  it('avoids collisions in the same composer', () => {
    expect(inferPastedTextName('hello', ['Pasted text.txt'])).toBe('Pasted text (2).txt')
  })
})
