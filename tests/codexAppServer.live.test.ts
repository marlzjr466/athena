// @vitest-environment node
/**
 * Opt-in account-backed smoke test. Run only on an installed, signed-in Codex
 * CLI with ATHENA_CODEX_LIVE_TEST=1; normal test suites never spend usage.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../shared/chat'
import { CodexAppServerProvider } from '../electron/main/ai/CodexAppServerProvider'
import { CodexCLIService } from '../electron/main/ai/codexCLIService'

const enabled = process.env.ATHENA_CODEX_LIVE_TEST === '1'
let fixtureRoot: string | undefined

describe.skipIf(!enabled)('Codex app-server live smoke test', () => {
  afterAll(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }) })

  it('streams a short coding turn and completes a bounded temporary-fixture edit through an Athena tool', async () => {
    const service = new CodexCLIService('live-test')
    const status = await service.status(true)
    expect(status.authenticated, status.message).toBe(true)
    expect(status.defaultModel, 'Codex app-server did not supply an authoritative default model').toBeTruthy()
    const model = status.defaultModel!
    fixtureRoot = await mkdtemp(join(tmpdir(), 'athena-codex-fixture-'))
    const fixturePath = join(fixtureRoot, 'fixture.txt')
    await writeFile(fixturePath, 'const target = 1\n', { encoding: 'utf8', mode: 0o600 })
    const definitions = [
      { name: 'read_fixture', description: 'Read the single temporary fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
      { name: 'edit_fixture', description: 'Replace the exact provided text in the single temporary fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false } },
    ]
    const assertFixture = (input: unknown) => {
      const path = input && typeof input === 'object' ? (input as Record<string, unknown>).path : undefined
      if (typeof path !== 'string' || isAbsolute(path) || resolve(fixtureRoot!, path) !== fixturePath) throw new Error('Only fixture.txt inside the temporary test root is authorized.')
    }
    const context = { attachments: [], repositoryText: '', sources: [], projectTools: {
      definitions,
      maxCalls: 2,
      assertAccess: () => {},
      execute: async (name: string, input: unknown) => {
        assertFixture(input)
        const values = input as Record<string, unknown>
        if (name === 'read_fixture') return readFile(fixturePath, 'utf8')
        if (name === 'edit_fixture') {
          const current = await readFile(fixturePath, 'utf8')
          const oldText = String(values.old_text ?? '')
          if (!oldText || current.split(oldText).length !== 2) throw new Error('Expected text was not unique in the fixture.')
          await writeFile(fixturePath, current.replace(oldText, String(values.new_text ?? '')), 'utf8')
          return 'Edited fixture.txt; no other file is available.'
        }
        throw new Error('Tool not available.')
      },
    } }
    const provider = new CodexAppServerProvider(service, model, status.identity ?? undefined)
    const messages: ChatMessage[] = [{ id: 'live-user', role: 'user', status: 'complete', createdAt: Date.now(), content: 'In this temporary test only, use read_fixture on fixture.txt first. Then use edit_fixture exactly once to replace `const target = 1` with `const target = 2`. Do not call any other tool. After both tools finish, respond with the single word complete.' }]
    let response = ''
    for await (const chunk of provider.streamMessage(messages, { context, effort: 'auto' })) {
      if (chunk.type === 'text') response += chunk.text
    }
    expect(response.trim().toLowerCase()).toContain('complete')
    expect(await readFile(fixturePath, 'utf8')).toBe('const target = 2\n')
  }, 180_000)
})
