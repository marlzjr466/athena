import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('native text chat streams safely, retains context, stops/retries/clears and restores companion state', async () => {
  test.setTimeout(90_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-chat-test-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  const logs: string[] = []
  app.process().stdout?.on('data', (data: Buffer) => logs.push(data.toString()))
  app.process().stderr?.on('data', (data: Buffer) => logs.push(data.toString()))
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    const floating = app.windows().find((page) => page.url().includes('surface=floating'))!
    await expect(control.getByRole('button', { name: 'Conversation', exact: true })).toBeVisible()
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(control.getByText('Athena AI is not configured. Add your OpenAI API key in Settings → AI.')).toBeVisible()
    expect(await floating.evaluate(() => window.athena!.sendChat({ text: 'no' }).then(() => false, () => true))).toBe(true)
    await app.evaluate(() => {
      const state = globalThis as unknown as { chatTestMode: string; chatTestRequests: Array<{ input: unknown; tools?: unknown; store: boolean }>; chatTestAborted: boolean }
      state.chatTestMode = 'normal'; state.chatTestRequests = []; state.chatTestAborted = false
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'test-text-model' }] }))
        const body = JSON.parse(init!.body as string)
        state.chatTestRequests.push({ input: body.input, tools: body.tools, store: body.store })
        if (state.chatTestMode === 'error') return new Response(JSON.stringify({ error: { message: 'private-error-details', code: 'test', type: 'test' } }), { status: 429 })
        const delay = state.chatTestMode === 'slow' ? 30_000 : 1500
        const timers: Array<ReturnType<typeof setTimeout>> = []
        let cancel = () => {}
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const event = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
            const cleanup = () => { for (const timer of timers) clearTimeout(timer); init?.signal?.removeEventListener('abort', abort) }
            const abort = () => { state.chatTestAborted = true; cleanup(); controller.error(new Error('aborted')) }
            cancel = cleanup
            init?.signal?.addEventListener('abort', abort, { once: true })
            timers.push(setTimeout(() => event({ type: 'response.output_text.delta', delta: '## Hello\n\n' }), 600))
            timers.push(setTimeout(() => event({ type: 'response.output_text.delta', delta: '**Streamed** text.\n\n```ts\nconst answer = 42\n```\n\n![tracking](https://example.com/pixel)' }), delay))
            timers.push(setTimeout(() => { event({ type: 'response.completed', response: {} }); cleanup(); controller.close() }, delay + 300))
          }, cancel() { cancel() },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
    })
    expect((await control.evaluate(() => window.athena!.activateAI({ apiKey: 'sk-chat-test-only-not-a-real-api-key' }))).ok).toBe(true)
    expect((await control.evaluate(() => window.athena!.selectAIModel({ model: 'test-text-model' }))).ok).toBe(true)
    await control.getByRole('button', { name: 'My companion', exact: true }).click()
    await expect(control.getByRole('heading', { name: /A little presence/ })).toBeVisible()
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(control.getByRole('textbox', { name: 'Message Athena' })).toBeEnabled()
    await control.getByRole('button', { name: 'Work through code' }).click()
    await expect(control.getByRole('textbox', { name: 'Message Athena' })).toHaveValue('Help me understand a piece of code.')
    expect((await control.evaluate(() => window.athena!.getChat())).messages).toHaveLength(0)
    await control.evaluate(() => window.athena!.updateSettings({ randomMovement: true, pinned: false, randomActions: true, wanderIntervalSeconds: 10 }))
    const snapshot = () => control.evaluate(() => window.athena!.getSnapshot())
    const chat = () => control.evaluate(() => window.athena!.getChat())
    const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=floating'))!.getBounds())
    const origin = await bounds()
    await control.getByRole('textbox', { name: 'Message Athena' }).fill('Hello from the chat integration test')
    expect(await control.getByRole('textbox', { name: 'Message Athena' }).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')
    const typingBorder = await control.locator('.ai-chat-composer').evaluate((element) => getComputedStyle(element).borderColor)
    await control.getByRole('textbox', { name: 'Message Athena' }).blur()
    expect(await control.locator('.ai-chat-composer').evaluate((element) => getComputedStyle(element).borderColor)).toBe(typingBorder)
    await control.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await snapshot()).state, { intervals: [20] }).toBe('thinking')
    await expect.poll(async () => (await snapshot()).state, { intervals: [20] }).toBe('speaking')
    expect((await chat()).messages[1].content).toContain('Hello')
    await expect.poll(async () => (await chat()).phase, { intervals: [30] }).toBe('idle')
    expect((await snapshot()).state).toBe('idle')
    expect(await bounds()).toEqual(origin)
    await expect(control.getByRole('heading', { name: 'Hello', exact: true })).toBeVisible()
    expect(await control.locator('.chat-message img, .chat-message a').count()).toBe(0)
    await expect(control.getByRole('button', { name: 'Copy code', exact: true })).toBeVisible()
    expect(await control.locator('.chat-message > header').count()).toBe(0)
    await expect(control.locator('.chat-code-toolbar').getByText('ts', { exact: true })).toBeVisible()
    await expect(control.locator('.hljs-keyword')).toHaveText('const')
    const layout = await control.evaluate(() => {
      const user = document.querySelector('.chat-message.user')!
      const transcript = document.querySelector('.chat-transcript')!
      const composer = document.querySelector('.ai-chat-composer')!
      return { userWidth: user.getBoundingClientRect().width, transcriptWidth: transcript.clientWidth, maxWidth: getComputedStyle(user).maxWidth, composerBottom: composer.getBoundingClientRect().bottom, viewport: innerHeight, pageOverflows: document.querySelector('.main-content')!.scrollHeight > document.querySelector('.main-content')!.clientHeight + 1 }
    })
    expect(layout.maxWidth).toBe('75%')
    expect(layout.userWidth).toBeLessThanOrEqual(layout.transcriptWidth * .75)
    expect(layout.composerBottom).toBeLessThan(layout.viewport)
    expect(layout.pageOverflows).toBe(false)
    await control.screenshot({ path: 'test-results/chat-streamed.png' })
    await control.getByRole('textbox', { name: 'Message Athena' }).fill('Remember my previous question')
    await control.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await chat()).messages.filter((message) => message.role === 'assistant' && message.status === 'complete').length).toBe(2)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=control'))!.setSize(960, 680))
    await control.locator('.chat-transcript').evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
    await expect(control.getByRole('button', { name: 'Jump to latest message' })).toBeVisible()
    await control.getByRole('button', { name: 'Jump to latest message' }).click()
    await expect.poll(() => control.locator('.chat-transcript').evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)
    expect(await control.locator('.ai-chat-composer').evaluate((element) => element.getBoundingClientRect().bottom < innerHeight)).toBe(true)
    await control.screenshot({ path: 'test-results/chat-compact.png' })
    const compactLayout = await control.locator('.main-content').evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight }))
    expect(compactLayout.scrollWidth, JSON.stringify(compactLayout)).toBeLessThanOrEqual(compactLayout.width)
    expect(compactLayout.scrollHeight, JSON.stringify(compactLayout)).toBeLessThanOrEqual(compactLayout.height + 1)
    const requests = await app.evaluate(() => (globalThis as unknown as { chatTestRequests: Array<{ input: Array<{ role: string }>; tools?: unknown; store: boolean }> }).chatTestRequests)
    expect(requests[1].input.map(({ role }) => role)).toEqual(['user', 'assistant', 'user'])
    expect(requests.every((request) => request.tools === undefined && request.store === false)).toBe(true)
    await app.evaluate(() => { (globalThis as unknown as { chatTestMode: string }).chatTestMode = 'slow' })
    await control.getByRole('textbox', { name: 'Message Athena' }).fill('Stop this response')
    await control.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await chat()).phase).toBe('speaking')
    await control.getByRole('button', { name: 'Stop generation' }).click()
    await expect.poll(async () => (await chat()).phase).toBe('idle')
    expect((await chat()).messages.at(-1)?.status).toBe('stopped')
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { chatTestAborted: boolean }).chatTestAborted)).toBe(true)
    await app.evaluate(() => { (globalThis as unknown as { chatTestMode: string }).chatTestMode = 'normal' })
    await control.getByRole('button', { name: 'Retry response', exact: true }).click()
    await expect.poll(async () => (await chat()).messages.at(-1)?.status).toBe('complete')
    expect((await chat()).messages).toHaveLength(6)
    await app.evaluate(() => { (globalThis as unknown as { chatTestMode: string }).chatTestMode = 'error' })
    await control.getByRole('textbox', { name: 'Message Athena' }).fill('Trigger a test error')
    await control.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await chat()).messages.at(-1)?.status).toBe('error')
    expect((await snapshot()).state).toBe('idle')
    expect(JSON.stringify(await chat())).not.toContain('private-error-details')
    await expect(control.getByRole('button', { name: 'Clear conversation', exact: true })).toHaveCount(0)
    await control.evaluate(() => window.athena!.clearChat())
    await expect.poll(async () => (await chat()).messages.length).toBe(0)
    expect((await snapshot()).settings.randomMovement).toBe(true)
    await expect.poll(async () => JSON.stringify(await bounds()) !== JSON.stringify(origin), { timeout: 15_000, intervals: [100] }).toBe(true)
    expect(logs.join('')).not.toContain('Hello from the chat integration test')
    expect(logs.join('')).not.toContain('sk-chat-test-only')
  } finally {
    const control = app.windows().find((page) => page.url().includes('surface=control'))
    await control?.evaluate(() => window.athena!.removeAIKey()).catch(() => {})
    await app.close()
  }
})
