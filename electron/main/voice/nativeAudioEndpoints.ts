import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { AudioDevice, AudioEndpoint, EndpointType } from '../../../shared/audioDevices'

const run = promisify(execFile)
export interface NativeEndpoint { label: string; kind?: AudioDevice['kind']; type: EndpointType }

export function macAudioEndpoints(data: unknown): NativeEndpoint[] {
  const result: NativeEndpoint[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const row = value as Record<string, unknown>
    if (typeof row._name === 'string' && typeof row.coreaudio_device_transport === 'string') {
      const transport = row.coreaudio_device_transport
      for (const [field, source, kind] of [['coreaudio_device_input', 'coreaudio_input_source', 'audioinput'], ['coreaudio_device_output', 'coreaudio_output_source', 'audiooutput']] as const) {
        if (!(Number(row[field]) > 0)) continue
        const label: string = typeof row[source] === 'string' && !String(row[source]).startsWith('spaudio_') ? String(row[source]) : row._name
        // An analog jack may share the built-in audio controller.
        const jack = /headphone|external|line[ -]?(?:in|out)/i.test(label)
        const type: EndpointType = /virtual|aggregate/.test(transport) ? 'virtual' : /builtin/.test(transport) && !jack ? 'built-in' : /unknown/.test(transport) ? 'unknown' : 'external'
        result.push({ label, kind, type })
        if (label !== row._name) result.push({ label: row._name, kind, type })
      }
    }
    Object.values(row).forEach(visit)
  }
  visit(data); return result
}

const normalized = (label: string) => label.replace(/\s*\((?:[0-9a-f]{4}:[0-9a-f]{4}|built-in)\)$/i, '').trim().toLowerCase()
export function enrichAudioEndpoints(devices: AudioDevice[], native: NativeEndpoint[]): AudioEndpoint[] {
  return devices.map(device => {
    const match = native.find(n => (!n.kind || n.kind === device.kind) && normalized(n.label) === normalized(device.label))
    return { ...device, endpointType: /\b(?:microsoft\s+)?teams\b/i.test(device.label) ? 'virtual' : match?.type ?? 'unknown' }
  })
}

/** Read native metadata only after a changed Chromium inventory, never poll or change OS defaults. */
export class NativeAudioEndpoints {
  private pending?: Promise<NativeEndpoint[]>
  constructor(private root: string, private platform: NodeJS.Platform = process.platform) {}
  read(): Promise<NativeEndpoint[]> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      if (this.platform === 'darwin') {
        const { stdout } = await run('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout: 8000, maxBuffer: 1024 * 1024 })
        return macAudioEndpoints(JSON.parse(stdout))
      }
      if (this.platform === 'win32') {
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(this.root, 'voice-service', 'audio-endpoints.ps1')], { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true })
        const rows = JSON.parse(stdout.replace(/^\uFEFF/, ''))
        return (Array.isArray(rows) ? rows : [rows]).filter((r): r is NativeEndpoint => r && typeof r.label === 'string' && ['built-in', 'external', 'virtual', 'unknown'].includes(r.type))
      }
      return []
    })().catch(() => []).finally(() => { this.pending = undefined })
    return this.pending
  }
}
