import { emptyAudioDeviceState, resolveAudioRoute, supportedAudioDevice, type AudioEndpoint, type AudioDeviceSettings, type AudioDeviceState } from '../../../shared/audioDevices'

/** Main-process authority for routing policy. No audio samples, device names or IDs are logged. */
export class AudioDeviceService {
  enrich?: (devices: AudioEndpoint[]) => Promise<AudioEndpoint[]>
  private rawInventory = ''
  private inventoryLane: Promise<unknown> = Promise.resolve()
  async discover(devices: AudioEndpoint[]): Promise<AudioDeviceState> {
    const operation = this.inventoryLane.then(async () => {
      const raw = JSON.stringify([this.microphoneAllowed(), devices])
      if (raw === this.rawInventory) return this.snapshot()
      const enriched = this.enrich ? await this.enrich(devices) : devices
      this.rawInventory = raw
      return this.inventory(enriched)
    })
    this.inventoryLane = operation.catch(() => {})
    return operation
  }
  private state = emptyAudioDeviceState()
  private preferences?: AudioDeviceSettings
  private microphoneAccess?: boolean
  private sequence = 0
  private orders = new Map<string, number>()
  private testOwner?: number
  private testTimer?: ReturnType<typeof setTimeout>
  constructor(private settings: () => AudioDeviceSettings, private changed: (state: AudioDeviceState) => void, private stopPlayback: () => void, private save?: (settings: AudioDeviceSettings) => void, private microphoneAllowed: () => boolean = () => true) {}
  snapshot(): AudioDeviceState { return structuredClone(this.state) }
  inventory(devices: AudioEndpoint[]): AudioDeviceState {
    const microphoneAllowed = this.microphoneAllowed()
    if (!microphoneAllowed) devices = devices.filter(d => d.kind !== 'audioinput')
    const unique = [...new Map(devices.map(d => [`${d.kind}:${d.deviceId}`, d])).values()]
    const batch = ++this.sequence
    const nextOrders = new Map<string, number>()
    for (const device of unique) {
      if (!supportedAudioDevice(device)) continue
      const key = `${device.kind}:${device.deviceId}`
      // Stable group identity also survives Bluetooth profile/endpoint-ID changes.
      const old = this.state.devices.find(d => d.kind === device.kind && d.groupId && d.groupId === device.groupId && d.endpointType === device.endpointType)
      device.connectedOrder = this.orders.get(key) ?? old?.connectedOrder ?? batch
      nextOrders.set(key, device.connectedOrder)
    }
    this.orders = nextOrders
    const visible = unique.filter(d => supportedAudioDevice(d) || ['default', 'communications'].includes(d.deviceId) || !d.label)
    if (microphoneAllowed === this.microphoneAccess && JSON.stringify(visible) === JSON.stringify(this.state.devices)) return this.snapshot()
    this.state.devices = visible
    // Redacted inventories do not prove a saved device has disappeared.
    const prefs = { ...this.settings() }
    for (const [kind, key] of [['audioinput', 'inputDeviceId'], ['audiooutput', 'outputDeviceId']] as const) {
      if (unique.some(d => d.kind === kind && d.label) && prefs[key] !== 'default'
        && !visible.some(d => d.kind === kind && d.deviceId === prefs[key] && supportedAudioDevice(d))) prefs[key] = 'default'
    }
    if (JSON.stringify(prefs) !== JSON.stringify(this.settings())) this.save?.(prefs)
    return this.reconcile()
  }
  reconcile(): AudioDeviceState {
    const prefs = this.settings(), previous = this.preferences
    const microphoneAllowed = this.microphoneAllowed()
    this.microphoneAccess = microphoneAllowed
    if (!microphoneAllowed && this.state.devices.some(d => d.kind === 'audioinput')) {
      this.state.devices = this.state.devices.filter(d => d.kind !== 'audioinput')
      this.rawInventory = ''
    }
    const selectedOutput = previous && previous.outputDeviceId !== prefs.outputDeviceId
    const selectedInput = previous && previous.inputDeviceId !== prefs.inputDeviceId
    const output = resolveAudioRoute(this.state.devices, 'audiooutput', prefs.outputDeviceId, prefs.automaticSwitching, selectedOutput ? undefined : this.state.output)
    const input = microphoneAllowed
      ? resolveAudioRoute(this.state.devices, 'audioinput', prefs.inputDeviceId, prefs.automaticSwitching, selectedInput ? undefined : this.state.input)
      : { label: 'Microphone access required', message: 'Check Microphone Access in Athena’s Privacy settings and your operating system.' }
    // Automatic fallback is explicitly selected by the user. Route live playback
    // in place; only stop when no compatible output remains.
    if (this.state.output.deviceId && !output.deviceId) this.stopPlayback()
    this.state.outputHeld = !output.deviceId
    this.state.message = output.deviceId ? undefined : 'No compatible speaker is connected.'
    this.preferences = { ...prefs }; this.state.input = input; this.state.output = output
    this.publish(); return this.snapshot()
  }
  confirmOutput(): AudioDeviceState {
    if (!this.state.output.deviceId) throw new Error('Connect or select a speaker before testing voice.')
    this.state.outputHeld = false; this.state.message = undefined; this.publish(); return this.snapshot()
  }
  startTest(sender: number): AudioDeviceState {
    if (this.testOwner !== undefined) throw new Error('A microphone test is already running.')
    this.testOwner = sender; this.state.testActive = true; this.state.microphoneLevel = 0
    this.testTimer = setTimeout(() => this.stopTest(), 15_000)
    this.publish(); return this.snapshot()
  }
  canTest(sender: number): boolean { return this.testOwner === sender && this.state.testActive }
  stopTest(sender?: number): AudioDeviceState {
    if (sender !== undefined && this.testOwner !== sender) return this.snapshot()
    clearTimeout(this.testTimer); this.testOwner = undefined; this.state.testActive = false; this.state.microphoneLevel = 0
    this.publish(); return this.snapshot()
  }
  level(level: number): AudioDeviceState { if (this.state.testActive) { this.state.microphoneLevel = level; this.publish() }; return this.snapshot() }
  private publish(): void { this.state.revision++; this.changed(this.snapshot()) }
  dispose(): void { clearTimeout(this.testTimer); this.testOwner = undefined }
}
