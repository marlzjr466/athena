import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('practical reports render responsively, retry one exercise, execute real sandbox tests, and persist history', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-practical-ui-'))
  let app: ElectronApplication | undefined
  try {
    const build = (entry: string, file: string, browser = false) => execFileSync(resolve('node_modules/.bin/esbuild'), [entry, '--bundle', `--platform=${browser ? 'browser' : 'node'}`, `--format=${browser ? 'iife' : 'cjs'}`, '--conditions=style', '--jsx=automatic', '--external:electron', `--outfile=${join(directory, file)}`])
    build('tests/fixtures/academyPracticalHarness.ts', 'main.cjs')
    build('tests/fixtures/academyPracticalPreload.ts', 'preload.cjs')
    build('tests/fixtures/academyPracticalView.tsx', 'view.js', true)
    await writeFile(join(directory, 'index.html'), '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>')
    const now = '2026-10-21T09:02:05.800Z'
    const original = { id: randomUUID(), stage: 'practical', completedAt: now, passed: false, score: 2 / 3 * 100, evidence: [], checks: [
      { name: 'Code reading practice', passed: false, response: '5,5', detail: 'Reference-scored response' },
      { name: 'Executable test: sum', passed: true, response: 'function solve(values) { return values.reduce((a,b)=>a+b,0) }', detail: '5' },
      { name: 'Executable test: empty sum', passed: true, response: 'function solve(values) { return values.reduce((a,b)=>a+b,0) }', detail: '0' },
    ] }
    await writeFile(join(directory, 'academy.json'), JSON.stringify({ version: 1, profiles: [], sources: [], evaluations: [], corrections: [], courses: [{ model: 'qwen2.5-coder:3b', digest: 'fixture-v1', courseId: 'coding', threshold: 80, updatedAt: now, results: [...['foundation', 'knowledge', 'guided'].map(stage => ({ id: randomUUID(), stage, completedAt: now, passed: true, score: 100, checks: [], evidence: [] })), original] }] }))
    const launch = () => electron.launch({ args: [join(directory, 'main.cjs')], env: { ...process.env, ATHENA_ACADEMY_FIXTURE_DIR: directory } })
    app = await launch()
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.getByText('66.67% · Failed')).toBeVisible()
    await page.locator('.ac-result').first().locator('> summary').click()
    await page.locator('.ac-check').first().locator('> summary').click()
    const reading = page.getByRole('article', { name: 'Code reading practice' })
    await expect(reading.getByRole('heading', { name: 'Original question / task' })).toBeVisible()
    await expect(reading.locator('pre').filter({ hasText: '2,5 (a string)' })).toBeVisible()
    await expect(reading.getByText(/Expected 2,5.*5,5/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('practical-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('practical-mobile.png'), fullPage: true })
    await reading.getByRole('button', { name: 'Retry failed exercise' }).click()
    await page.locator('.ac-result').first().locator('> summary').click()
    await expect(page.locator('.ac-result').first().getByText('100.00% · Passed')).toBeVisible()
    await expect(page.locator('.ac-result').first().getByText(/Practice retry/)).toBeVisible()
    await expect(page.locator('.ac-result').first().getByText(/Retained from a previous attempt/)).toHaveCount(2)
    expect(await page.evaluate(() => window.academyFixture.requests())).toBe(1)
    await page.getByRole('button', { name: 'Run practical exercise' }).click()
    await page.locator('.ac-result').first().locator('> summary').click()
    await expect(page.locator('.ac-result').first().getByText(/Practical training · full practice attempt/)).toBeVisible()
    await expect(page.locator('.ac-result').first().getByText('100.00% · Passed')).toBeVisible()
    expect(await page.evaluate(() => window.academyFixture.requests())).toBe(3)
    const saved = JSON.parse(await readFile(join(directory, 'academy.json'), 'utf8'))
    expect(saved.courses[0].results).toHaveLength(6)
    expect(saved.courses[0].results[3]).toMatchObject(original)
    expect(saved.courses[0].results[5].checks[1].execution).toMatchObject({ actualOutput: '5', expectedOutput: '5', durationMs: expect.any(Number) })
    expect(errors).toEqual([])
    await app.close(); app = await launch()
    const restored = await app.firstWindow()
    await restored.getByRole('button', { name: /Practical Training/ }).click()
    await expect(restored.locator('.ac-result')).toHaveCount(3)
    await restored.locator('.ac-result').first().locator('> summary').click()
    await expect(restored.locator('.ac-result').first().getByText('100.00% · Passed')).toBeVisible()
    await expect(restored.locator('.ac-result').last().locator('summary')).toContainText('66.67% · Failed')
  } finally { if (app) await app.close(); await rm(directory, { recursive: true, force: true }) }
})
