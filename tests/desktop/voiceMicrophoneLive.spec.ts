import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { IPC } from '../../shared/ipcChannels'

test('physical microphone wake command creates a conversation and plays its verified reply', async () => {
  test.skip(process.env.ATHENA_MICROPHONE_LIVE !== '1', 'Requires an available user to speak the announced test phrase')
  test.setTimeout(240_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-microphone-live-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ floatingEnabled: true, randomActions: false, randomMovement: false, voiceEnabled: true, voiceMuted: false, webAccess: { webSearchEnabled: false, automaticStartup: false } }))
  const app = await electron.launch({ executablePath: resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena'), args: [`--user-data-dir=${profile}`], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  const states: string[] = []
  try {
    expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(() => app.windows().some(page => page.url().includes('surface=floating'))).toBe(true)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    const floating = app.windows().find(page => page.url().includes('surface=floating'))!
    const initial = await control.evaluate(() => window.athena!.getSnapshot())
    const before = await control.evaluate(() => window.athena!.getChat())
    // Observe the real handler's result without substituting transcription,
    // permissions or actions. Only booleans about the announced test phrase
    // are retained; no audio or transcript is written to disk.
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<{ ok: boolean; transcript?: string }>> })._invokeHandlers
      const original = handlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const result = await original(...args)
        ;(globalThis as unknown as { phrase?: unknown }).phrase = { ok: result.ok, containsWake: /athena/i.test(result.transcript ?? ''), containsCreate: /create|new|start/i.test(result.transcript ?? ''), containsChat: /chat|conversation/i.test(result.transcript ?? ''), containsProject: /project|folder/i.test(result.transcript ?? '') }
        return result
      })
    }, IPC.handsFreeTranscribe)
    expect(await app.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('microphone')), 'Actual OS microphone permission required').toBe('granted')
    await control.evaluate(async ({ settings, whisper }) => {
      await window.athena!.setPermissionEnabled({ permission: 'microphone', enabled: true })
      await window.athena!.updateSettings({ aiMode: 'local', localAI: { ...settings.localAI, model: 'qwen2.5-coder:3b', speechEngine: 'whisper-cli', speechModelPath: whisper }, automationPermissions: { ...settings.automationPermissions, conversationManagement: true, internalNavigation: true }, voiceInteraction: { ...settings.voiceInteraction, handsFreeEnabled: true } })
    }, { settings: initial.settings, whisper: join(homedir(), '.athena/models/whisper/ggml-small.bin') })
    await expect.poll(async () => {
      const state = (await floating.evaluate(() => window.athena!.getSnapshot())).handsFreeState
      if (state?.state) states.push(state.state)
      await writeFile('/tmp/athena-microphone-live-state.json', JSON.stringify(state))
      return state?.state
    }, { timeout: 60_000 }).toBe('standby')
    await writeFile('/tmp/athena-microphone-live-ready', 'Say: Athena, create a new chat. No audio is saved.')
    await expect.poll(async () => {
      const state = (await floating.evaluate(() => window.athena!.getSnapshot())).handsFreeState
      if (state?.state && states.at(-1) !== state.state) states.push(state.state)
      const phrase = await app.evaluate(() => (globalThis as unknown as { phrase?: unknown }).phrase)
      await writeFile('/tmp/athena-microphone-live-state.json', JSON.stringify({ state: state?.state, message: state?.message, states, phrase }))
      return (await control.evaluate(() => window.athena!.getChat())).sessionId !== before.sessionId
    }, { timeout: 120_000, intervals: [300] }).toBe(true)
    await expect.poll(async () => {
      const state = (await floating.evaluate(() => window.athena!.getSnapshot())).handsFreeState
      if (state?.state && states.at(-1) !== state.state) states.push(state.state)
      await writeFile('/tmp/athena-microphone-live-state.json', JSON.stringify({ state: state?.state, message: state?.message, states }))
      return states.includes('speaking') && (state?.state === 'follow-up' || state?.state === 'standby')
    }, { timeout: 90_000, intervals: [200] }).toBe(true)
    await writeFile('/tmp/athena-microphone-live-results.json', JSON.stringify({ newConversation: true, states, microphone: 'actual hardware', transcription: 'installed local Whisper', speech: 'Chatterbox actual audio playback completed' }))
  } finally {
    await app.close(); await rm(profile, { recursive: true, force: true }); await rm('/tmp/athena-microphone-live-ready', { force: true })
  }
})
