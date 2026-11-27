import { app, BrowserWindow, desktopCapturer, nativeImage, screen, session as electronSession, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { APPLICATIONS } from '../../../shared/desktopActions'
import type { WindowInput } from './screenCapturePlatform'
import { ChatError } from '../ai/AIProvider'
import { MAX_CAPTURE_DISPLAYS, MAX_SCREEN_IMAGE_BYTES, SCREEN_CAPTURE_SIZE, type CaptureDisplay, type ScreenCapturePlatform, type ScreenImage } from './screenCapturePlatform'

export class MacOSScreenCapture implements ScreenCapturePlatform {
  private abort = new AbortController()
  private busy = false
  constructor(private platform = process.platform,private feedback?:import('../desktop/interactionOverlay').InteractionOverlay) {}
  displays(): CaptureDisplay[] {
    if (!['darwin', 'win32'].includes(this.platform)) throw new ChatError('Screen awareness is unavailable on this platform.')
    return screen.getAllDisplays().map((display, index) => ({ id: String(display.id), name: `Display ${index + 1}`, width: display.bounds.width, height: display.bounds.height }))
  }
  async capture(approved: CaptureDisplay[], signal: AbortSignal): Promise<ScreenImage[]> {
    const check = () => {
      signal.throwIfAborted(); this.abort.signal.throwIfAborted()
      if (!['darwin', 'win32'].includes(this.platform) || this.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') throw new ChatError('Screen Recording access is not allowed. Review Settings → Privacy and OS settings, then retry.')
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
  async windows(signal: AbortSignal): Promise<CaptureDisplay[]> {
    signal.throwIfAborted(); this.abort.signal.throwIfAborted()
    if (!['darwin', 'win32'].includes(this.platform) || this.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') throw new ChatError('Grant Screen Recording permission in OS settings before selecting a window.')
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    signal.throwIfAborted()
    return sources.filter(source => source.name).slice(0, 100).map(source => ({ id: source.id, name: source.name.slice(0, 200), width: 0, height: 0 }))
  }
  async point(image:ScreenImage,gesture:WindowInput,signal:AbortSignal) {
    signal.throwIfAborted()
    if(Date.now()-image.capturedAt>5000)throw new ChatError('Capture a fresh window before issuing input.')
    const id=/^window:([1-9]\d*):\d+$/.exec(image.display.id)?.[1]
    if(!id)throw new ChatError('Unsupported native window identity.')
    const timeout=AbortSignal.any([signal,this.abort.signal,AbortSignal.timeout(4000)])
    const dir=await mkdtemp(join(tmpdir(),'athena-gesture-'))
    const cancelFile=join(dir,'cancelled')
    const stop=()=>{try {writeFileSync(cancelFile,'',{mode:0o600})} catch { /* Native watchdog still bounds the action. */ }}
    timeout.addEventListener('abort',stop,{once:true})
    try {
      timeout.throwIfAborted()
      const operation=gesture.operation ?? (gesture.to?'drag':'click')
      const request={id:Number(id),width:image.width,height:image.height,from:gesture.from,to:gesture.to,path:gesture.path,operation,scrollX:gesture.scrollX,scrollY:gesture.scrollY,cancelFile}
      const perform=async(preview:boolean,expected?:import('../../../shared/desktopActions').DesktopRect)=>{
        const data={...request,expected,preview,overlay:this.feedback?.nativeWindowId()}
        if(this.platform==='win32'){
          const {pointAtWindowsWindow}=await import('../desktop/windowsVisualInput')
          return pointAtWindowsWindow(gesture.app,data)
        }
        if(this.platform!=='darwin')throw new ChatError('Visual input is unavailable on this platform.')
        const path=app.isPackaged?join(process.resourcesPath,'native','athena-desktop-accessibility'):join(app.getAppPath(),'build','native','athena-desktop-accessibility')
        const {stdout}=await promisify(execFile)(path,[APPLICATIONS[gesture.app].bundleId,preview?'visual-preview':'visual','',JSON.stringify(data),''],{timeout:6500,maxBuffer:4096})
        const result=JSON.parse(stdout)
        if(result.ok!==true){
          const error=new ChatError(result.error??'The target did not accept visual input.')
          if(typeof result.code==='string' && /^window-target-[a-z-]{1,40}$/.test(result.code))
            Object.assign(error,{automationCode:result.code})
          throw error
        }
        return result
      }
      const projection=await perform(true)
      timeout.throwIfAborted()
      const mark=await this.feedback?.begin({label:operation.replace('_',' '),click:operation==='click'||operation==='double_click',nativePixels:true,bounds:{x:projection.point.x-5,y:projection.point.y-5,width:10,height:10}},timeout)
      let applied=false
      try{
        timeout.throwIfAborted()
        // Windows' physical hit test must see the underlying window. Never whitelist a replacement HWND.
        if(this.platform==='win32')mark?.suspend?.()
        await perform(false,projection.frame)
        applied=true
      }finally{mark?.finish(applied)}
      timeout.throwIfAborted()
    } finally {
      timeout.removeEventListener('abort',stop)
      await rm(dir,{recursive:true,force:true})
    }
  }
  async captureWindow(window: CaptureDisplay, signal: AbortSignal): Promise<ScreenImage[]> {
    const deadline = AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(10_000)])
    const current = (await this.windows(deadline)).find(item => item.id === window.id && item.name === window.name)
    if (!current) throw new ChatError('The authorized window changed or closed. Select it again; no capture was sent.')
    if (this.platform === 'darwin') {
      const id = /^window:([1-9]\d*):\d+$/.exec(current.id)?.[1]
      if (!id) throw new ChatError('This window has no supported native capture identifier.')
      const scratch = await mkdtemp(join(tmpdir(), 'athena-window-capture-'))
      try {
        const path = join(scratch, 'window.png')
        await promisify(execFile)('/usr/sbin/screencapture', ['-x', '-o','-l', id, '-t', 'png', path], { timeout: 10_000, signal: deadline, maxBuffer: 16 * 1024 })
        if (!(await this.windows(deadline)).some(item => item.id === current.id && item.name === current.name)) throw new ChatError('The target window changed during capture. No image was sent.')
        let image = nativeImage.createFromBuffer(await readFile(path))
        if (image.isEmpty()) throw new ChatError('macOS returned no image for that window.')
        const size = image.getSize(), scale = Math.min(1, SCREEN_CAPTURE_SIZE / Math.max(size.width, size.height))
        if (scale < 1) image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
        const bytes = image.toJPEG(80)
        if (!bytes.length || bytes.length > MAX_SCREEN_IMAGE_BYTES) throw new ChatError('The selected window image exceeded the safe size limit.')
        return [{ display: current, ...image.getSize(), capturedAt: Date.now(), dataURL: `data:image/jpeg;base64,${bytes.toString('base64')}` }]
      } catch (error) {
        if (error instanceof ChatError) throw error
        throw new ChatError(deadline.aborted ? 'Window capture cancelled or timed out. No image was sent.' : 'macOS could not capture the selected window. Check Screen Recording access; protected windows cannot be captured.')
      } finally { await rm(scratch, { recursive: true, force: true }) }
    }
    const partition = electronSession.fromPartition(`athena-window-capture-${randomUUID()}`)
    const worker = new BrowserWindow({ title: 'Athena — Capture selected window', width: 1, height: 1, show: false, focusable: false, skipTaskbar: true, frame: false, opacity: 0, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, backgroundThrottling: false } })
    partition.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'display-capture'))
    partition.setPermissionCheckHandler((_contents, permission) => permission === 'display-capture')
    partition.setDisplayMediaRequestHandler((_request, callback) => {
      void desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).then(sources => {
        const source = sources.find(item => item.id === current.id && item.name === current.name)
        callback(source && !deadline.aborted ? { video: source } : {})
      }, () => callback({}))
    })
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    worker.webContents.on('will-navigate', event => event.preventDefault())
    const stop = () => { if (!worker.isDestroyed()) worker.destroy() }
    deadline.addEventListener('abort', stop, { once: true })
    try {
      await worker.loadFile(fileURLToPath(new URL('./windowCapture.html', import.meta.url)))
      worker.setIgnoreMouseEvents(true)
      worker.showInactive()
      deadline.throwIfAborted()
      const image = await worker.webContents.executeJavaScript(`(async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        try {
          const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
          await video.play(); await new Promise(resolve => video.requestVideoFrameCallback(resolve));
          const scale = Math.min(1, ${SCREEN_CAPTURE_SIZE} / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement('canvas'); canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          return { dataURL: canvas.toDataURL('image/jpeg', 0.8), width: canvas.width, height: canvas.height };
        } finally { stream.getTracks().forEach(track => track.stop()); }
      })()`, true) as { dataURL: string; width: number; height: number }
      deadline.throwIfAborted()
      if (!image.dataURL.startsWith('data:image/jpeg;base64,') || Buffer.byteLength(image.dataURL.split(',')[1], 'base64') > MAX_SCREEN_IMAGE_BYTES || !image.width || !image.height) throw new ChatError('The selected window did not return a valid bounded image.')
      return [{ display: current, ...image, capturedAt: Date.now() }]
    } finally { deadline.removeEventListener('abort', stop); stop(); partition.setDisplayMediaRequestHandler(null); await partition.clearStorageData().catch(() => {}) }

  }
}
