import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('project editor uses trusted IPC, supports non-Git projects, switches targets and reports missing folders', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-editor-desktop-'))
  const first = join(profile, 'first project'), second = join(profile, 'second project')
  await mkdir(first); await mkdir(second)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ aiMode: 'unconfigured', strictOffline: true, voiceEnabled: false, floatingEnabled: false, randomActions: false, randomMovement: false, webAccess: { enabled: false, searxngAutoStart: false } }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().some(page => page.url().includes('surface=control'))).toBe(true)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    await control.setViewportSize({ width: 1100, height: 760 })
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    const button = control.getByRole('button', { name: 'Open in VS Code', exact: true })
    await expect(button).toHaveCount(0)
    const available = await control.evaluate(async () => (await window.athena!.projectEditor({ action: 'status' })).available)
    const connect = async (folder: string) => {
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, folder)
      return control.evaluate(async () => {
        await window.athena!.setPermissionEnabled({ permission: 'personalFiles', enabled: true })
        const chat = await window.athena!.getChat()
        await window.athena!.chatContext({ action: 'connect', sessionId: chat.sessionId! })
        const selected = await window.athena!.getChat()
        return { action: 'open' as const, sessionId: selected.sessionId!, workspaceId: selected.workspaces![0].id }
      })
    }
    const old = await connect(first)
    await expect(control.getByRole('button', { name: /^Git branch:/ })).toHaveCount(0)
    if (available) {
      await expect(button).toBeVisible()
      await expect(button).toHaveAttribute('title', 'Open project folder in Visual Studio Code')
      for (const width of [1100, 800]) {
        await control.setViewportSize({ width, height: 760 })
        const box = await button.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      }
      await control.screenshot({ path: '/tmp/athena-project-editor-narrow.png' })
      await control.setViewportSize({ width: 1100, height: 760 })
    } else await expect(button).toHaveCount(0)
    const current = await connect(second)
    expect(current.workspaceId).not.toBe(old.workspaceId)
    expect(await control.evaluate(old => window.athena!.projectEditor(old), old)).toMatchObject({ ok: false, message: expect.stringContaining('conversation changed') })
    await rm(second, { recursive: true })
    if (available) {
      await button.click()
      await expect(control.getByRole('alert')).toContainText('missing')
      await expect(button).toBeEnabled()
      await control.getByRole('button', { name: 'Dismiss VS Code notice' }).click()
    } else expect(await control.evaluate(command => window.athena!.projectEditor(command), current)).toMatchObject({ ok: false, message: expect.stringContaining('missing') })
    await control.evaluate(async () => { await window.athena!.chatSession({ action: 'create' }) })
    await expect(button).toHaveCount(0)
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }) }
})
