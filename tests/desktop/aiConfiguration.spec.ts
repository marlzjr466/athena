import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('AI configuration uses real isolated Keychain, masked IPC, replacement, removal and restart persistence', async () => {
  test.setTimeout(90_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-ai-test-'))
  const dummyKey = 'sk-native-test-only-not-a-real-api-key'
  let app: ElectronApplication | undefined
  const logs: string[] = []
  async function launch() {
    app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
    app.process().stdout?.on('data', (data: Buffer) => logs.push(data.toString()))
    app.process().stderr?.on('data', (data: Buffer) => logs.push(data.toString()))
    await expect.poll(() => app!.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    await expect(control.getByRole('button', { name: 'AI', exact: true })).toBeVisible()
    await control.evaluate(() => window.athena!.updateSettings({ randomMovement: false, randomActions: false }))
    await control.getByRole('button', { name: 'AI', exact: true }).click()
    return control
  }
  const mockConnection = async (status: number) => {
    // Network is mocked in the test harness only. No production bypass or fake activation flag.
    await app!.evaluate((_electron, code) => {
      globalThis.fetch = async () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] }), { status: code })
    }, status)
  }
  try {
    let control = await launch()
    await expect(control.getByLabel('API Key', { exact: true })).toBeEnabled()
    const floating = app!.windows().find((page) => page.url().includes('surface=floating'))!
    expect(await floating.evaluate(() => window.athena!.getAIStatus().then(() => false, () => true))).toBe(true)
    await mockConnection(401)
    await control.getByLabel('API Key', { exact: true }).fill(dummyKey)
    await control.getByRole('button', { name: 'Save & Activate' }).click()
    await expect(control.getByText('Invalid API key. Check the key or replace it.')).toBeVisible()
    expect((await control.evaluate(() => window.athena!.getAIStatus())).status.active).toBe(false)
    await mockConnection(200)
    await control.getByRole('button', { name: 'Test Connection' }).click()
    await expect(control.getByText('Connection successful.', { exact: true })).toBeVisible()
    expect((await control.evaluate(() => window.athena!.getAIStatus())).status.active).toBe(false)
    await control.getByRole('button', { name: 'Save & Activate' }).click()
    await expect(control.getByLabel('Saved API key, masked')).toBeVisible()
    await control.getByLabel('Model', { exact: true }).selectOption('test-model-b')
    await expect(control.getByText('Model preference saved. Open Conversation to chat.')).toBeVisible()
    const status = await control.evaluate(() => window.athena!.getAIStatus())
    expect(status.status).toMatchObject({ active: true, model: 'test-model-b' })
    expect(JSON.stringify(status)).not.toContain(dummyKey)
    expect(await control.evaluate(() => JSON.stringify(window.localStorage))).not.toContain(dummyKey)
    expect(await readFile(join(profile, 'settings.json'), 'utf8')).not.toContain(dummyKey)
    await control.screenshot({ path: 'test-results/ai-active.png' })
    await app!.close(); app = undefined
    control = await launch()
    await expect(control.getByLabel('Saved API key, masked')).toBeVisible()
    expect((await control.evaluate(() => window.athena!.getAIStatus())).status).toMatchObject({ active: true, model: 'test-model-b' })
    await mockConnection(200)
    await control.getByRole('button', { name: 'Test Connection' }).click()
    await expect(control.getByText('Connection successful.', { exact: true })).toBeVisible()
    await control.getByRole('button', { name: 'Replace API Key' }).click()
    await expect(control.getByLabel('API Key', { exact: false })).toHaveValue('')
    await control.getByLabel('API Key', { exact: false }).fill(`${dummyKey}-replacement`)
    await control.getByRole('button', { name: 'Save & Activate' }).click()
    await expect(control.getByLabel('Saved API key, masked')).toBeVisible()
    await control.getByRole('button', { name: 'Remove API Key', exact: true }).click()
    await control.getByRole('button', { name: 'Confirm removal' }).click()
    await expect(control.getByLabel('API Key', { exact: true })).toHaveValue('')
    expect((await control.evaluate(() => window.athena!.getAIStatus())).status.active).toBe(false)
    await control.screenshot({ path: 'test-results/ai-not-configured.png' })
    expect(logs.join('')).not.toContain(dummyKey)
  } finally {
    if (app) {
      const control = app.windows().find((page) => page.url().includes('surface=control'))
      // Delete only the synthetic credential in this isolated development profile.
      await control?.evaluate(() => window.athena!.removeAIKey()).catch(() => {})
      await app.close()
    }
  }
})
