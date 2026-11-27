import { z } from 'zod'

export const audioDeviceSettingsSchema = z.object({
  inputDeviceId: z.string().min(1).max(512).default('default'),
  outputDeviceId: z.string().min(1).max(512).default('default'),
  automaticSwitching: z.boolean().default(true),
}).strict()
export type AudioDeviceSettings = z.infer<typeof audioDeviceSettingsSchema>
export const audioDeviceDefaults = audioDeviceSettingsSchema.parse({})
export const audioDeviceSchema = z.object({ deviceId: z.string().max(512), groupId: z.string().max(512), label: z.string().max(256), kind: z.enum(['audioinput', 'audiooutput']) }).strict()
export type AudioDevice = z.infer<typeof audioDeviceSchema>
export type EndpointType = 'built-in' | 'external' | 'virtual' | 'unknown'
export interface AudioEndpoint extends AudioDevice { endpointType?: EndpointType; connectedOrder?: number }
export interface AudioRoute { deviceId?: string; label: string; message?: string }
export interface AudioDeviceState {
  devices: AudioEndpoint[]; input: AudioRoute; output: AudioRoute; outputHeld: boolean; revision: number
  microphoneLevel: number; testActive: boolean; message?: string
}
export const emptyAudioDeviceState = (): AudioDeviceState => ({ devices: [], input: { label: 'Checking microphone…' }, output: { label: 'Checking speakers…' }, outputHeld: false, revision: 0, microphoneLevel: 0, testActive: false })
export const audioDeviceCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('inventory'), devices: z.array(audioDeviceSchema).max(128) }).strict(),
  z.object({ action: z.literal('confirm-output') }).strict(),
  z.object({ action: z.literal('test-start') }).strict(),
  z.object({ action: z.literal('test-stop') }).strict(),
  z.object({ action: z.literal('level'), level: z.number().finite().min(0).max(1) }).strict(),
])
export type AudioDeviceCommand = z.infer<typeof audioDeviceCommandSchema>

export function supportedAudioDevice(device: AudioEndpoint): boolean {
  return Boolean(device.deviceId && device.label && !['default', 'communications'].includes(device.deviceId)
    && device.endpointType !== 'virtual' && !/\b(?:microsoft\s+)?teams\b/i.test(device.label))
}

/** Native metadata identifies built-in endpoints; Chromium supplies the routable IDs. */
export function resolveAudioRoute(devices: AudioEndpoint[], kind: AudioDevice['kind'], selected: string, automatic: boolean, previous?: AudioRoute): AudioRoute {
  const choices = devices.filter(d => d.kind === kind && supportedAudioDevice(d))
  const alias = devices.find(d => d.kind === kind && d.deviceId === 'default')
  const system = choices.find(d => alias?.groupId && d.groupId === alias.groupId)
    ?? choices.find(d => alias?.label && alias.label.replace(/^Default\s*[-–:]\s*/i, '') === d.label)
  const requested = selected === 'default' ? (!automatic ? previous?.deviceId : undefined) : selected
  const found = choices.find(d => d.deviceId === requested)
  if (found) return { deviceId: found.deviceId, label: found.label || (kind === 'audioinput' ? 'Microphone' : 'Speaker') }
  const external = choices.filter(d => d.endpointType === 'external').sort((a, b) => (b.connectedOrder ?? 0) - (a.connectedOrder ?? 0))
  const latest = external[0]?.connectedOrder ?? 0
  const fallback = external.find(d => d.deviceId === previous?.deviceId && (d.connectedOrder ?? 0) === latest)
    ?? external.find(d => d.deviceId === system?.deviceId && (d.connectedOrder ?? 0) === latest)
    ?? external[0] ?? choices.find(d => d.endpointType === 'built-in') ?? system ?? choices[0]
  if (fallback) return { deviceId: fallback.deviceId, label: fallback.label, ...(selected !== 'default' ? { message: 'Selected device disconnected; automatic audio selection restored.' } : {}) }
  return { label: kind === 'audioinput' ? 'Microphone unavailable' : 'Speaker unavailable', message: 'Connect an audio device. Microphone access may be required to identify available devices.' }
}
