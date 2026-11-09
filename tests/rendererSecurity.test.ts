import { describe, expect, it } from 'vitest'
import { matchesRendererURL } from '../electron/main/rendererSecurity'

describe('exact renderer document authorization', () => {
  it('accepts only the exact packaged Athena renderer document', () => {
    const expected = 'athena://renderer/index.html?surface=floating'
    expect(matchesRendererURL(expected, expected)).toBe(true)
    expect(matchesRendererURL(`${expected}#voice`, expected)).toBe(true)
    for (const url of ['athena://other/index.html?surface=floating', 'athena://renderer/vad-assets/model.onnx', 'athena://renderer.evil/index.html?surface=floating']) expect(matchesRendererURL(url, expected)).toBe(false)
  })
  it('accepts only the configured file and surface, allowing internal hash navigation', () => {
    const expected = 'file:///Applications/Athena.app/Contents/Resources/app.asar/out/renderer/index.html?surface=control'
    expect(matchesRendererURL(expected, expected)).toBe(true)
    expect(matchesRendererURL(expected + '#settings', expected)).toBe(true)
    for (const url of ['file:///tmp/untrusted.html', expected.replace('control', 'floating'), expected + '&extra=1', 'data:text/html,test', 'invalid']) expect(matchesRendererURL(url, expected)).toBe(false)
    expect(matchesRendererURL(expected, undefined)).toBe(false)
  })
  it('does not trust every route on the development origin', () => {
    const expected = 'http://localhost:5173/?surface=control'
    expect(matchesRendererURL(expected, expected)).toBe(true)
    for (const url of ['http://localhost:5173/other?surface=control', 'http://localhost:5174/?surface=control', 'http://localhost.evil:5173/?surface=control', 'http://user@localhost:5173/?surface=control']) expect(matchesRendererURL(url, expected)).toBe(false)
  })
})
