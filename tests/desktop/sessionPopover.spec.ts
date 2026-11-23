import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChatSnapshot } from '../../shared/chat'
import { IPC } from '../../shared/ipcChannels'

test('project session menu escapes sidebar scrolling and stays inside the viewport near its lower edge', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-session-popover-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().some(page => page.url().includes('surface=control'))).toBe(true)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    await control.setViewportSize({ width: 1100, height: 760 })
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(control.locator('.conversation-workbench')).toBeVisible()

    const snapshot: ChatSnapshot = await control.evaluate(() => window.athena!.getChat())
    const project = { id: '00000000-0000-4000-8000-000000000099', name: 'Popover test project' }
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      title: `Session ${index + 1}`,
      createdAt: index + 1,
      updatedAt: index + 1,
      config: { provider: 'OpenAI' as const, model: null, effort: 'auto' as const },
      project,
    }))
    snapshot.revision += 100
    snapshot.sessionId = sessions[0].id
    snapshot.sessions = sessions
    await app.evaluate(({ BrowserWindow }, { channel, value }) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=control'))!.webContents.send(channel, value)
    }, { channel: IPC.chatChanged, value: snapshot })

    const list = control.locator('.project-session-list')
    await expect(list.locator('[data-conversation-id]')).toHaveCount(12)
    await list.evaluate(element => { element.scrollTop = element.scrollHeight })
    const lastSession = control.locator(`[data-conversation-id="${sessions.at(-1)!.id}"]`)
    const trigger = lastSession.getByRole('button', { name: 'Options for Session 12' })
    await expect(trigger).toBeInViewport()
    await trigger.click()

    const menu = control.getByRole('dialog', { name: 'Conversation options' })
    await expect(menu).toBeVisible()
    const geometry = await control.evaluate(() => {
      const menu = document.querySelector('.anchored-session-popover')!
      const trigger = document.querySelector('[data-conversation-id]:last-child .conversation-options button')!
      const list = document.querySelector('.project-session-list')!
      const menuRect = menu.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const listRect = list.getBoundingClientRect()
      return { parent: menu.parentElement?.tagName, top: menuRect.top, bottom: menuRect.bottom, left: menuRect.left, right: menuRect.right, triggerTop: triggerRect.top, listBottom: listRect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, position: getComputedStyle(menu).position }
    })
    expect(geometry.parent).toBe('BODY')
    expect(geometry.position).toBe('fixed')
    expect(await menu.evaluate(element => getComputedStyle(element).fontSize)).toBe('12px')
    expect(await menu.evaluate(element => getComputedStyle(element).overflowY)).toBe('visible')
    expect(geometry.top).toBeGreaterThan(geometry.triggerTop)
    expect(geometry.bottom).toBeGreaterThan(geometry.listBottom)
    expect(geometry.top).toBeGreaterThanOrEqual(0)
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
    await control.screenshot({ path: join(tmpdir(), 'athena-session-popover-down.png') })

    await control.setViewportSize({ width: 1100, height: 580 })
    await expect.poll(() => menu.evaluate(element => Number.parseFloat(getComputedStyle(element).top))).toBeLessThan(geometry.triggerTop)
    const resized = await menu.boundingBox()
    expect(resized).not.toBeNull()
    expect(resized!.y).toBeGreaterThanOrEqual(0)
    expect(resized!.y + resized!.height).toBeLessThanOrEqual(580)
    await control.screenshot({ path: join(tmpdir(), 'athena-session-popover-up.png') })

    await menu.getByRole('button', { name: 'Rename' }).click()
    const rename = control.getByRole('dialog', { name: 'Rename conversation' })
    await expect(rename).toBeVisible()
    expect(await rename.getByRole('textbox', { name: 'Conversation title' }).evaluate(element => getComputedStyle(element).fontSize)).toBe('12px')
    const renameLayout = await rename.evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowY: getComputedStyle(element).overflowY, maxHeight: getComputedStyle(element).maxHeight }))
    expect(renameLayout).toMatchObject({ overflowY: 'visible' })
    expect(renameLayout.scrollHeight).toBeLessThanOrEqual(renameLayout.clientHeight)
    await control.screenshot({ path: join(tmpdir(), 'athena-session-popover-rename.png') })
    await rename.getByRole('button', { name: 'Cancel' }).click()

    await trigger.click()
    await control.getByRole('dialog', { name: 'Conversation options' }).getByRole('button', { name: 'Delete' }).click()
    const deletion = control.getByRole('dialog', { name: 'Delete' })
    await expect(deletion).toBeVisible()
    expect(await deletion.locator('strong').evaluate(element => getComputedStyle(element).fontSize)).toBe('12px')
    const deleteLayout = await deletion.evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowY: getComputedStyle(element).overflowY, maxHeight: getComputedStyle(element).maxHeight }))
    expect(deleteLayout).toMatchObject({ overflowY: 'visible' })
    expect(deleteLayout.scrollHeight).toBeLessThanOrEqual(deleteLayout.clientHeight)
    await control.screenshot({ path: join(tmpdir(), 'athena-session-popover-delete.png') })

    await list.evaluate(element => { element.scrollTop = 0 })
    await expect(deletion).toBeHidden()
  } finally {
    await app.close()
  }
})
