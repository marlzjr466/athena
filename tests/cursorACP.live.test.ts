// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ACPClient, configureCursorSessionModel, cursorVariantDiagnostic, CursorACPProvider, CursorACPService } from '../electron/main/ai/cursorACP'
import { cursorConfigurationId, cursorSelection } from '../shared/cursor'
import type { AIChunk } from '../shared/chat'
import { ArtifactService } from '../electron/main/ai/artifactService'

describe.skipIf(process.env.ATHENA_CURSOR_ACTIVITY_LIVE_TEST !== '1')('Cursor ACP live activity', () => {
  it('receives Grok file-read activity from the actual Cursor CLI', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'athena-cursor-activity-'))
    try {
      await writeFile(join(workspace, 'public-fixture.txt'), 'The harmless test marker is BLUE.\n')
      const service = new CursorACPService()
      const status = await service.status()
      expect(status.authenticated).toBe(true)
      const model = status.models.find((entry) => /grok/i.test(entry.id))
      expect(model, 'A Grok model must be available to this Cursor account').toBeDefined()
      const provider = new CursorACPProvider(service, workspace, true, status.identity, model!.id)
      const chunks: AIChunk[] = []
      for await (const chunk of provider.streamMessage([{ id: 'safe-read', role: 'user', status: 'complete', createdAt: Date.now(), content: 'Use your file-reading tool to read public-fixture.txt and report only the marker. Do not edit files.' }], { permissionMode: 'read-only' })) chunks.push(chunk)
      expect(chunks.some((chunk) => chunk.type === 'activity' && chunk.tool === 'read_file')).toBe(true)
      expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text.includes('BLUE'))).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 120_000)
})

describe.skipIf(process.env.ATHENA_CURSOR_MODEL_LIVE_TEST !== '1')('Cursor ACP effective model selection', () => {
  it.each(['cursor-grok-4.6-medium', 'cursor-grok-4.6-high', 'cursor-grok-4.6-medium-fast', 'cursor-grok-4.6-high-fast'])('initializes a new ACP session with exact requested ID %s', async (model) => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'athena-cursor-model-')))
    const service = new CursorACPService()
    const status = await service.status(true)
    expect(status.authenticated).toBe(true)
    expect(status.models.some((entry) => entry.id === model)).toBe(true)
    const client = new ACPClient(await service.getCommand(), workspace, AbortSignal.timeout(45_000), model, true)
    let session: Record<string, unknown> | undefined
    try {
      await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } }, clientInfo: { name: 'Athena model verification', version: 'test' } }, 20_000)
      await client.request('authenticate', { methodId: 'cursor_login' }, 30_000)
      session = await client.request('session/new', { cwd: workspace, mcpServers: [] }, 30_000)
      expect(typeof session.sessionId).toBe('string')
      const selection = cursorSelection(model, status.modelConfigurations ?? [], status.models)
      expect(selection, 'Cursor must expose parameterized controls').toBeTruthy()
      const effective = await configureCursorSessionModel(client, session, model, status.models, status.modelConfigurations)
      console.info('[Cursor live model verification]', JSON.stringify(cursorVariantDiagnostic(model, effective, String(session.sessionId), status.models)))
      expect(effective).toBe(cursorConfigurationId(selection!.model, selection!.values))
      // Prove an existing session can change context/effort/speed, and that
      // reopening a conversation can reapply its saved choice. Athena creates
      // a fresh ACP session per turn and supplies its persisted history.
      const next = 'grok-4.7[context=500k,reasoning_effort=medium,fast=false]'
      expect(await configureCursorSessionModel(client, session, next, status.models, status.modelConfigurations)).toBe(next)
      const reopened = await client.request('session/new', { cwd: workspace, mcpServers: [] }, 30_000)
      expect(await configureCursorSessionModel(client, reopened, model, status.models, status.modelConfigurations)).toBe(effective)
    } finally {
      // Use the supported API to restore the settings this no-prompt probe saw.
      if (session && Array.isArray(session.configOptions)) {
        for (const option of session.configOptions as Record<string, unknown>[]) {
          if (option.id === 'mode' || typeof option.id !== 'string' || typeof option.currentValue !== 'string') continue
          await client.request('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value: option.currentValue }, 5_000).catch(() => {})
        }
      }
      client.close()
      await rm(workspace, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.skipIf(process.env.ATHENA_CURSOR_CHAT_LIVE_TEST !== '1')('Cursor configured chat smoke test', () => {
  it('streams a response using the requested Medium/standard configuration', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'athena-cursor-config-chat-')))
    try {
      const service = new CursorACPService()
      const status = await service.status()
      const provider = new CursorACPProvider(service, workspace, true, status.identity, 'cursor-grok-4.6-medium')
      let text = ''
      for await (const chunk of provider.streamMessage([{
        id: 'configuration-smoke', role: 'user', status: 'complete', createdAt: Date.now(),
        content: 'Do not use tools or inspect files. Reply with exactly ATHENA_MODEL_OK.',
      }], { permissionMode: 'read-only', signal: AbortSignal.timeout(90_000) })) {
        if (chunk.type === 'text') text += chunk.text
      }
      expect(text).toContain('ATHENA_MODEL_OK')
      console.info('[Cursor configured chat smoke test]', JSON.stringify({ requestedModel: 'cursor-grok-4.6-medium', receivedExpectedResponse: true }))
    } finally { await rm(workspace, { recursive: true, force: true }) }
  }, 120_000)
  it('recovers a persisted model catalog missing ACP configurations before a real Medium response', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'athena-cursor-stale-config-')))
    try {
      const cache = join(workspace, 'cursor-status.json')
      const fresh = await new CursorACPService().status(true)
      expect(fresh.authenticated).toBe(true)
      expect(fresh.models.some((entry) => entry.id === 'cursor-grok-4.6-medium')).toBe(true)
      await writeFile(cache, JSON.stringify({ version: 1, savedAt: Date.now(), status: { ...fresh, modelConfigurations: [] } }))
      const service = new CursorACPService(undefined, undefined, undefined, cache)
      expect(service.cachedStatus().modelConfigurations).toEqual([])
      const provider = new CursorACPProvider(service, workspace, true, fresh.identity, 'cursor-grok-4.6-medium')
      let text = ''
      for await (const chunk of provider.streamMessage([{
        id: 'stale-catalog-smoke', role: 'user', status: 'complete', createdAt: Date.now(),
        content: 'Do not use tools or inspect files. Reply with exactly ATHENA_MODEL_OK.',
      }], { permissionMode: 'read-only', signal: AbortSignal.timeout(90_000) })) {
        if (chunk.type === 'text') text += chunk.text
      }
      expect(text).toContain('ATHENA_MODEL_OK')
      expect(service.cachedStatus().modelConfigurations?.length).toBeGreaterThan(0)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  }, 150_000)
})

describe.skipIf(process.env.ATHENA_CURSOR_IMAGE_LIVE_TEST !== '1')('Cursor ACP live image generation', () => {
  it('generates, previews, and saves one real image through the authorized handoff', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'athena-cursor-image-live-')))
    const artifacts = new ArtifactService(await mkdtemp(join(tmpdir(), 'athena-cursor-artifacts-live-')))
    const output = await artifacts.prepareProviderOutput(workspace, 'images')
    try {
      const service = new CursorACPService()
      const status = await service.status(true)
      expect(status.authenticated).toBe(true)
      const model = status.models.find((entry) => entry.id === 'grok-4.7-medium') ?? status.models.find((entry) => entry.id === 'cursor-grok-4.6-medium') ?? status.models.find((entry) => /grok-4\.7.*medium/i.test(entry.id)) ?? status.models.find((entry) => /grok/i.test(entry.id))
      expect(model, 'A Cursor Grok model must be available for the live image check').toBeDefined()
      const provider = new CursorACPProvider(service, workspace, false, status.identity, model!.id, async () => {}, undefined, output)
      const chunks: AIChunk[] = []
      let text = ''
      for await (const chunk of provider.streamMessage([{ id: 'live-image', role: 'user', status: 'complete', createdAt: Date.now(), content: 'Generate an actual image of a lush green nature landscape at sunset, with a river in the foreground and two mountains in the background. Use the Cursor generate_image extension and save it in the authorized .athena/outputs/images workspace. Do not merely describe an image.' }], { permissionMode: 'ask', signal: AbortSignal.timeout(180_000), requestApproval: async () => true, storeArtifact: input => artifacts.store(input.name, input.mimeType, input.bytes, { provider: input.provider }) })) { chunks.push(chunk); if (chunk.type === 'text') text += chunk.text }
      const artifactChunk = chunks.find((chunk): chunk is Extract<AIChunk, { type: 'artifact' }> => chunk.type === 'artifact')
      expect(artifactChunk, `Cursor returned no verified image artifact. Chunks: ${chunks.map((chunk) => chunk.type).join(', ')}\nResponse: ${text.slice(-2000)}`).toBeDefined()
      const artifact = artifactChunk!.artifact
      expect(artifact.status).toBe('ready')
      const preview = await artifacts.preview(artifact)
      expect(preview.preview).toMatch(/^data:image\//)
      const saved = await artifacts.read(artifact)
      expect(saved.byteLength).toBeGreaterThan(0)
      console.info('[Cursor live image verification]', JSON.stringify({ model: model!.id, artifact: artifact.name, bytes: saved.byteLength, previewReady: true }))
    } finally { await rm(workspace, { recursive: true, force: true }) }
  }, 240_000)
})

describe.skipIf(process.env.ATHENA_CURSOR_COMMAND_LIVE_TEST !== '1')('Cursor ACP live authorized commands', () => {
  it('runs commands and commits two explicit slices through the real Cursor MCP path', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'athena-cursor-command-live-')))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' })
    try {
      git('init', '-b', 'main')
      git('config', 'user.name', 'Athena Disposable Test')
      git('config', 'user.email', 'athena-test@example.invalid')
      await writeFile(join(workspace, 'baseline.txt'), 'baseline\n')
      git('add', '--', 'baseline.txt')
      git('commit', '-m', 'Baseline')
      await writeFile(join(workspace, 'slice-one.txt'), 'validated slice one\n')
      await writeFile(join(workspace, 'slice-two.txt'), 'validated slice two\n')
      await writeFile(join(workspace, 'unrelated.txt'), 'never stage this file\n')
      const service = new CursorACPService()
      const status = await service.status()
      expect(status.authenticated).toBe(true)
      const model = status.models.find((entry) => /grok/i.test(entry.id)) ?? status.models.find((entry) => entry.id === 'auto')
      expect(model).toBeDefined()
      const provider = new CursorACPProvider(service, workspace, false, status.identity, model!.id)
      const approvals: string[] = []
      let text = ''
      for await (const chunk of provider.streamMessage([{
        id: 'commands', role: 'user', status: 'complete', createdAt: Date.now(),
        content: 'In this disposable test repository, use the Athena run_command tool (not native Shell). Execute echo hello, git status --short, git log -1, and npm --version. Then validate slice-one.txt using node -e with fs.readFileSync and assert it contains "validated slice one"; only after success stage ONLY slice-one.txt and commit with message "Verified slice one". Similarly validate slice-two.txt contains "validated slice two", stage ONLY slice-two.txt and commit "Verified slice two". Do not stage unrelated.txt, baseline.txt or anything else. Do not change files. Report actual command results. These isolated test operations are approved through the client.',
      }], {
        permissionMode: 'ask', signal: AbortSignal.timeout(180_000),
        requestApproval: async (title, description) => {
          // Test-only approval limited to this disposable repository.
          if (!description.includes(workspace)) return false
          approvals.push(title)
          return true
        },
      })) if (chunk.type === 'text') text += chunk.text
      expect(text).toContain('hello')
      expect(approvals.filter((title) => title === 'Create reviewed Git commit'), `Disposable test response: ${text}\nApproval titles: ${approvals.join(', ')}`).toHaveLength(2)
      expect(approvals.filter((title) => title === 'Run isolated project command').length).toBeGreaterThanOrEqual(4)
      expect(git('log', '-2', '--format=%s')).toContain('Verified slice one')
      expect(git('log', '-1', '--format=%s')).toContain('Verified slice two')
      expect(git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('slice-two.txt')
      expect(git('show', '--format=', '--name-only', 'HEAD~1').trim()).toBe('slice-one.txt')
      expect(git('status', '--short')).toContain('?? unrelated.txt')
    } finally { await rm(workspace, { recursive: true, force: true }) }
  }, 200_000)
})
