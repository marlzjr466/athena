import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioDeviceDefaults, resolveAudioRoute, type AudioEndpoint } from '../shared/audioDevices'
import { AudioDeviceService } from '../electron/main/voice/audioDeviceService'
import { enrichAudioEndpoints, macAudioEndpoints } from '../electron/main/voice/nativeAudioEndpoints'
import { mergeSettings, restoreSettings } from '../shared/settings'
const input = (id: string, endpointType: AudioEndpoint['endpointType'] = 'built-in'): AudioEndpoint => ({ deviceId: id, groupId: id, kind: 'audioinput', label: id, endpointType })
const output = (id: string, type: AudioEndpoint['endpointType'] = 'built-in'): AudioEndpoint => ({ ...input(id, type), kind: 'audiooutput' })
const builtIn = [input('built-in mic'), output('built-in speaker')]
const usb = [input('usb', 'external'), output('usb', 'external')]
afterEach(() => vi.useRealTimers())
function setup(prefs = { ...audioDeviceDefaults }) {
  const stop = vi.fn(), save = vi.fn(next => { Object.assign(prefs, next) })
  const service = new AudioDeviceService(() => prefs, vi.fn(), stop, save)
  return { service, prefs, stop, save }
}
describe('audio routing policy across OS endpoints', () => {
  it('defaults to automatic and preserves manual selections across settings reload', () => {
    const settings = mergeSettings(restoreSettings({}), { audioDevices: { ...audioDeviceDefaults, inputDeviceId: 'usb' } })
    expect(restoreSettings(JSON.parse(JSON.stringify(settings))).audioDevices).toEqual(settings.audioDevices)
  })
  it('starts on built-in devices and automatically returns to them after disconnect', () => {
    const { service, stop } = setup()
    service.inventory(builtIn); expect(service.snapshot().input.deviceId).toBe('built-in mic')
    service.inventory([...builtIn, ...usb]); expect(service.snapshot().input.deviceId).toBe('usb')
    expect(service.snapshot().output.deviceId).toBe('usb')
    service.inventory(builtIn)
    expect(service.snapshot()).toMatchObject({ input: { deviceId: 'built-in mic' }, output: { deviceId: 'built-in speaker' }, outputHeld: false })
    expect(stop).not.toHaveBeenCalled()
  })
  it('selects input/output independently, preferring the newest connected external endpoint', () => {
    const { service } = setup()
    service.inventory([...builtIn, ...usb])
    service.inventory([...builtIn, ...usb, output('headphones', 'external')])
    expect(service.snapshot()).toMatchObject({ input: { deviceId: 'usb' }, output: { deviceId: 'headphones' } })
    service.inventory([...builtIn, output('headphones', 'external')])
    expect(service.snapshot().input.deviceId).toBe('built-in mic')
    service.inventory([...builtIn, output('headphones', 'external'), ...usb])
    expect(service.snapshot().output.deviceId).toBe('usb')
  })
  it('does not reconnect for enumeration reordering or label changes', () => {
    const { service } = setup()
    service.inventory([...builtIn, ...usb])
    service.inventory([...usb, ...builtIn].map(d => ({ ...d, label: d.label + ' updated' })))
    expect(service.snapshot().output.deviceId).toBe('usb')
  })
  it('pins manual devices until unavailable then persists automatic recovery', () => {
    const { service, prefs, save } = setup({ ...audioDeviceDefaults, inputDeviceId: 'usb', outputDeviceId: 'usb', automaticSwitching: false })
    service.inventory([...builtIn, ...usb])
    service.inventory([...builtIn, ...usb, output('new', 'external')])
    expect(service.snapshot().output.deviceId).toBe('usb')
    service.inventory(builtIn)
    expect(prefs).toMatchObject({ inputDeviceId: 'default', outputDeviceId: 'default' })
    expect(save).toHaveBeenCalledOnce()
    expect(service.snapshot().output.deviceId).toBe('built-in speaker')
  })
  it('filters Teams and virtual devices and migrates stale IDs without exposing placeholder options', () => {
    const { service, prefs } = setup({ ...audioDeviceDefaults, outputDeviceId: 'teams', inputDeviceId: 'gone' })
    service.inventory([...builtIn, output('Microsoft Teams Audio Device'), { ...output('teams', 'virtual'), label: 'Teams Audio' }])
    expect(prefs.inputDeviceId).toBe('default'); expect(prefs.outputDeviceId).toBe('default')
    expect(service.snapshot().devices).toHaveLength(2)
  })
  it('waits for permission before migrating redacted IDs and stops if no speaker remains', () => {
    const { service, prefs, stop } = setup({ ...audioDeviceDefaults, inputDeviceId: 'saved' })
    service.inventory([{ ...input(''), label: '' }, ...builtIn.filter(d => d.kind === 'audiooutput')])
    expect(prefs.inputDeviceId).toBe('saved')
    service.inventory([]); expect(service.snapshot().outputHeld).toBe(true); expect(stop).toHaveBeenCalledOnce()
  })
  it('uses a compatible available device on machines without built-in audio', () => {
    expect(resolveAudioRoute(usb, 'audioinput', 'default', true).deviceId).toBe('usb')
    expect(resolveAudioRoute([output('unknown', 'unknown')], 'audiooutput', 'default', true).deviceId).toBe('unknown')
  })
  it('retains the current endpoint with automatic switching disabled', () => {
    expect(resolveAudioRoute([...builtIn, ...usb], 'audioinput', 'default', false, { deviceId: 'built-in mic', label: '' }).deviceId).toBe('built-in mic')
  })
  it('serializes discovery and avoids duplicate native queries', async () => {
    const { service } = setup(); service.enrich = vi.fn(async devices => devices)
    await Promise.all([service.discover(builtIn), service.discover(builtIn)])
    expect(service.enrich).toHaveBeenCalledOnce()
  })
  it('drops microphone labels on revocation and rediscovers the same hardware after access returns', async () => {
    let allowed = false
    const preferences = { ...audioDeviceDefaults, inputDeviceId: 'usb' }
    const service = new AudioDeviceService(() => preferences, vi.fn(), vi.fn(), vi.fn(), () => allowed)
    const devices = [...builtIn, ...usb]
    expect((await service.discover(devices)).input.label).toBe('Microphone access required')
    allowed = true
    expect((await service.discover(devices)).input.deviceId).toBe('usb')
    allowed = false
    const revoked = service.reconcile()
    expect(revoked.devices.every(d => d.kind === 'audiooutput')).toBe(true)
    expect(revoked.output.deviceId).toBe('usb')
    expect(preferences.inputDeviceId).toBe('usb')
    allowed = true
    expect((await service.discover(devices)).input.deviceId).toBe('usb')
  })
  it('uses native Core Audio transport metadata including an analog jack on a built-in controller', () => {
    const metadata = macAudioEndpoints({ SPAudioDataType: [{ _items: [
      { _name: 'Laptop', coreaudio_device_transport: 'coreaudio_device_type_builtin', coreaudio_device_input: 1 },
      { _name: 'Controller', coreaudio_device_transport: 'coreaudio_device_type_builtin', coreaudio_device_output: 2, coreaudio_output_source: 'External Headphones' },
      { _name: 'USB device', coreaudio_device_transport: 'coreaudio_device_type_usb', coreaudio_device_output: 2 },
    ] }] })
    expect(enrichAudioEndpoints([input('Laptop (Built-in)'), output('External Headphones'), output('USB device (001f:0b23)')], metadata).map(d => d.endpointType)).toEqual(['built-in', 'external', 'external'])
  })
  it('bounds microphone tests and denies duplicate ownership', () => {
    vi.useFakeTimers(); const { service } = setup()
    service.startTest(1); expect(service.canTest(2)).toBe(false)
    expect(() => service.startTest(2)).toThrow('already running')
    service.level(.5); expect(service.snapshot().microphoneLevel).toBe(.5)
    vi.advanceTimersByTime(15000); expect(service.snapshot().testActive).toBe(false)
    service.dispose()
  })
})
