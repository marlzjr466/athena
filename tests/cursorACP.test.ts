import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyACPMessage, cursorActivityChunk, cursorEffectiveModel, cursorVariantDiagnostic, CursorACPProvider, CursorACPService, cursorACPArguments, parseCursorModels } from '../electron/main/ai/cursorACP'
import { cursorCatalogModelFromEffective, cursorEffectiveSelectionMatches, cursorModelDisplayLabel, cursorModelEffortOptions, cursorModelFastPairAvailable, cursorModelVariantId, cursorReportedModelVariant, cursorSelectableModels, defaultCursorModel, groupCursorModels, resolveCursorModel, type CursorStatus } from '../shared/cursor'

describe('Cursor model variants', () => {
  const variants = [
    { id: 'cursor-grok-4.6-medium', label: 'Grok 4.6 Medium' },
    { id: 'cursor-grok-4.6-medium-fast', label: 'Grok 4.6 Medium Fast' },
    { id: 'cursor-grok-4.6-high', label: 'Grok 4.6' },
    { id: 'cursor-grok-4.6-high-fast', label: 'Grok 4.6 Fast' },
  ]
  it('keeps effort and Fast modes encoded in exact installed model IDs', () => {
    expect(cursorModelDisplayLabel(variants[0])).toBe('Grok 4.6 · Medium')
    expect(cursorModelDisplayLabel(variants[3])).toBe('Grok 4.6 · High · Fast')
    expect(cursorModelEffortOptions(variants, variants[0].id)).toEqual(['medium', 'high'])
    expect(cursorModelFastPairAvailable(variants, variants[0].id)).toBe(true)
    expect(cursorModelVariantId(variants, variants[0].id, 'high', false)).toBe('cursor-grok-4.6-high')
    expect(cursorModelVariantId(variants, variants[0].id, 'high', true)).toBe('cursor-grok-4.6-high-fast')
    expect(cursorModelVariantId(variants, variants[0].id, 'xhigh', false)).toBeNull()
  })
  it('extracts explicit active-model fields and produces credential-free diagnostics', () => {
    expect(cursorEffectiveModel({ models: { currentModelId: 'cursor-grok-4.6-medium' }, sessionId: 'session-1' })).toBe('cursor-grok-4.6-medium')
    expect(cursorEffectiveModel({ models: { availableModels: [{ modelId: 'cursor-grok-4.6-high' }] } })).toBeNull()
    expect(cursorEffectiveModel({ configOptions: [{ id: 'model', currentValue: 'cursor-grok-4.6-medium-fast' }] })).toBe('cursor-grok-4.6-medium-fast')
    expect(cursorVariantDiagnostic('cursor-grok-4.6-medium', null, 'safe-session')).toEqual({
      requestedModel: 'cursor-grok-4.6-medium', cliArgs: ['--workspace', '<authorized-workspace>', '--model', 'cursor-grok-4.6-medium', 'acp'],
      effectiveModel: 'not-reported-by-ACP', effectiveModelCatalogId: 'not-reported-by-ACP', effort: 'medium', speedTier: 'standard',
      effectiveEffort: 'not-resolved', effectiveSpeedTier: 'not-resolved', sessionId: 'safe-session',
    })
  })

  it('normalizes Cursor ACP variant strings to exact CLI IDs and detects overrides', () => {
    expect(cursorCatalogModelFromEffective('grok-4.6[effort=medium,fast=false]', variants)).toBe(variants[0].id)
    expect(cursorCatalogModelFromEffective('grok-4.6[effort=high,fast=true]', variants)).toBe(variants[3].id)
    expect(cursorEffectiveSelectionMatches(variants[0].id, 'grok-4.6[effort=medium,fast=false]', variants)).toBe(true)
    expect(cursorEffectiveSelectionMatches(variants[0].id, 'grok-4.6[effort=high,fast=true]', variants)).toBe(false)
    expect(cursorEffectiveSelectionMatches(variants[3].id, 'grok-4.6[effort=high,fast=true]', variants)).toBe(true)
    expect(cursorCatalogModelFromEffective('grok-4.6[effort=high]', variants)).toBeNull()
    expect(cursorEffectiveSelectionMatches(variants[0].id, null, variants)).toBe(false)
    expect(cursorReportedModelVariant('grok-4.6[effort=high,fast=true]')).toEqual({ baseId: 'grok-4.6', effort: 'high', fast: true })
    expect(cursorVariantDiagnostic(variants[0].id, 'grok-4.6[effort=high,fast=true]', 'safe-session', variants)).toMatchObject({
      requestedModel: variants[0].id, effectiveModelCatalogId: variants[3].id, effort: 'medium', speedTier: 'standard',
      effectiveEffort: 'high', effectiveSpeedTier: 'fast',
    })
  })

  it('does not send a prompt when ACP overrides the requested model', async () => {
    const model = 'cursor-grok-4.6-medium'
    const service = new CursorACPService(async (_command, args) => {
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') return { stdout: 'Logged in as athena@example.test', stderr: '' }
      if (args[0] === 'models') return { stdout: 'cursor-grok-4.6-medium - Grok 4.6 Medium\ncursor-grok-4.6-high-fast - Grok 4.6 High Fast', stderr: '' }
      throw new Error('Unexpected Cursor command')
    }, async () => '/mock/agent')
    const methods: string[] = []
    const provider = new CursorACPProvider(service, '/authorized/project', true, 'athena@example.test', model, async () => {}, () => ({
      request: async (method) => {
        methods.push(method)
        if (method === 'session/new') return { sessionId: 'safe-session', models: { currentModelId: 'grok-4.6[effort=high,fast=true]' } }
        return {}
      },
      notify: async () => {}, respond: () => {}, respondError: () => {}, close: () => {},
    }))

    await expect(async () => {
      for await (const _chunk of provider.streamMessage([{ id: 'm1', role: 'user', status: 'complete', createdAt: 1, content: 'Do not send this prompt.' }])) { /* no output expected */ }
    }).rejects.toThrow(/No prompt was sent/)
    expect(methods).toContain('session/new')
    expect(methods).not.toContain('session/prompt')
  })

  it('recovers a missing cached ACP configuration before prompting with the exact selected variant', async () => {
    const service = new CursorACPService(async (_command, args) => {
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') return { stdout: 'Logged in as athena@example.test', stderr: '' }
      if (args[0] === 'models') return { stdout: 'cursor-grok-4.6-medium - Grok 4.6 Medium\ncursor-grok-4.6-high-fast - Grok 4.6 High Fast', stderr: '' }
      throw new Error('Unexpected Cursor command')
    }, async () => '/mock/agent', async () => [])
    expect((await service.status()).modelConfigurations).toEqual([])
    let base = 'grok-4.6'
    let effort = 'high'
    let fast = 'true'
    const methods: string[] = []
    const snapshot = () => ({ sessionId: 'configured-session', configOptions: [
      { id: 'model', category: 'model', currentValue: base, options: [{ value: 'grok-4.6', name: 'Grok 4.6' }] },
      { id: 'effort', category: 'thought_level', currentValue: effort, options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
      { id: 'fast', currentValue: fast, options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
    ] })
    let connection: any
    const provider = new CursorACPProvider(service, '/authorized/project', true, 'athena@example.test', 'cursor-grok-4.6-medium', async () => {}, () => connection = {
      onNotification: undefined,
      request: async (method: string, params?: Record<string, unknown>) => {
        methods.push(method)
        if (method === 'cursor/list_available_models') return { models: [{ value: 'grok-4.6', name: 'Grok 4.6', configOptions: [
          { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
          { id: 'fast', name: 'Fast', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
        ] }] }
        if (method === 'session/new') return snapshot()
        if (method === 'session/set_config_option') {
          if (params?.configId === 'model') { base = String(params.value); effort = 'high'; fast = 'true' }
          if (params?.configId === 'effort') effort = String(params.value)
          if (params?.configId === 'fast') fast = String(params.value)
          return snapshot()
        }
        if (method === 'session/prompt') {
          expect(snapshot().configOptions.map((option) => option.currentValue)).toEqual(['grok-4.6', 'medium', 'false'])
          queueMicrotask(() => connection.onNotification?.({ method: 'session/update', params: { sessionId: 'configured-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello.' } } } }))
          return { stopReason: 'end_turn' }
        }
        return {}
      },
      notify: async () => {}, respond: () => {}, respondError: () => {}, close: () => {},
    })
    const chunks = []
    for await (const chunk of provider.streamMessage([{ id: 'm1', role: 'user', status: 'complete', createdAt: 1, content: 'Hello.' }])) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(methods.indexOf('cursor/list_available_models')).toBeLessThan(methods.indexOf('session/prompt'))
    expect(service.cachedStatus().modelConfigurations).toHaveLength(1)
  })
})

describe('Cursor ACP JSON-RPC routing', () => {
  it('persists ACP imageData even when Cursor suggests a provider-owned path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'athena-cursor-image-'))
    const service = new CursorACPService(async (_command, args) => {
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') return { stdout: 'Logged in as athena@example.test', stderr: '' }
      if (args[0] === 'models') return { stdout: 'cursor-grok-4.6-medium - Grok 4.6 Medium', stderr: '' }
      throw new Error('Unexpected Cursor command')
    }, async () => '/mock/agent')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    let connection: any
    connection = {
      onNotification: undefined,
      request: async (method: string) => {
        if (method === 'session/new') return { sessionId: 'image-session', models: { currentModelId: 'cursor-grok-4.6-medium' } }
        if (method === 'session/prompt') {
          queueMicrotask(() => connection.onNotification?.({ method: 'cursor/generate_image', params: { filePath: '/tmp/cursor-owned.png', imageData: `data:image/png;base64,${png.toString('base64')}` } }))
          return { stopReason: 'end_turn' }
        }
        return {}
      },
      notify: async () => {}, respond: () => {}, respondError: () => {}, close: () => {},
    }
    const stored: unknown[] = []
    const provider = new CursorACPProvider(service, cwd, true, 'athena@example.test', 'cursor-grok-4.6-medium', async () => {}, () => connection, join(cwd, '.athena', 'outputs', 'images'))
    const chunks = []
    for await (const chunk of provider.streamMessage([{ id: 'm1', role: 'user', status: 'complete', createdAt: 1, content: 'Generate an image.' }], { storeArtifact: async (input) => { stored.push(input); return { id: 'artifact-id', name: input.name, mimeType: input.mimeType, size: input.bytes.byteLength, createdAt: 1, storageKey: 'artifact-id.png', status: 'ready' } } })) chunks.push(chunk)
    expect(stored).toHaveLength(1)
    expect(chunks.some((chunk) => chunk.type === 'artifact')).toBe(true)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  it('fails instead of reporting success when Cursor returns an unauthorized path without imageData', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'athena-cursor-image-failure-'))
    const service = new CursorACPService(async (_command, args) => {
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') return { stdout: 'Logged in as athena@example.test', stderr: '' }
      if (args[0] === 'models') return { stdout: 'cursor-grok-4.6-medium - Grok 4.6 Medium', stderr: '' }
      throw new Error('Unexpected Cursor command')
    }, async () => '/mock/agent')
    let connection: any
    connection = {
      onNotification: undefined,
      request: async (method: string) => {
        if (method === 'session/new') return { sessionId: 'failed-image-session', models: { currentModelId: 'cursor-grok-4.6-medium' } }
        if (method === 'session/prompt') {
          queueMicrotask(() => connection.onNotification?.({ method: 'cursor/generate_image', params: { filePath: '/tmp/cursor-owned.png' } }))
          return { stopReason: 'end_turn' }
        }
        return {}
      },
      notify: async () => {}, respond: () => {}, respondError: () => {}, close: () => {},
    }
    const provider = new CursorACPProvider(service, cwd, true, 'athena@example.test', 'cursor-grok-4.6-medium', async () => {}, () => connection, join(cwd, '.athena', 'outputs', 'images'))
    await expect(async () => { for await (const _chunk of provider.streamMessage([{ id: 'm1', role: 'user', status: 'complete', createdAt: 1, content: 'Generate an image.' }], { storeArtifact: async () => { throw new Error('should not store') } })) {} }).rejects.toThrow(/authorized project output workspace|verified artifact|image output file was not found/i)
  })

  it('routes permission requests with IDs to the server-request handler, not response waiters', () => {
    expect(classifyACPMessage({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { toolCall: {} } })).toBe('server-request')
    expect(classifyACPMessage({ jsonrpc: '2.0', id: 8, method: 'cursor/ask_question', params: {} })).toBe('server-request')
  })
  it('distinguishes notifications, responses, and malformed envelopes', () => {
    expect(classifyACPMessage({ jsonrpc: '2.0', method: 'session/update', params: {} })).toBe('notification')
    expect(classifyACPMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })).toBe('response')
    expect(classifyACPMessage({ jsonrpc: '2.0', method: 'session/update', id: 4, result: {} })).toBe('server-request')
    expect(classifyACPMessage({ jsonrpc: '2.0' })).toBe('invalid')
  })
})

describe('Cursor ACP activity updates', () => {
  it('keeps one stable activity through start, completion, and failure updates', () => {
    const started = cursorActivityChunk({ sessionUpdate: 'tool_call', toolCallId: 'call-1', kind: 'read', title: 'Read src/App.tsx', status: 'in_progress' })!
    const completed = cursorActivityChunk({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }, started)!
    const failed = cursorActivityChunk({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' }, started)!
    expect(started).toMatchObject({ tool: 'read_file', label: 'Read src/App.tsx', status: 'running' })
    expect(completed).toMatchObject({ id: started.id, tool: 'read_file', label: 'Read src/App.tsx', status: 'complete' })
    expect(failed).toMatchObject({ id: started.id, status: 'error' })
    expect(cursorActivityChunk({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' }, completed)?.status).toBe('complete')
  })

  it('accepts an update without a preceding start while omitting private reasoning and raw secrets', () => {
    expect(cursorActivityChunk({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-2', kind: 'edit', title: 'Edit src/App.tsx', status: 'completed' })).toMatchObject({ tool: 'edit_file', status: 'complete' })
    expect(cursorActivityChunk({ sessionUpdate: 'tool_call', toolCallId: 'thought', kind: 'think', title: 'private reasoning' })).toBeNull()
    expect(cursorActivityChunk({ sessionUpdate: 'tool_call', toolCallId: 'run-1', kind: 'execute', title: 'Run with API_KEY=super-secret', rawInput: { token: 'super-secret' }, rawOutput: 'super-secret' })).toMatchObject({ tool: 'execute_command', label: 'Ran command' })
  })
})

describe('Cursor CLI model discovery', () => {
  const availableStatus: CursorStatus = { installed: true, authenticated: true, identity: 'athena@example.test', version: '2026.10.01', message: '', models: [{ id: 'auto', label: 'Auto' }, { id: 'model-z', label: 'Model Z' }], modelCatalogAvailable: true }

  it('parses account model IDs and labels from structured CLI output', () => {
    expect(parseCursorModels(JSON.stringify({ models: [{ id: 'auto', name: 'Auto' }, { id: 'claude-5-sonnet', displayName: 'Claude Sonnet' }] }))).toEqual([
      { id: 'auto', label: 'Auto' }, { id: 'claude-5-sonnet', label: 'Claude Sonnet' },
    ])
  })

  it('parses plain and table-style output without inventing models', () => {
    expect(parseCursorModels('Available models:\n  auto\n  claude-5-sonnet\n  gpt-5.6-sol')) .toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'claude-5-sonnet', label: 'Claude 5 Sonnet' },
      { id: 'gpt-5.6-sol', label: 'Gpt 5.6 Sol' },
    ])
    expect(parseCursorModels('Authentication required')).toEqual([])
    expect(parseCursorModels('Available models:\n  GPT-5.6 Sol High Fast\n  Kimi K2')).toEqual([
      { id: 'GPT-5.6 Sol High Fast', label: 'GPT-5.6 Sol High Fast' },
      { id: 'Kimi K2', label: 'Kimi K2' },
    ])
  })

  it('parses the signed-in CLI id/label format, default marker, and footer as exact IDs', () => {
    const models = parseCursorModels('Available models\n\nauto - Auto (default)\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\ncursor-grok-4.6-high - Grok 4.6\nkimi-k3-high - Kimi K3 High\nclaude-opus-5 - Claude Opus 5\n\nTip: use --model <id> to switch.')
    expect(models).toEqual([
      { id: 'auto', label: 'Auto', isDefault: true },
      { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol 1M High' },
      { id: 'cursor-grok-4.6-high', label: 'Grok 4.6' },
      { id: 'kimi-k3-high', label: 'Kimi K3 High' },
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
    ])
    expect(groupCursorModels(models).map((group) => group.name)).toEqual(['Auto', 'GPT', 'Grok', 'Kimi', 'Claude'])
    expect(defaultCursorModel({ ...availableStatus, models })).toBeNull()
  })

  it('passes a selected model through Cursor’s documented global --model flag', () => {
    expect(cursorACPArguments('auto', '/authorized/project')).toEqual(['--workspace', '/authorized/project', '--model', 'auto', 'acp'])
    expect(cursorACPArguments('claude-5-sonnet', '/authorized/project')).toEqual(['--workspace', '/authorized/project', '--model', 'claude-5-sonnet', 'acp'])
    expect(cursorACPArguments('GPT-5.6 Sol High Fast', '/authorized/project')).toEqual(['--workspace', '/authorized/project', '--model', 'GPT-5.6 Sol High Fast', 'acp'])
    expect(cursorACPArguments('cursor-managed', '/athena/private-chat')).toEqual(['--workspace', '/athena/private-chat', 'acp'])
  })

  it('preserves a saved Auto choice but requires a model for new conversations without a non-Auto default', () => {
    const grokKimi = { ...availableStatus, models: [{ id: 'grok-4.7-high', label: 'Grok 4.7 High' }, { id: 'kimi-k2', label: 'Kimi K2' }, ...availableStatus.models] }
    expect(cursorSelectableModels(grokKimi.models).map((model) => model.id)).toEqual(['grok-4.7-high', 'kimi-k2', 'auto', 'model-z'])
    expect(groupCursorModels(grokKimi.models).map((family) => family.name)).toEqual(['Grok', 'Kimi', 'Auto', 'Model'])
    expect(resolveCursorModel(grokKimi, 'kimi-k2')).toBe('kimi-k2')
    expect(resolveCursorModel(grokKimi, 'auto')).toBe('auto')
    expect(resolveCursorModel(grokKimi, 'removed-model')).toBeNull()
    expect(resolveCursorModel(grokKimi, null)).toBeNull()
    expect(resolveCursorModel({ ...availableStatus, modelCatalogAvailable: false, models: [{ id: 'cursor-managed', label: 'Cursor-managed default' }] }, 'model-z')).toBe('model-z')
    expect(defaultCursorModel({ ...availableStatus, models: [{ id: 'model-z', label: 'Model Z' }] })).toBeNull()
  })

  it('uses complete provider release metadata when available, without sorting model names', () => {
    const models = parseCursorModels(JSON.stringify({ models: [
      { id: 'zeta', displayName: 'Zeta', family: 'Custom', releasedAt: '2026-01-01', recommended: true },
      { id: 'alpha', displayName: 'Alpha', family: 'Custom', releasedAt: '2026-09-01' },
    ] }))
    expect(models[0]).toMatchObject({ family: 'Custom', releasedAt: '2026-01-01', recommended: true })
    expect(defaultCursorModel({ ...availableStatus, models })).toBe('alpha')
  })

  it('loads and caches models only after official CLI authentication, then refreshes on request', async () => {
    let catalog = 'Available models:\n  auto\n  cursor-coder'
    const calls: string[][] = []
    const service = new CursorACPService(async (_command, args) => {
      calls.push(args)
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') return { stdout: 'Logged in as athena@example.test', stderr: '' }
      if (args[0] === 'models') return { stdout: catalog, stderr: '' }
      throw new Error('Unexpected CLI call')
    }, async () => '/mock/agent')

    const first = await service.status()
    expect(first).toMatchObject({ authenticated: true, identity: 'athena@example.test', modelCatalogAvailable: true })
    expect(first.models.map(({ id }) => id)).toEqual(['auto', 'cursor-coder'])
    const modelCalls = calls.filter(([arg]) => arg === 'models').length
    const statusCalls = calls.filter(([arg]) => arg === 'status').length
    await service.status()
    expect(calls.filter(([arg]) => arg === 'models')).toHaveLength(modelCalls)
    expect(calls.filter(([arg]) => arg === 'status')).toHaveLength(statusCalls)
    await service.status(false, true)
    expect(calls.filter(([arg]) => arg === 'status')).toHaveLength(statusCalls + 1)
    expect(calls.filter(([arg]) => arg === 'models')).toHaveLength(modelCalls)

    catalog = 'Available models:\n  auto\n  cursor-coder\n  new-model'
    const refreshed = await service.status(true)
    expect(refreshed.models.map(({ id }) => id)).toEqual(['auto', 'cursor-coder', 'new-model'])
  })

  it('does not query or invent models before the user signs in', async () => {
    const calls: string[][] = []
    const service = new CursorACPService(async (_command, args) => {
      calls.push(args)
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      return { stdout: 'Not logged in', stderr: '' }
    }, async () => '/mock/agent')
    const status = await service.status()
    expect(status).toMatchObject({ authenticated: false, models: [], modelCatalogAvailable: false })
    expect(calls.some(([arg]) => arg === 'models')).toBe(false)
  })

  it('does not turn a transient or unrecognized status response into a false sign-out', async () => {
    const service = new CursorACPService(async (_command, args) => {
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') throw Object.assign(new Error('temporary CLI status failure'), { stdout: '', stderr: '' })
      throw new Error('Unexpected Cursor command')
    }, async () => '/mock/agent')
    const status = await service.status()
    expect(status).toMatchObject({ installed: true, authenticated: false, authenticationStatus: 'unknown' })
    expect(status.message).toMatch(/could not be verified/i)
    expect(status.message).not.toMatch(/not signed in/i)
  })

  it('reads cached status without discovering or starting Cursor, including after a failed check', async () => {
    const find = vi.fn(async () => '/mock/agent')
    const run = vi.fn(async () => { throw new Error('Unavailable') })
    const service = new CursorACPService(run, find)
    expect(service.cachedStatus().authenticationStatus).toBe('unknown')
    expect(find).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    const failed = await service.status()
    const calls = run.mock.calls.length
    expect(service.cachedStatus()).toEqual(failed)
    expect(await service.status()).toEqual(failed)
    expect(run).toHaveBeenCalledTimes(calls)
  })

  it('restores a non-secret verified profile hint after an app restart and revalidates it before use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-cursor-status-'))
    const persistencePath = join(root, 'cursor-cli-status.json')
    const signedIn = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') return { stdout: 'Logged in as athena@example.test', stderr: '' }
      if (args[0] === 'models') return { stdout: 'auto - Auto', stderr: '' }
      throw new Error('Unexpected CLI call')
    })
    const first = new CursorACPService(signedIn, async () => '/mock/agent', undefined, persistencePath)
    expect((await first.status()).authenticated).toBe(true)

    const restartedCalls = vi.fn(async (_command: string, _args: string[]) => { throw new Error('CLI should not be needed for cached status') })
    const restarted = new CursorACPService(restartedCalls, async () => '/mock/agent', undefined, persistencePath)
    expect(restarted.cachedStatus()).toMatchObject({ authenticated: true, identity: 'athena@example.test' })
    expect((await restarted.status()).authenticated).toBe(true)
    expect(restartedCalls).not.toHaveBeenCalled()

    const signedOut = vi.fn(async (_command: string, args: string[]) => args[0] === '--version'
      ? { stdout: '2026.10.01', stderr: '' }
      : { stdout: 'Not logged in', stderr: '' })
    const live = new CursorACPService(signedOut, async () => '/mock/agent', undefined, persistencePath)
    expect((await live.status(false, true)).authenticated).toBe(false)
  })

  it('allows the account lookup to finish after eight seconds and reports timeouts accurately', async () => {
    const service = new CursorACPService(async (_command, args, options) => {
      expect(options.cwd).toBeTruthy()
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      expect(options.timeout).toBeGreaterThanOrEqual(30_000)
      throw Object.assign(new Error('timed out'), { killed: true })
    }, async () => '/mock/agent')
    expect(await service.status()).toMatchObject({ authenticationStatus: 'unknown', message: expect.stringContaining('timed out') })
  })

  it('uses the official browser login command and verifies the resulting CLI account', async () => {
    let signedIn = false
    const calls: string[] = []
    const service = new CursorACPService(async (_command, args) => {
      calls.push(args[0])
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') return { stdout: signedIn ? 'Logged in as athena@example.test' : 'Not logged in', stderr: '' }
      if (args[0] === 'login') { signedIn = true; return { stdout: '', stderr: '' } }
      if (args[0] === 'models') return { stdout: 'auto - Auto', stderr: '' }
      throw new Error('Unexpected command')
    }, async () => '/mock/agent')
    expect(await service.login()).toMatchObject({ authenticated: true, identity: 'athena@example.test' })
    expect(calls).toContain('login')
    expect(service.cachedStatus().authenticated).toBe(true)
  })

  it('rediscovers a CLI installed after the initial status check', async () => {
    const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValue('/mock/agent')
    const service = new CursorACPService(async () => ({ stdout: 'Not logged in', stderr: '' }), find)
    expect((await service.status()).installed).toBe(false)
    expect((await service.status(true)).installed).toBe(true)
  })

  it('does not accept a partial login or failed status command as authenticated', async () => {
    for (const failed of [false, true]) {
      const service = new CursorACPService(async (_command, args) => {
        if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
        if (failed) throw Object.assign(new Error('failed'), { stderr: 'Account: unavailable' })
        return { stdout: 'Partially authenticated (missing refresh token)', stderr: '' }
      }, async () => '/mock/agent')
      expect((await service.status()).authenticated).toBe(false)
    }
  })

  it('keeps an app-session verification across time and transient explicit refresh failures', async () => {
    let failStatus = false
    let statusCalls = 0
    const service = new CursorACPService(async (_command, args) => {
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') {
        statusCalls++
        if (failStatus) throw Object.assign(new Error('temporary CLI status failure'), { stdout: '', stderr: '' })
        return { stdout: 'Logged in as athena@example.test', stderr: '' }
      }
      if (args[0] === 'models') return { stdout: 'auto - Auto', stderr: '' }
      throw new Error('Unexpected Cursor command')
    }, async () => '/mock/agent')
    expect((await service.status()).authenticated).toBe(true)
    failStatus = true
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000)
    try {
      expect((await service.status()).authenticated).toBe(true)
      expect(statusCalls).toBe(1)
      const status = await service.status(true)
      expect(statusCalls).toBe(2)
      expect(status).toMatchObject({ authenticated: true, authenticationStatus: 'authenticated', identity: 'athena@example.test' })
      expect(status.message).toMatch(/verified earlier in this app run/i)
    } finally { clock.mockRestore() }
  })

  it('uses ACP authentication to confirm an inconclusive CLI status before prompting', async () => {
    const service = new CursorACPService(async (_command, args) => {
      if (args[0] === '--version') return { stdout: '2026.10.01', stderr: '' }
      if (args[0] === 'status') throw Object.assign(new Error('temporary CLI status failure'), { stdout: '', stderr: '' })
      throw new Error('Unexpected Cursor command')
    }, async () => '/mock/agent')
    const methods: string[] = []
    let client: { onNotification?: (message: { method?: string; params?: Record<string, unknown> }) => void; request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> }
    client = {
      onNotification: undefined,
      request: async (method) => {
        methods.push(method)
        if (method === 'session/new') return { sessionId: 'safe-session' }
        if (method === 'session/prompt') {
          client.onNotification?.({ method: 'session/update', params: { sessionId: 'safe-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Authenticated by ACP.' } } } })
          return { stopReason: 'end_turn' }
        }
        return {}
      },
    }
    const provider = new CursorACPProvider(service, '/authorized/project', true, null, null, async () => {}, () => ({
      request: client.request, notify: async () => {}, respond: () => {}, respondError: () => {}, close: () => {},
      get onNotification() { return client.onNotification }, set onNotification(value) { client.onNotification = value },
    }))
    const output: string[] = []
    for await (const chunk of provider.streamMessage([{ id: 'm1', role: 'user', status: 'complete', createdAt: 1, content: 'Hello' }])) if (chunk.type === 'text') output.push(chunk.text)
    expect(methods).toContain('authenticate')
    expect(methods).toContain('session/prompt')
    expect(output.join('')).toContain('Authenticated by ACP.')
  })
})
