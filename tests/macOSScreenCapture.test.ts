// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const os = vi.hoisted(() => ({ displays: vi.fn(), permission: vi.fn(), sources: vi.fn() }))
vi.mock('electron', () => ({ screen: { getAllDisplays: os.displays }, systemPreferences: { getMediaAccessStatus: os.permission }, desktopCapturer: { getSources: os.sources } }))
import { MacOSScreenCapture } from '../electron/main/screenCapture/macOSScreenCapture'
import { MAX_SCREEN_IMAGE_BYTES } from '../electron/main/screenCapture/screenCapturePlatform'

const display = { id: 42, bounds: { width: 1920, height: 1080 } }
const image = () => ({ isEmpty: () => false, getSize: () => ({ width: 1600, height: 900 }), toJPEG: () => Buffer.from('test-image'), resize: vi.fn() })
beforeEach(() => { vi.resetAllMocks(); os.displays.mockReturnValue([display]); os.permission.mockReturnValue('granted'); os.sources.mockResolvedValue([{ display_id: '42', thumbnail: image() }]) })

describe('macOS one-shot screen capture', () => {
  it('captures screen thumbnails once, never windows/audio, with bounded dimensions', async () => {
    const platform = new MacOSScreenCapture('darwin')
    const frames = await platform.capture(platform.displays(), new AbortController().signal)
    expect(os.sources).toHaveBeenCalledExactlyOnceWith({ types: ['screen'], thumbnailSize: { width: 1600, height: 1600 }, fetchWindowIcons: false })
    expect(frames[0]).toMatchObject({ width: 1600, height: 900, display: { id: '42' }, dataURL: `data:image/jpeg;base64,${Buffer.from('test-image').toString('base64')}` })
    platform.dispose()
  })
  it('blocks denied OS access before capture', async () => {
    const platform = new MacOSScreenCapture('darwin'); os.permission.mockReturnValue('denied')
    await expect(platform.capture(platform.displays(), new AbortController().signal)).rejects.toThrow('Screen Recording')
    expect(os.sources).not.toHaveBeenCalled()
  })
  it('never substitutes an unapproved display if topology changed', async () => {
    const platform = new MacOSScreenCapture('darwin'), approved = platform.displays()
    os.displays.mockReturnValue([{ ...display, id: 7 }])
    await expect(platform.capture(approved, new AbortController().signal)).rejects.toThrow('displays changed')
    expect(os.sources).not.toHaveBeenCalled()
  })
  it('rejects missing, empty and oversized images', async () => {
    const platform = new MacOSScreenCapture('darwin'), signal = new AbortController().signal
    os.sources.mockResolvedValueOnce([{ display_id: 'other', thumbnail: image() }])
    await expect(platform.capture(platform.displays(), signal)).rejects.toThrow('no image')
    os.sources.mockResolvedValueOnce([{ display_id: '42', thumbnail: { ...image(), isEmpty: () => true } }])
    await expect(platform.capture(platform.displays(), signal)).rejects.toThrow('no image')
    os.sources.mockResolvedValueOnce([{ display_id: '42', thumbnail: { ...image(), toJPEG: () => Buffer.alloc(MAX_SCREEN_IMAGE_BYTES + 1) } }])
    await expect(platform.capture(platform.displays(), signal)).rejects.toThrow('size limit')
  })
  it('cancels a stalled capture, drops late results and prevents overlapping native calls', async () => {
    const platform = new MacOSScreenCapture('darwin'), abort = new AbortController()
    let finish!: (value: unknown[]) => void
    os.sources.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const pending = platform.capture(platform.displays(), abort.signal)
    await Promise.resolve(); abort.abort()
    await expect(pending).rejects.toThrow('cancelled')
    await expect(platform.capture(platform.displays(), new AbortController().signal)).rejects.toThrow('still finishing')
    finish([{ display_id: '42', thumbnail: image() }]); await Promise.resolve()
    expect(os.sources).toHaveBeenCalledTimes(1)
  })
  it('enforces a native capture timeout and shutdown cancellation', async () => {
    vi.useFakeTimers()
    const timeout = new AbortController(), stub = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    try {
      const platform = new MacOSScreenCapture('darwin')
      os.sources.mockReturnValue(new Promise(() => {}))
      const pending = platform.capture(platform.displays(), new AbortController().signal)
      await Promise.resolve(); timeout.abort()
      await expect(pending).rejects.toThrow('timed out')
      platform.dispose()
      await expect(platform.capture(platform.displays(), new AbortController().signal)).rejects.toThrow()
    } finally { stub.mockRestore(); vi.useRealTimers() }
  })
  it('does not claim unsupported platforms can capture', () => {
    expect(() => new MacOSScreenCapture('linux').displays()).toThrow('macOS only')
  })
})
