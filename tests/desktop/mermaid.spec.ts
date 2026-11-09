import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('chat renders a completed Mermaid response in an expandable sandboxed diagram', async () => {
  test.setTimeout(45_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-mermaid-test-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    await app.evaluate(() => {
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'test-text-model' }] }))
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
          const event = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
          event({ type: 'response.output_text.delta', delta: 'Here is the flow:\n\n```mermaid\ngraph TD\nA[Start] --> B[Done]\n```' })
          event({ type: 'response.completed', response: {} })
          controller.close()
        } })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
    })
    expect((await control.evaluate(() => window.athena!.activateAI({ apiKey: 'sk-mermaid-test-only-not-a-real-key' }))).ok).toBe(true)
    expect((await control.evaluate(() => window.athena!.selectAIModel({ model: 'test-text-model' }))).ok).toBe(true)
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await control.getByRole('textbox', { name: 'Message Athena' }).fill('Show me a Mermaid diagram')
    await control.getByRole('button', { name: 'Send message', exact: true }).click()
    const diagram = control.locator('iframe[title="Mermaid diagram"]')
    await expect(diagram).toBeVisible({ timeout: 20_000 })
    await expect(control.frameLocator('iframe[title="Mermaid diagram"]').locator('svg')).toBeVisible()
    expect(await diagram.getAttribute('sandbox')).toBe('')
    expect(await diagram.getAttribute('srcdoc')).toContain("default-src 'none'")
    await control.getByRole('button', { name: 'Expand diagram' }).click()
    await expect(control.getByRole('button', { name: 'Close expanded diagram' })).toBeVisible()
  } finally {
    const control = app.windows().find((page) => page.url().includes('surface=control'))
    await control?.evaluate(() => window.athena!.removeAIKey()).catch(() => {})
    await app.close()
  }
})
