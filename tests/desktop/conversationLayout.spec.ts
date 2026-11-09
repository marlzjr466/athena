import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChatSnapshot } from '../../shared/chat'
import { IPC } from '../../shared/ipcChannels'

test('conversation composer stays at the window bottom at every interface scale', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-conversation-layout-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    await control.setViewportSize({ width: 1313, height: 1017 })
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(control.locator('.conversation-workbench')).toBeVisible()

    for (const uiScale of [0.85, 1, 1.2]) {
      await control.evaluate((scale) => window.athena!.updateSettings({ uiScale: scale }), uiScale)
      await expect.poll(() => control.locator('.control-center').evaluate((element) => Number.parseFloat(getComputedStyle(element).zoom))).toBe(uiScale)
      await expect.poll(() => control.evaluate(() => {
        const root = document.querySelector('.control-center')!.getBoundingClientRect()
        const workbench = document.querySelector('.conversation-workbench')!.getBoundingClientRect()
        const composer = document.querySelector('.chat-composer-shell')!.getBoundingClientRect()
        return Math.max(
          Math.abs(root.bottom - window.innerHeight),
          Math.abs(workbench.bottom - window.innerHeight),
          Math.abs(composer.bottom - window.innerHeight),
        )
      })).toBeLessThan(50)
    }
  } finally {
    await app.close()
  }
})

test('approval focus and repeated streamed updates keep the conversation shell stationary', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-approval-layout-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    await control.setViewportSize({ width: 1198, height: 1009 })
    await control.evaluate(() => window.athena!.updateSettings({ uiScale: 1.2 }))
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(control.locator('.chat-composer-shell')).toBeVisible()
    const snapshot: ChatSnapshot = await control.evaluate(() => window.athena!.getChat())
    // Exercise real approval buttons without authorizing any real command.
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => ({ ok: true }))
    }, IPC.chatSession)
    snapshot.revision += 1000
    snapshot.phase = 'thinking'
    snapshot.messages = [{ id: 'history', role: 'user', content: 'Prior conversation context.\n\n'.repeat(80), status: 'complete', createdAt: Date.now() }]
    const publish = async () => {
      snapshot.revision++
      await app.evaluate(({ BrowserWindow }, { channel, value }) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=control'))!.webContents.send(channel, value)
      }, { channel: IPC.chatChanged, value: snapshot })
    }
    const assertAnchored = async () => {
      const shell = await control.evaluate(() => ({
        bottom: document.querySelector('.chat-composer-shell')!.getBoundingClientRect().bottom,
        footerTop: document.querySelector('.ai-chat > .chat-privacy-note')!.getBoundingClientRect().top,
        height: innerHeight,
        ancestors: ['html', 'body', '.control-center', '.workspace', '.main-content', '.conversation-route', '.conversation-page', '.conversation-workbench', '.ai-chat'].map(selector => {
          const element = document.querySelector(selector)!
          return { selector, scrollTop: element.scrollTop, bottom: element.getBoundingClientRect().bottom }
        }),
      }))
      expect(Math.abs(shell.height - shell.ancestors.at(-1)!.bottom), JSON.stringify(shell)).toBeLessThan(20)
      expect(Math.abs(shell.footerTop - shell.bottom), JSON.stringify(shell)).toBeLessThan(20)
      expect(shell.ancestors.every(element => element.scrollTop === 0), JSON.stringify(shell)).toBe(true)
    }
    await publish()
    for (let i = 0; i < 3; i++) {
      await control.setViewportSize({ width: 1198, height: i === 1 ? 580 : 1009 })
      snapshot.messages.push({ id: `response-${i}`, role: 'assistant', content: 'Inspecting the authorized project.\n\n'.repeat(12), status: 'streaming', createdAt: Date.now(), execution: { status: 'working', startedAt: Date.now(), updatedAt: Date.now(), activities: [], approval: { id: `approval-${i}`, title: 'Run isolated project command', description: 'npm test -- project.test.ts\nWorking directory: authorized project\nNetwork: blocked. Source writes: blocked.\n'.repeat(20) } } })
      await publish()
      await expect(control.locator(`#approval-approval-${i}`)).toBeFocused()
      const geometry = await control.evaluate(() => {
        const prompt = document.querySelector('.agent-approval')!
        const composer = document.querySelector('.ai-chat-composer')!
        const shell = document.querySelector('.chat-composer-shell')!
        const input = document.querySelector('textarea[aria-label="Message Athena"]')!
        const send = document.querySelector('.chat-send')!
        const promptBox = prompt.getBoundingClientRect()
        const composerBox = composer.getBoundingClientRect()
        const shellBox = shell.getBoundingClientRect()
        const inputBox = input.getBoundingClientRect()
        const sendBox = send.getBoundingClientRect()
        const style = getComputedStyle(prompt)
        return {
          gap: Math.abs(composerBox.top - promptBox.bottom),
          widthRatio: promptBox.width / shellBox.width,
          maxHeight: style.maxHeight,
          height: promptBox.height,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          borderTopWidth: style.borderTopWidth,
          borderBottomWidth: style.borderBottomWidth,
          borderTopLeftRadius: style.borderTopLeftRadius,
          borderTopRightRadius: style.borderTopRightRadius,
          borderBottomLeftRadius: style.borderBottomLeftRadius,
          borderBottomRightRadius: style.borderBottomRightRadius,
          overlapsInput: promptBox.bottom > inputBox.top && promptBox.top < inputBox.bottom,
          overlapsSend: promptBox.bottom > sendBox.top && promptBox.top < sendBox.bottom,
        }
      })
      expect(geometry.gap, JSON.stringify(geometry)).toBeLessThan(2)
      expect(geometry.widthRatio).toBeGreaterThanOrEqual(0.93)
      expect(geometry.widthRatio).toBeLessThanOrEqual(0.97)
      expect(geometry.borderTopLeftRadius).toBe('12px')
      expect(geometry.borderTopRightRadius).toBe('12px')
      expect(geometry.borderBottomLeftRadius).toBe('0px')
      expect(geometry.borderBottomRightRadius).toBe('0px')
      expect(parseFloat(geometry.maxHeight)).toBe(170)
      expect(geometry.height).toBeLessThanOrEqual(180)
      expect(geometry.outlineStyle).toBe('none')
      expect(parseFloat(geometry.outlineWidth) || 0).toBe(0)
      expect(parseFloat(geometry.borderTopWidth)).toBe(0)
      expect(parseFloat(geometry.borderBottomWidth)).toBe(0)
      expect(geometry.overlapsInput).toBe(false)
      expect(geometry.overlapsSend).toBe(false)
      await control.waitForTimeout(1200)
      await assertAnchored()
      const composerTop = await control.evaluate(() => document.querySelector('.ai-chat-composer')!.getBoundingClientRect().top)
      await control.locator(`#approval-approval-${i}`).getByRole('button', { name: i === 1 ? 'Deny' : 'Allow once', exact: true }).click()
      snapshot.messages.at(-1)!.execution!.approval = undefined
      snapshot.messages.at(-1)!.content += '\n\nContinuing after the decision.\n\n'.repeat(10)
      await publish()
      await expect(control.locator('.agent-approval')).toHaveCount(0)
      expect(await control.evaluate(() => document.querySelector('.ai-chat-composer')!.getBoundingClientRect().top)).toBeGreaterThan(composerTop + 8)
      await control.waitForTimeout(1200)
      await assertAnchored()
    }
    snapshot.phase = 'idle'
    snapshot.messages.at(-1)!.execution!.status = 'complete'
    await publish()
    await expect(control.locator('.agent-approval')).toHaveCount(0)
  } finally { await app.close() }
})
