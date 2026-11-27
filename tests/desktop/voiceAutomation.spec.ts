import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('floating voice IPC executes recognized app commands through the real Electron action registry', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-voice-automation-'))
  const project = join(profile, 'Voice Project')
  await mkdir(project); await writeFile(join(project, 'source.txt'), 'fixture')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }, stdio: 'pipe' })
  git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'disposable voice fixture'); git('branch', 'feature/other')
  await writeFile(join(project, 'source.txt'), 'keep unstaged'); await writeFile(join(project, 'untracked.txt'), 'keep untracked')
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ computerUse: {browser:'embedded'}, floatingEnabled: false, randomActions: false, randomMovement: false, webAccess: { webSearchEnabled: false, automaticStartup: false } }))
  const appEnvironment = { ...process.env, ATHENA_TEST_DATA: profile, ELECTRON_RENDERER_URL: new URL('../../out/renderer/index.html', import.meta.url).href }
  let app: ElectronApplication = await electron.launch({ args: ['.'], env: appEnvironment })
  try {
    await expect.poll(() => app.windows().filter(page => /surface=(control|floating)/.test(page.url())).length).toBe(2)
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
    const command = async (text: string) => { console.info('Fixture voice action:', text); const result = await floating.evaluate(({ text, ownership }) => window.athena!.answerHandsFree({ text, ownership }), { text, ownership }); console.info('Fixture result:', result.ok, result.message ?? result.text); return result }
    expect(await command('open my latest conversation')).toMatchObject({ ok: false, message: expect.stringContaining('off') })
    await control.evaluate(settings => window.athena!.updateSettings({ automationPermissions: { ...settings.automationPermissions, conversationManagement: true, internalNavigation: true, browserAccess: true, projectManagement: true, gitOperations: true, fileReading: true, fileModification: true } }), initial.settings)

    // Exercise the mounted floating renderer through the same trusted IPC
    // status channel used by HandsFreeAssistant, without recording microphone audio.
    await floating.evaluate(ownership => window.athena!.setHandsFreeState({ state: 'follow-up', ownership }), ownership)
    expect(await floating.evaluate(ownership => window.athena!.setHandsFreeState({ state: 'processing', ownership }), ownership)).toMatchObject({ ok: true })
    expect((await floating.evaluate(() => window.athena!.getSnapshot())).floatingVoiceActive).toBe(true)
    await expect(floating.locator('.task-holograms')).toHaveCount(0)
    expect(await floating.evaluate(ownership => window.athena!.setHandsFreeState({ state: 'speaking', ownership }), ownership)).toMatchObject({ ok: true })
    expect((await floating.evaluate(() => window.athena!.getSnapshot())).floatingVoiceActive).toBe(true)
    await expect(floating.locator('.task-holograms')).toHaveCount(0)
    await floating.evaluate(ownership => window.athena!.handsFreePlayback({ playing: false, ownership }), ownership)
    expect(await floating.evaluate(ownership => window.athena!.setHandsFreeState({ state: 'follow-up', ownership }), ownership)).toMatchObject({ ok: true })
    expect((await floating.evaluate(() => window.athena!.getSnapshot())).floatingVoiceActive).toBe(true)

    const opened = await floating.evaluate(({ text, ownership }) => window.athena!.answerHandsFree({ text, ownership }), { text: 'Hey Athena, open YouTube in my default browser.', ownership })
    expect(opened.ok, `${opened.message}\n${await app.evaluate(() => (globalThis as unknown as { automationLogs: string[] }).automationLogs.join('\n'))}`).toBe(true)
    const afterVoiceReply = await floating.evaluate(() => window.athena!.getSnapshot())
    expect(afterVoiceReply.floatingVoiceActive).toBe(true)
    expect(afterVoiceReply.taskVisual?.mode).toBe('completed')
    expect(afterVoiceReply.taskVisual?.source).toBe('voice-automation')
    expect(opened.text).toContain('Page loading was not verified')
    expect(await app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls)).toEqual(['https://www.youtube.com/'])
    expect(await app.evaluate(() => (globalThis as unknown as { automationDialogs: unknown[] }).automationDialogs)).toEqual([])
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
    const targetStatus=await floating.evaluate(ownership=>window.athena!.answerHandsFree({text:'What model am I using?',ownership}),ownership)
    expect(targetStatus.ok,targetStatus.message??targetStatus.text).toBe(true)
    expect(targetStatus.text).toContain('The model is')

    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, project)
    await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'personalFiles', enabled: true }))
    expect(await command('open another project')).toMatchObject({ ok: true, text: expect.stringContaining('Voice Project') })
    expect(await command('what branch am I on')).toMatchObject({ ok: true, text: expect.stringContaining('main') })
    expect(await command('switch to feature/other')).toMatchObject({ ok: true })
    expect(git('branch', '--show-current').trim()).toBe('feature/other')
    expect(await command('create a branch named feature/voice')).toMatchObject({ ok: true })
    expect(git('branch', '--show-current').trim()).toBe('feature/voice')
    expect(await readFile(join(project, 'source.txt'), 'utf8')).toBe('keep unstaged')
    expect(await readFile(join(project, 'untracked.txt'), 'utf8')).toBe('keep untracked')
    await expect(control.getByRole('button', { name: 'Git branch: feature/voice' })).toBeVisible()
    expect(await command('go back to my normal conversation')).toMatchObject({ ok: true })
    expect((await control.evaluate(() => window.athena!.getChat())).workspaces).toHaveLength(0)
    expect(await command('open Voice Project')).toMatchObject({ ok: true })
    expect((await control.evaluate(() => window.athena!.getChat())).workspaces?.[0].name).toBe('Voice Project')
    expect(await command('stop the current task')).toMatchObject({ ok: true })

    // Real Chromium + production DOM adapter, with explicitly mocked website
    // content. This tests routing/verification, not live YouTube compatibility.
    await app.evaluate(({ session }) => {
      const fromPartition = session.fromPartition.bind(session)
      const registered = new Set<string>()
      session.fromPartition = (partition, options) => {
        const target = fromPartition(partition, options)
        if (partition.startsWith('athena-voice-browser-') && !registered.has(partition)) {
          registered.add(partition)
          void target.protocol.handle('https', () => new Response('<!doctype html><title>Voice Browser Fixture</title><input aria-label="Query"><button onclick="this.textContent=\'Finished\'">Action</button><input type="password" aria-label="Password" value="never disclose">', { headers: { 'content-type': 'text/html' } }))
        }
        return target
      }
      ;(globalThis as unknown as { restoreVoiceBrowserFixture(): Promise<void> }).restoreVoiceBrowserFixture = async () => { session.fromPartition = fromPartition; for (const partition of registered) await fromPartition(partition).protocol.unhandle('https') }
    })
    await control.evaluate(async () => { const { settings } = await window.athena!.getSnapshot(); await window.athena!.updateSettings({ automationPermissions: { ...settings.automationPermissions, browserInteraction: true }, webAccess: { ...settings.webAccess, webSearchEnabled: true, automaticStartup: false } }) })
    expect(await command('open YouTube')).toMatchObject({ ok: true, text: expect.stringContaining('Voice Browser Fixture') })
    expect(await command('read the active page title')).toMatchObject({ ok: true, text: expect.stringContaining('Voice Browser Fixture') })
    expect(await command('type "test words" into "Query" on the page')).toMatchObject({ ok: true })
    const browser = app.windows().find(page => page.url().startsWith('https://www.youtube.com/'))!
    await expect(browser.getByRole('textbox', { name: 'Query' })).toHaveValue('test words')
    expect(await command('read the active page title')).toMatchObject({ ok: true })
    expect(await command('click "Action" on the page')).toMatchObject({ ok: true })
    await expect(browser.getByRole('button', { name: 'Finished' })).toBeVisible()
    expect(await command('pause the video')).toMatchObject({ ok: false, message: expect.stringContaining('No video') })
    await control.evaluate(async () => { const { settings } = await window.athena!.getSnapshot(); await window.athena!.updateSettings({ automationPermissions: { ...settings.automationPermissions, browserInteraction: false } }) })
    await expect.poll(() => browser.isClosed()).toBe(true)
    expect(await command('open YouTube')).toMatchObject({ ok: false, message: expect.stringContaining('off') })
    if (process.env.ATHENA_VOICE_BROWSER_LIVE === '1') {
      await app.evaluate(() => (globalThis as unknown as { restoreVoiceBrowserFixture(): Promise<void> }).restoreVoiceBrowserFixture())
      await control.evaluate(async () => { const { settings } = await window.athena!.getSnapshot(); await window.athena!.updateSettings({ automationPermissions: { ...settings.automationPermissions, browserInteraction: true } }) })
      const live: Array<{ command: string; result: unknown }> = []
      for (const text of ['open YouTube', 'read the active page title', 'find a video about Big Buck Bunny Blender', 'play the first video', 'mute the volume', 'resume the video', 'pause the video']) {
        const result = await command(text); live.push({ command: text, result })
        if (!result.ok) break
      }
      await writeFile('/tmp/athena-voice-live-browser-results.json', JSON.stringify(live, null, 2))
      expect(live.length).toBeGreaterThan(0)
      console.info('Live website observations saved; unsupported/blocked actions are NOT counted as successful playback.')
      await control.evaluate(async () => { const { settings } = await window.athena!.getSnapshot(); await window.athena!.updateSettings({ automationPermissions: { ...settings.automationPermissions, browserInteraction: false } }) })
    }

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

    expect(await command('Open AI settings')).toMatchObject({ok:true})
    const computer = control.locator('section.settings-section').filter({has:control.getByRole('heading',{name:'Computer use',exact:true})})
    await expect(computer.getByRole('switch',{name:'Enable computer use'})).toBeVisible()
    await computer.getByRole('button',{name:'Run test'}).click()
    await expect(computer.getByRole('status').filter({hasText:'The active conversation'})).toContainText(/idle/)
    expect(await command('Go back in Athena')).toMatchObject({ok:true})
    await expect(control.getByRole('region',{name:'Athena Academy'})).toBeVisible()
    expect(await command('Go forward in Athena')).toMatchObject({ok:true})
    await expect(computer).toBeVisible()
    await floating.evaluate(ownership => window.athena!.disableHandsFree(ownership), ownership)
    await app.close()
    app = await electron.launch({ args: ['.'], env: appEnvironment })
    await expect.poll(() => app.windows().some(page => page.url().includes('surface=control'))).toBe(true)
    const restored = app.windows().find(page => page.url().includes('surface=control'))!
    expect((await restored.evaluate(() => window.athena!.getSnapshot())).settings.automationPermissions).toMatchObject({ conversationManagement: true, projectManagement: true, gitOperations: true, browserInteraction: false, screenObservation: false })
    const restoredChat = await restored.evaluate(() => window.athena!.getChat())
    expect(restoredChat.workspaces?.[0]).toMatchObject({ name: 'Voice Project', authorized: true })
    expect(git('branch', '--show-current').trim()).toBe('feature/voice')
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }) }
})

test('signed distribution runs the voice action registry and the packaged browser driver', async () => {
  const executablePath = process.env.ATHENA_VOICE_TEST_BINARY
  test.skip(!executablePath, 'Requires a packaged Athena executable and installed Chrome')
  const profile = await mkdtemp(join(tmpdir(), 'athena-packaged-automation-'))
  let app: ElectronApplication | undefined
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({
      floatingEnabled: false,
      webAccess: { webSearchEnabled: false, automaticStartup: false },
    }))
    app = await electron.launch({ executablePath, args: ['--user-data-dir=' + profile] })
    const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(await realpath(actualProfile)).toBe(await realpath(profile))
    await expect.poll(() => app!.windows().some(page => page.url().includes('surface=control'))).toBe(true)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    const checkStatus = () => control.evaluate(() => window.athena!.computerUseCheck('test'))
    expect((await checkStatus()).test).toMatchObject({ ok: false })
    await control.evaluate(async () => {
      const { settings } = await window.athena!.getSnapshot()
      await window.athena!.updateSettings({
        automationPermissions: { ...settings.automationPermissions, conversationManagement: true },
      })
    })
    expect((await checkStatus()).test).toMatchObject({ ok: true, message: expect.stringContaining('idle') })

    const result = await app.evaluate(async ({ app }) => {
      if (!app.isPackaged) throw new Error('Expected a packaged application')
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const { chromium } = require('playwright-core') as typeof import('playwright-core')
      const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true })
      try {
        const page = await browser.newPage()
        await page.setContent('<button onclick="this.textContent=\'Verified\'">Run</button>')
        await page.getByRole('button', { name: 'Run' }).click()
        return await page.getByRole('button', { name: 'Verified' }).count()
      } finally {
        await browser.close()
      }
    })
    expect(result).toBe(1)
  } finally {
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
