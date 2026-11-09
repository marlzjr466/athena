import { desktopCapturer, screen, systemPreferences } from 'electron'
import { ChatError } from '../ai/AIProvider'
import { MAX_CAPTURE_DISPLAYS, MAX_SCREEN_IMAGE_BYTES, SCREEN_CAPTURE_SIZE, type CaptureDisplay, type ScreenCapturePlatform, type ScreenImage } from './screenCapturePlatform'

export class MacOSScreenCapture implements ScreenCapturePlatform {
  private abort = new AbortController()
  private busy = false
  constructor(private platform = process.platform) {}
  displays(): CaptureDisplay[] {
    if (this.platform !== 'darwin') throw new ChatError('Screen awareness currently supports macOS only.')
    return screen.getAllDisplays().map((display, index) => ({ id: String(display.id), name: `Display ${index + 1}`, width: display.bounds.width, height: display.bounds.height }))
  }
  async capture(approved: CaptureDisplay[], signal: AbortSignal): Promise<ScreenImage[]> {
    const check = () => {
      signal.throwIfAborted(); this.abort.signal.throwIfAborted()
      if (this.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') !== 'granted') throw new ChatError('Screen Recording access is not allowed. Review Settings → Privacy and macOS System Settings, then retry.')
      if (!approved.length || approved.length > MAX_CAPTURE_DISPLAYS) throw new ChatError(`Screen capture supports 1–${MAX_CAPTURE_DISPLAYS} connected displays.`)
      if (JSON.stringify(this.displays()) !== JSON.stringify(approved)) throw new ChatError('Connected displays changed after approval. Ask again to approve the new display layout.')
    }
    check()
    if (this.busy) throw new ChatError('A screen capture is still finishing. Wait a moment before retrying.')
    this.busy = true
    // Electron returns thumbnails for all screens. Approval explicitly covers
    // all connected displays; no window titles, icons or audio are requested.
    const operation = Promise.resolve().then(() => { check(); return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: SCREEN_CAPTURE_SIZE, height: SCREEN_CAPTURE_SIZE }, fetchWindowIcons: false }) })
      .finally(() => { this.busy = false })
    const deadline = AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(10_000)])
    const sources = await new Promise<Awaited<typeof operation>>((resolve, reject) => {
      const cancelled = () => reject(new ChatError('Screen capture cancelled or timed out. No image was sent.'))
      deadline.addEventListener('abort', cancelled, { once: true })
      operation.then(resolve, reject).finally(() => deadline.removeEventListener('abort', cancelled))
      if (deadline.aborted) cancelled()
    })
    check()
    const capturedAt = Date.now()
    return approved.map((display) => {
      const source = sources.find((entry) => entry.display_id === display.id)
      if (!source || source.thumbnail.isEmpty()) throw new ChatError('macOS returned no image for an approved display. Check Screen Recording access and restart Athena if required.')
      let image = source.thumbnail
      const size = image.getSize()
      const scale = Math.min(1, SCREEN_CAPTURE_SIZE / Math.max(size.width, size.height))
      if (scale < 1) image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
      const bytes = image.toJPEG(80)
      if (!bytes.length || bytes.length > MAX_SCREEN_IMAGE_BYTES) throw new ChatError('A screen image exceeded the safe size limit. No images were sent.')
      return { display, ...image.getSize(), capturedAt, dataURL: `data:image/jpeg;base64,${bytes.toString('base64')}` }
    })
  }
  dispose(): void { this.abort.abort() }
}
