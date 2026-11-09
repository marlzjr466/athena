import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('floating panel and control center use the same session and agent', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-floating-ai-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    const floating = app.windows().find((page) => page.url().includes('surface=floating'))!
    const panel = app.windows().find((page) => page.url().includes('surface=panel'))!
    await app.evaluate(() => {
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'test-text-model' }] }))
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
          const bytes = new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Hello from the shared conversation."}\n\ndata: {"type":"response.completed","response":{}}\n\n')
          controller.enqueue(bytes); controller.close()
        } })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
    })
    expect((await control.evaluate(() => window.athena!.activateAI({ apiKey: 'sk-floating-test-only-not-a-real-api-key' }))).ok).toBe(true)
    expect((await control.evaluate(() => window.athena!.selectAIModel({ model: 'test-text-model' }))).ok).toBe(true)
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    const initial = await control.evaluate(() => window.athena!.getChat())
    await floating.evaluate(() => window.athena!.command('open-panel'))
    await expect(panel.getByRole('textbox', { name: 'Message Athena' })).toBeVisible()
    await panel.getByRole('textbox', { name: 'Message Athena' }).fill('Hello Athena')
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getChat())).draft).toBe('Hello Athena')
    await panel.getByRole('button', { name: 'Send message' }).click()
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getChat())).messages.at(-1)?.content).toBe('Hello from the shared conversation.')
    const shared = await control.evaluate(() => window.athena!.getChat())
    expect(shared.sessionId).toBe(initial.sessionId)
    expect(shared.messages.map((entry) => entry.role)).toEqual(['user', 'assistant'])
    await expect(panel.getByText('Hello from the shared conversation.')).toBeVisible()
    await expect(control.getByText('Hello from the shared conversation.')).toBeVisible()
  } finally { await app.close() }
})
