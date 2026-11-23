import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('sub-agent preferences save through Electron IPC without authentication and survive app restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-subagent-preferences-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ aiMode: 'unconfigured', strictOffline: true, voiceEnabled: false, randomActions: false, randomMovement: false, floatingEnabled: false, webAccess: { enabled: false, searxngAutoStart: false } }))
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile }, timeout: 30000 })
  let app = await launch()
  try {
    await expect.poll(() => app.windows().some(page => page.url().includes('surface=control'))).toBe(true)
    let control = app.windows().find(page => page.url().includes('surface=control'))!
    await control.getByRole('button', { name: 'AI', exact: true }).click()
    await expect(control.getByRole('heading', { name: 'Agent execution · Sub-agents' })).toBeVisible()
    await expect(control.getByLabel('Enable sub-agents', { exact: true })).toBeEnabled()
    await expect(control.getByRole('combobox', { name: 'Cold-read model', exact: true })).toBeEnabled()
    await control.getByLabel('Per-request context budget (tokens, including output)', { exact: true }).fill('256123')
    await control.getByLabel('Total token budget per child (all requests)', { exact: true }).fill('500000')
    await control.getByLabel('Context safety margin (%)', { exact: true }).fill('20')
    await control.getByRole('button', { name: 'Save sub-agent settings' }).click()
    await expect(control.getByText('Sub-agent settings saved. New workers will use these preferences.')).toBeVisible()
    const persisted = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))
    expect(persisted.subagents).toMatchObject({ contextTokens: 256123, tokenBudget: 500000, contextSafetyMargin: .2 })
    await control.getByRole('button', { name: 'General', exact: true }).click()
    await control.getByRole('button', { name: 'AI', exact: true }).click()
    await expect(control.getByLabel('Per-request context budget (tokens, including output)', { exact: true })).toHaveValue('256123')
    await app.close()
    app = await launch()
    await expect.poll(() => app.windows().some(page => page.url().includes('surface=control'))).toBe(true)
    control = app.windows().find(page => page.url().includes('surface=control'))!
    await control.getByRole('button', { name: 'AI', exact: true }).click()
    await expect(control.getByLabel('Per-request context budget (tokens, including output)', { exact: true })).toHaveValue('256123')
    await expect(control.getByLabel('Total token budget per child (all requests)', { exact: true })).toHaveValue('500000')
    await expect(control.getByLabel('Context safety margin (%)', { exact: true })).toHaveValue('20')
    await expect(control.getByText(/Effective context budget: 13,107/).first()).toBeVisible()
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }) }
})
