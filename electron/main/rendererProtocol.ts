import { app, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
}

type ArtifactResolver = (token: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>
let resolveArtifact: ArtifactResolver | undefined

/**
 * Installs the resolver used by the private athena://artifact origin.  The
 * renderer never receives an absolute filesystem path: it receives a short
 * lived capability token minted only after the conversation ownership check.
 */
export function setAthenaArtifactResolver(resolver: ArtifactResolver): void {
  resolveArtifact = resolver
}

/** A same-origin, read-only app:// renderer origin so packaged local VAD assets work offline. */
export function registerAthenaRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'athena',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  }])
}

export function installAthenaRendererHandler(): void {
  const rendererRoot = app.isPackaged ? resolve(app.getAppPath(), 'out', 'renderer') : fileURLToPath(new URL('../renderer/', import.meta.url)).replace(/[/\\]$/, '')
  protocol.handle('athena', async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'GET') return new Response('Not found', { status: 404 })
    if (url.hostname === 'artifact') {
      const token = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!token || !resolveArtifact) return new Response('Not found', { status: 404 })
      try {
        const asset = await resolveArtifact(token)
        if (!asset) return new Response('Not found', { status: 404 })
        const size=asset.bytes.byteLength
        const headers=new Headers({'Content-Type':asset.mimeType,'Accept-Ranges':'bytes','Content-Security-Policy':"default-src 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=60'})
        const origin=request.headers.get('Origin')
        if(origin==='athena://renderer'||(!app.isPackaged && origin && /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin))) headers.set('Access-Control-Allow-Origin',origin)
        const range=request.headers.get('range')
        if(range){
          const match=/^bytes=(\d*)-(\d*)$/.exec(range)
          const first=match?.[1]?Number(match[1]):Math.max(0,size-Number(match?.[2]))
          const last=match?.[1]&&match[2]?Math.min(size-1,Number(match[2])):size-1
          if(!match||(!match[1]&&!match[2])||first>=size||last<first){headers.set('Content-Range','bytes */'+size);return new Response(null,{status:416,headers})}
          headers.set('Content-Range',`bytes ${first}-${last}/${size}`);headers.set('Content-Length',String(last-first+1))
          return new Response(asset.bytes.subarray(first,last+1) as BodyInit,{status:206,headers})
        }
        headers.set('Content-Length',String(size))
        return new Response(asset.bytes as unknown as BodyInit,{headers})
      } catch { return new Response('Not found', { status: 404 }) }
    }
    if (url.hostname !== 'renderer') return new Response('Not found', { status: 404 })
    let pathname: string
    try { pathname = decodeURIComponent(url.pathname) }
    catch { return new Response('Invalid path', { status: 400 }) }
    const filePath = resolve(rendererRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) return new Response('Forbidden', { status: 403 })
    try {
      const body = await readFile(filePath)
      return new Response(body, { headers: { 'Content-Type': mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}
