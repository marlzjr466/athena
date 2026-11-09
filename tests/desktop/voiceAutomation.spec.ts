import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('floating voice IPC executes recognized app commands through the real Electron action registry', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-voice-automation-'))
  const appEnvironment = { ...process.env, ATHENA_TEST_DATA: profile, ELECTRON_RENDERER_URL: new URL('../../out/renderer/index.html', import.meta.url).href }
  const app: ElectronApplication = await electron.launch({ args: ['.'], env: appEnvironment })
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    const floating = app.windows().find(page => page.url().includes('surface=floating'))!
    const initial = await control.evaluate(() => window.athena!.getSnapshot())

    // Keep the floating renderer mounted but hidden so this transcript-level
    // IPC test does not request live microphone capture. The command text is
    // injected at the same boundary Whisper hands to the local voice router.
    await app.evaluate(({ systemPreferences, dialog, shell }) => {
      const state = globalThis as unknown as { automationDialogs: Array<{ message: string; detail: string }>; openedUrls: string[]; automationLogs: string[] }
      state.automationDialogs = []
      state.openedUrls = []
      state.automationLogs = []
      const originalInfo = console.info.bind(console)
      console.info = (...args: unknown[]) => { state.automationLogs.push(args.map(String).join(' ')); originalInfo(...args) }
      systemPreferences.getMediaAccessStatus = () => 'granted'
      dialog.showMessageBox = (async (_window, options) => {
        state.automationDialogs.push({ message: options.message ?? '', detail: options.detail ?? '' })
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      shell.openExternal = async url => {
        state.openedUrls.push(url)
        return undefined
      }
    })
    await control.evaluate(settings => window.athena!.updateSettings({
      aiMode: 'local', floatingEnabled: false,
      voiceInteraction: { ...settings.voiceInteraction, handsFreeEnabled: true },
      localAI: { ...settings.localAI, speechEngine: 'whisper-cli', speechModelPath: '/tmp/athena-e2e-whisper-not-used' },
    }), initial.settings)
    expect(await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'microphone', enabled: true }))).toMatchObject({ ok: true })
    expect(await control.evaluate(() => window.athena!.isCapabilityAllowed({ permission: 'microphone' }))).toBe(true)

    const localSession = await floating.evaluate(() => window.athena!.getChat())
    const lease = await floating.evaluate(sessionId => window.athena!.enableHandsFree(sessionId), localSession.sessionId)
    expect(lease.ok, lease.message).toBe(true)
    expect(lease.ownership).toMatchObject({ origin: 'athena-local', sessionId: localSession.sessionId })
    const ownership = lease.ownership!

    const opened = await floating.evaluate(({ text, ownership }) => window.athena!.answerHandsFree({ text, ownership }), { text: 'Hey Athena, open YouTube in my current browser.', ownership })
    expect(opened.ok, `${opened.message}\n${await app.evaluate(() => (globalThis as unknown as { automationLogs: string[] }).automationLogs.join('\n'))}`).toBe(true)
    expect(opened.text).toContain('Page loading was not verified')
    expect(await app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls)).toEqual(['https://www.youtube.com/'])
    expect(await app.evaluate(() => (globalThis as unknown as { automationDialogs: Array<{ message: string; detail: string }> }).automationDialogs)).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/allow browser access/i), detail: expect.stringContaining('browser.openUrl') }),
    ])
    expect((await control.evaluate(() => window.athena!.getSnapshot())).settings.automationPermissions.browserAccess).toBe(true)

    const priorOnline = await control.evaluate(() => window.athena!.getChat())
    const createdOnline = await floating.evaluate(({ text, ownership }) => window.athena!.answerHandsFree({ text, ownership }), { text: 'Hey Athena, open a new chat in Online AI Chat.', ownership })
    expect(createdOnline.ok, createdOnline.message).toBe(true)
    expect(createdOnline.text).toContain('Created an online conversation')
    const online = await control.evaluate(() => window.athena!.getChat())
    expect(online.sessionId).not.toBe(priorOnline.sessionId)
    expect(online.sessions?.some(session => session.id === online.sessionId)).toBe(true)
    await expect(control.getByRole('textbox', { name: 'Message Athena' }), `Control page after native navigation (${control.url()}): ${await control.locator('body').innerText()}`).toBeVisible()
    expect((await control.evaluate(() => window.athena!.getSnapshot())).settings.automationPermissions.conversationManagement).toBe(true)

    const priorLocal = await control.evaluate(() => window.athena!.getAthenaChat())
    const createdLocal = await floating.evaluate(({ text, ownership }) => window.athena!.answerHandsFree({ text, ownership }), { text: 'Hey Athena, create a new local Athena Chat conversation.', ownership })
    expect(createdLocal.ok, createdLocal.message).toBe(true)
    expect(createdLocal.text).toContain('Created a private local Athena Chat conversation')
    const local = await control.evaluate(() => window.athena!.getAthenaChat())
    expect(local.sessionId).not.toBe(priorLocal.sessionId)
    await expect(control.getByRole('region', { name: 'Athena Chat' })).toBeVisible()

    const academy = await floating.evaluate(({ text, ownership }) => window.athena!.answerHandsFree({ text, ownership }), { text: 'Hey Athena, open Athena Academy.', ownership })
    expect(academy.ok, academy.message).toBe(true)
    expect(academy.text).toContain('Opened Athena academy')
    await expect(control.getByRole('region', { name: 'Athena Academy' })).toBeVisible()

    const resultSpeech = await floating.evaluate(({ ownership }) => window.athena!.speakHandsFree({ id: crypto.randomUUID(), text: 'Done.', ownership }), { ownership })
    expect(resultSpeech.ok, resultSpeech.message).toBe(true)
    expect(resultSpeech.mimeType).toBe('audio/wav')
    expect(resultSpeech.bytes?.byteLength).toBeGreaterThan(0)
    expect((await control.evaluate(() => window.athena!.getSnapshot())).settings.localVoice.engine).toBe('chatterbox-turbo')
    await floating.evaluate(ownership => window.athena!.disableHandsFree(ownership), ownership)
  } finally { await app.close() }
})
