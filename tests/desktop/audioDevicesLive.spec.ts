import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

test('real packaged audio endpoints, microphone meter, routed TTS, permissions and restart', async () => {
  test.skip(process.env.ATHENA_AUDIO_LIVE !== '1', 'Requires actual audio hardware; no synthetic capture or playback')
  test.setTimeout(600_000)
  await writeFile('/tmp/athena-audio-live-stage.json', JSON.stringify({ stage: 'preparing' }))
  const profile = await mkdtemp(join(tmpdir(), 'athena-audio-live-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ floatingEnabled: false, randomActions: false, randomMovement: false,
    voiceEnabled: true, voiceMuted: false, liveVoice: { engine: 'local', cloudAllowed: false }, webAccess: { webSearchEnabled: false, automaticStartup: false } }))
  const launch = () => electron.launch({ executablePath: resolve(process.env.ATHENA_AUDIO_APP ?? 'release/mac-arm64/Athena.app/Contents/MacOS/Athena'), args: [`--user-data-dir=${profile}`], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  let app = await launch()
  const evidence: Record<string, unknown> = {}
  try {
    expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(() => app.windows().some(p => p.url().includes('surface=control'))).toBe(true)
    let control = app.windows().find(p => p.url().includes('surface=control'))!
    const floating = app.windows().find(p => p.url().includes('surface=floating'))!
    expect(await app.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('microphone'))).toBe('granted')
    await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'microphone', enabled: true }))
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('surface=control'))?.isVisible())), { timeout: 30_000 }).toBe(true)
    await control.getByRole('button', { name: 'Voice', exact: true }).click()
    await expect(control.getByText('Audio Devices', { exact: true })).toBeVisible()
    await control.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      ;(window as unknown as { micTracks: MediaStreamTrack[] }).micTracks = []
      navigator.mediaDevices.getUserMedia = async options => {
        const stream = await capture(options)
        ;(window as unknown as { micTracks: MediaStreamTrack[] }).micTracks.push(...stream.getAudioTracks())
        return stream
      }
    })
    await control.getByRole('button', { name: 'Test microphone', exact: true }).click()
    await expect.poll(async () => (await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).testActive).toBe(true)
    await expect.poll(async () => (await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).input.deviceId).toBeTruthy()
    await expect.poll(async () => (await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).microphoneLevel, { timeout: 12_000 }).toBeGreaterThan(0)
    const devices = await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))
    evidence.devices = devices.devices.map(d => ({ kind: d.kind, label: d.label }))
    expect(devices.devices.some(d => /teams/i.test(d.label))).toBe(false)
    if (process.env.ATHENA_AUDIO_HOTPLUG === '1') { expect(devices.input.label).toContain('AB17X'); expect(devices.output.label).toContain('AB17X') }
    evidence.initialInput = devices.input.label; evidence.initialOutput = devices.output.label; evidence.microphoneMeter = 'Actual capture produced nonzero RMS'
    await control.getByRole('button', { name: 'Stop microphone test' }).click()
    await expect.poll(async () => (await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).testActive).toBe(false)
    await control.evaluate(async () => { await window.athena!.setPermissionEnabled({ permission: 'microphone', enabled: false }) })
    const denial = await control.evaluate(async () => { try { await window.athena!.audioDevices({ action: 'test-start' }); return false } catch { return true } })
    expect(denial).toBe(true); evidence.permissionDenial = 'blocked by main process'
    await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'microphone', enabled: true }))
    await control.evaluate(() => {
      const original = HTMLMediaElement.prototype.play
      ;(window as unknown as { audioEvidence: unknown }).audioEvidence = { played: false, ended: false }
      HTMLMediaElement.prototype.play = async function () {
        await original.call(this)
        const evidence = { played: true, ended: false, pinned: Boolean(this.sinkId && this.sinkId !== 'default') }
        ;(window as unknown as { audioEvidence: unknown }).audioEvidence = evidence
        this.addEventListener('ended', () => { evidence.ended = true }, { once: true })
      }
    })
    await control.getByRole('button', { name: 'Test Athena voice', exact: true }).click()
    await expect(control.getByRole('button', { name: 'Test Athena voice', exact: true })).toBeDisabled()
    await expect.poll(() => control.evaluate(() => (window as unknown as { audioEvidence: { ended: boolean } }).audioEvidence.ended), { timeout: 120_000 }).toBe(true)
    expect(await control.evaluate(() => (window as unknown as { audioEvidence: { pinned: boolean } }).audioEvidence.pinned)).toBe(true)
    await expect(control.getByRole('button', { name: 'Test Athena voice', exact: true })).toBeEnabled({ timeout: 120_000 })
    const note = await control.locator('.chat-message-note').allTextContents()
    expect(note.join(' ')).not.toMatch(/failed|unavailable|denied|could not|cannot/i)
    evidence.tts = 'Selected local TTS preview completed with a pinned physical output'
    await floating.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      ;(window as unknown as { micTracks: MediaStreamTrack[] }).micTracks = []
      navigator.mediaDevices.getUserMedia = async options => {
        const stream = await capture(options)
        ;(window as unknown as { micTracks: MediaStreamTrack[] }).micTracks.push(...stream.getAudioTracks())
        return stream
      }
    })
    // Start the real local wake listener; no transcript is injected.
    await control.evaluate(async whisper => {
      const { settings } = await window.athena!.getSnapshot()
      await window.athena!.updateSettings({ floatingEnabled: true, localAI: { ...settings.localAI, speechModelPath: whisper, speechEngine: 'whisper-cli' }, voiceInteraction: { ...settings.voiceInteraction, handsFreeEnabled: true } })
    }, join(homedir(), '.athena/models/whisper/ggml-small.bin'))
    await expect.poll(async () => (await floating.evaluate(() => window.athena!.getSnapshot())).handsFreeState?.state, { timeout: 60_000 }).toBe('standby')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('surface=control'))?.minimize() })
    expect((await floating.evaluate(() => window.athena!.getSnapshot())).handsFreeState?.state).toBe('standby')
    evidence.unfocusedListener = 'Real local VAD remained on while main window minimized'
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('surface=control')); w?.restore(); w?.show() })
    if (process.env.ATHENA_AUDIO_HOTPLUG === '1') {
      const needle = process.env.ATHENA_AUDIO_HEADSET ?? 'AB17X USB Audio'
      const headset = devices.devices.find(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.label.includes(needle))
      const speaker = devices.devices.find(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.label.includes(needle))
      expect(headset, 'The user-confirmed headset must be present').toBeTruthy()
      expect(speaker, 'The headset must expose an output endpoint').toBeTruthy()
      await control.evaluate(() => window.athena!.updateSettings({ audioDevices: { inputDeviceId: 'default', outputDeviceId: 'default', automaticSwitching: true } }))
      const liveInput = () => floating.evaluate(() => (window as unknown as { micTracks: MediaStreamTrack[] }).micTracks.filter(t => t.readyState === 'live').map(t => t.label))
      await expect.poll(liveInput, { timeout: 15_000 }).toEqual([headset!.label])
      evidence.headsetInput = headset!.label; evidence.headsetOutput = speaker!.label
      evidence.singleCapture = 'Only one live microphone track after switching to the USB headset'
      await control.getByRole('button', { name: 'Test microphone', exact: true }).click()
      await writeFile('/tmp/athena-audio-live-stage.json', JSON.stringify({ stage: 'headset-speak', input: headset!.label }))
      await expect.poll(async () => (await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).microphoneLevel, { timeout: 14_000, intervals: [100] }).toBeGreaterThan(0)
      evidence.headsetRms = 'Actual headset microphone produced nonzero RMS through the existing wake listener'
      await control.evaluate(() => window.athena!.audioDevices({ action: 'test-stop' }))
      await expect.poll(liveInput).toEqual([headset!.label])
      if (process.env.ATHENA_AUDIO_WAKE === '1') {
        const states: string[] = []
        await writeFile('/tmp/athena-audio-live-stage.json', JSON.stringify({ stage: 'say-wake-phrase', input: headset!.label }))
        await expect.poll(async () => {
          const state = (await floating.evaluate(() => window.athena!.getSnapshot())).handsFreeState
          if (state?.state && states.at(-1) !== state.state) states.push(state.state)
          return states.includes('speaking') && state?.state === 'follow-up'
        }, { timeout: 120_000, intervals: [150] }).toBe(true)
        evidence.spokenWake = { states, hardware: headset!.label, recognition: 'Real local Whisper, no transcript injection', response: 'Actual hands-free TTS completed and entered follow-up' }
      } else {
      // Loop only this non-private test preview so disconnect can be observed during real playback.
      await control.evaluate(() => {
        const original = HTMLMediaElement.prototype.play
        HTMLMediaElement.prototype.play = async function () {
          this.loop = true
          ;(window as unknown as { testAudio: HTMLMediaElement }).testAudio = this
          return original.call(this)
        }
      })
      await control.getByRole('button', { name: 'Test Athena voice', exact: true }).click()
      await expect.poll(() => control.evaluate(() => Boolean((window as unknown as { testAudio?: HTMLMediaElement }).testAudio && !(window as unknown as { testAudio: HTMLMediaElement }).testAudio.paused)), { timeout: 120_000 }).toBe(true)
      await writeFile('/tmp/athena-audio-live-stage.json', JSON.stringify({ stage: 'unplug-headset' }))
      await expect.poll(async () => (await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).output.label, { timeout: 180_000, intervals: [300] }).toMatch(/MacBook.*Speakers/)
      await expect.poll(() => control.evaluate(() => (window as unknown as { testAudio: HTMLMediaElement }).testAudio.sinkId)).toBe((await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).output.deviceId)
      await expect.poll(liveInput, { timeout: 15_000 }).toEqual([devices.devices.find(d => d.kind === 'audioinput' && d.endpointType === 'built-in')!.label])
      evidence.disconnect = 'Actual unplug rerouted the existing playback to built-in speakers and recovered exactly one built-in microphone stream'
      await writeFile('/tmp/athena-audio-live-stage.json', JSON.stringify({ stage: 'reconnect-headset' }))
      await expect.poll(async () => (await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).devices.some(d => d.deviceId === speaker!.deviceId), { timeout: 180_000, intervals: [300] }).toBe(true)
      await expect.poll(liveInput, { timeout: 15_000 }).toEqual([headset!.label])
      expect((await control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))).outputHeld).toBe(false)
      await expect.poll(() => control.evaluate(() => (window as unknown as { testAudio: HTMLMediaElement }).testAudio.sinkId)).toBe(speaker!.deviceId)
      await control.getByRole('button', { name: 'Stop Speaking' }).click()
      evidence.reconnect = 'USB input and existing playback recovered automatically without duplicate capture'
      }
    }
    await control.evaluate(async ({ input, output }) => {
      const { settings } = await window.athena!.getSnapshot()
      await window.athena!.updateSettings({ voiceInteraction: { ...settings.voiceInteraction, handsFreeEnabled: false }, audioDevices: { inputDeviceId: input!, outputDeviceId: output!, automaticSwitching: false } })
    }, { input: devices.input.deviceId, output: devices.output.deviceId })
    await app.close(); app = await launch()
    await expect.poll(() => app.windows().some(p => p.url().includes('surface=control'))).toBe(true)
    control = app.windows().find(p => p.url().includes('surface=control'))!
    const saved = (await control.evaluate(() => window.athena!.getSnapshot())).settings.audioDevices
    expect(saved).toEqual({ inputDeviceId: devices.input.deviceId, outputDeviceId: devices.output.deviceId, automaticSwitching: false })
    evidence.persistence = 'Explicit input/output and auto-switch preference survived packaged app restart'
  } finally {
    const control = app.windows().find(p => p.url().includes('surface=control'))
    if (control) {
      evidence.tracks = await control.evaluate(() => (window as unknown as { micTracks?: MediaStreamTrack[] }).micTracks?.map(t => ({ label: t.label, readyState: t.readyState, settings: t.getSettings() }))).catch(() => null)
      evidence.lastState = await control.evaluate(() => window.athena!.audioDevices({ action: 'get' })).catch(() => null)
      evidence.notices = await control.locator('.chat-message-note').allTextContents().catch(() => [])
    }
    await writeFile('/tmp/athena-audio-live-results.json', JSON.stringify(evidence, null, 2))
    await app.close(); await rm(profile, { recursive: true, force: true })
  }
})

test('idle Voice Settings discovers microphones and capture still requires an active lease', async () => {
  test.skip(process.env.ATHENA_MIC_DISCOVERY_LIVE !== '1', 'Requires a signed app and an OS-authorized microphone')
  test.setTimeout(60_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-idle-microphone-'))
  await writeFile(join(profile, 'permissions.json'), JSON.stringify({ version: 2, enabled: { microphone: true } }))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({
    floatingEnabled: true, voiceInteraction: { handsFreeEnabled: false },
    liveVoice: { cloudAllowed: false }, webAccess: { webSearchEnabled: false, automaticStartup: false },
  }))
  const app = await electron.launch({
    executablePath: resolve(process.env.ATHENA_AUDIO_APP ?? 'release/mac-arm64/Athena.app/Contents/MacOS/Athena'),
    args: ['--user-data-dir=' + profile],
  })
  try {
    expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(await realpath(profile))
    expect(await app.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('microphone'))).toBe('granted')
    await expect.poll(() => app.windows().some(page => page.url().includes('surface=control'))).toBe(true)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(w => w.isVisible() && /surface=(control|floating)/.test(w.webContents.getURL())).length
    ), { timeout: 30_000 }).toBe(2)
    await control.getByRole('button', { name: 'Voice', exact: true }).click()
    const state = () => control.evaluate(() => window.athena!.audioDevices({ action: 'get' }))
    const assertCaptureDenied = async () => {
      const result = await control.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          stream.getTracks().forEach(track => track.stop())
          return 'Unexpected capture'
        } catch (error) { return (error as DOMException).name }
      })
      expect(result).toBe('NotAllowedError')
    }
    await expect.poll(async () => (await state()).output.deviceId).toBeTruthy()
    console.info('Initial idle routes', await state().then(s => [s.input.label, s.output.label]))
    await expect.poll(async () => (await state()).input.deviceId, { timeout: 8000 }).toBeTruthy()
    const initial = await state()
    const expectedLabel = process.env.ATHENA_AUDIO_HEADSET ?? initial.input.label
    await expect(control.getByLabel('Microphone device')).toContainText(expectedLabel)
    expect(initial.testActive).toBe(false)
    await assertCaptureDenied()
    await control.evaluate(() => {
      const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      const tracks: MediaStreamTrack[] = []
      Object.assign(window, { discoveryTestTracks: tracks })
      navigator.mediaDevices.getUserMedia = async options => {
        const stream = await open(options)
        tracks.push(...stream.getAudioTracks())
        return stream
      }
    })
    const liveInputs = () => control.evaluate(() =>
      (window as unknown as { discoveryTestTracks: MediaStreamTrack[] }).discoveryTestTracks
        .filter(track => track.readyState === 'live').map(track => track.getSettings().deviceId))
    const testInput = async (deviceId: string) => {
      await control.getByRole('button', { name: 'Test microphone', exact: true }).click()
      await expect.poll(liveInputs).toEqual([deviceId])
      await expect.poll(async () => (await state()).microphoneLevel, { timeout: 13000 }).toBeGreaterThan(0)
      await control.getByRole('button', { name: 'Stop microphone test' }).click()
      await expect.poll(liveInputs).toEqual([])
    }
    await testInput(initial.input.deviceId!)
    await assertCaptureDenied()
    expect((await state()).input.deviceId).toBe(initial.input.deviceId)
    console.info('Verified idle selector and authorized microphone level', initial.input.label)
    const builtIn = initial.devices.find(d => d.kind === 'audioinput' && d.endpointType === 'built-in')
    if (builtIn && builtIn.deviceId !== initial.input.deviceId) {
      await control.getByLabel('Microphone device').hover()
      await control.getByRole('option', { name: builtIn.label, exact: true }).click()
      await expect.poll(async () => (await state()).input.deviceId).toBe(builtIn.deviceId)
      await testInput(builtIn.deviceId)
      expect((await state()).output.deviceId).toBe(initial.output.deviceId)
      console.info('Verified manual microphone and independent output', builtIn.label)
    }
    await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'microphone', enabled: false }))
    await expect.poll(async () => (await state()).devices.some(d => d.kind === 'audioinput')).toBe(false)
    await assertCaptureDenied()
  } finally {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  }
})
