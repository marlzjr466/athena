import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0-test' }, shell: { openPath: vi.fn(async () => '') } }))

import { AntigravityProvider } from '../electron/main/ai/AntigravityProvider'
import { AntigravityACPClient, AntigravityACPService, antigravityEnvironment, antigravityMeaningfulACPUpdate, parseAntigravityModelEffortDefaults, parseAntigravityModelEfforts, parseAntigravityModels, parseAntigravityUsageData } from '../electron/main/ai/antigravityACP'
import type { ChatMessage } from '../shared/chat'

const messages: ChatMessage[] = [{ id: 'user-1', role: 'user', status: 'complete', createdAt: 1, content: 'Hello' }]
// Sanitized fixture of the models advertised by the current authenticated ACP catalog.
const accountModels = parseAntigravityModels([{ id: 'model', options: [
  { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
] }])

function providerHarness(model = 'gemini-3-pro', cwd = '/authorized/workspace') {
  const client = {
    onMessage: undefined as ((message: any) => void) | undefined,
    request: vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: model, options: [{ value: model, name: 'Gemini 3 Pro' }] }] }
      if (method === 'session/prompt') {
        queueMicrotask(() => {
          client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello from Gemini.' } } } })
        })
        return {}
      }
      return {}
    }),
    respond: vi.fn(),
    notify: vi.fn(),
    close: vi.fn(async () => {}),
  }
  const service = {
    acquireRequest: vi.fn(() => vi.fn()),
    scheduleUsageRefreshAfterTurn: vi.fn(),
    connect: vi.fn(async () => ({ client: client as unknown as AntigravityACPClient, sessionId: 'session-1', models: [{ id: model, name: 'Gemini 3 Pro' }], configOptions: [{ id: 'model', currentValue: model, options: [{ value: model, name: 'Gemini 3 Pro' }] }] })),
    observeModelConfiguration: vi.fn(),
    effortSettingCached: vi.fn(() => undefined),
    supportsEffortCached: vi.fn(() => false),
    status: vi.fn(async () => ({ authState: 'authenticated' })),
  } as unknown as AntigravityACPService
  return { provider: new AntigravityProvider(service, cwd, model), client, service }
}

describe('official Google Antigravity ACP integration', () => {
  beforeEach(() => vi.clearAllMocks())

  it.runIf(process.env.ATHENA_ANTIGRAVITY_LIVE_TEST === '1')('opens a real sandboxed ACP session in the selected project with the existing account', async () => {
    const cwd = process.env.ATHENA_ANTIGRAVITY_PROJECT
    if (!cwd) throw new Error('Set ATHENA_ANTIGRAVITY_PROJECT to the authorized test project.')
    const userData = await mkdtemp(join(tmpdir(), 'athena-antigravity-live-'))
    const service = new AntigravityACPService(userData)
    const signal = AbortSignal.timeout(90_000)
    try {
      const { client, sessionId, models } = await service.connect(cwd, signal, 'live-acp-session')
      try {
        expect(sessionId).toBeTruthy()
        expect(models.length).toBeGreaterThan(0)
      } finally {
        await client.request('session/close', { sessionId }, 10_000).catch(() => {})
        await client.close()
      }
      for (const mode of ['full-access', 'advanced', 'ask', 'workspace-auto'] as const) {
        const provider = new AntigravityProvider(service, cwd, models[0].id, async () => {}, true)
        const chunks = []
        for await (const chunk of provider.streamMessage([{ id: `live-${mode}`, role: 'user', content: 'Reply with the single word READY. Do not use tools or modify files.', status: 'complete', createdAt: Date.now() }], { permissionMode: mode, signal, requestApproval: async () => false })) chunks.push(chunk)
        expect(chunks.at(-1), mode).toEqual({ type: 'done' })
        expect(chunks.some(chunk => chunk.type === 'text' && chunk.text.trim()), mode).toBe(true)
      }
    } finally { await rm(userData, { recursive: true, force: true }) }
  }, 100_000)

  it('round-trips a string permission request ID through ACP stdio', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'athena-acp-permission-'))
    const command = join(cwd, 'mock-acp')
    await writeFile(command, `#!/usr/bin/env node
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
let promptId
lines.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'session/prompt') {
    promptId = message.id
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'permission-read-1', method: 'session/request_permission', params: { sessionId: 'session-1', options: [{ optionId: 'allow', kind: 'allow_once' }] } }) + '\\n')
  } else if (message.id === 'permission-read-1') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', permitted: message.result.outcome.optionId === 'allow' } }) + '\\n')
  }
})
`)
    await chmod(command, 0o700)
    const client = new AntigravityACPClient(command, cwd)
    const seen: Array<string | number | undefined> = []
    client.onMessage = message => {
      if (message.method === 'session/request_permission') {
        seen.push(message.id)
        client.respond(message.id!, { outcome: { outcome: 'selected', optionId: 'allow' } })
      }
    }
    try {
      await expect(client.request('session/prompt', { sessionId: 'session-1', prompt: [] }, 2_000, true)).resolves.toMatchObject({ permitted: true })
      expect(seen).toEqual(['permission-read-1'])
    } finally {
      await client.close()
    }
  })

  it('uses only supported sandboxed ACP flags in every Athena permission mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'athena-acp-auto-mode-'))
    const command = join(cwd, 'mock-acp')
    await writeFile(command, `#!/usr/bin/env node
const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { args: process.argv.slice(2) } }) + '\\n')
})
`)
    await chmod(command, 0o700)
    const client = new AntigravityACPClient(command, cwd)
    try {
      expect((await client.request('initialize', {}, 2_000)).args).toEqual(['acp', '--disable-telemetry', '--sandbox'])
    } finally { await client.close() }
  })

  it('keeps Google API credentials out of the ACP child environment', () => {
    const env = antigravityEnvironment({ PATH: '/usr/bin', HOME: '/home/test', GEMINI_API_KEY: 'must-not-pass', GOOGLE_APPLICATION_CREDENTIALS: '/secret/key.json', HTTP_PROXY: 'http://proxy.test' })
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/test', HTTP_PROXY: 'http://proxy.test' })
    expect(env).not.toHaveProperty('GEMINI_API_KEY')
    expect(env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS')
  })

  it('preserves every valid model family advertised by the authenticated ACP catalog', () => {
    expect(parseAntigravityModels([{ id: 'model', options: [
      { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { value: 'claude-sonnet-5.5-thinking', name: 'Claude Sonnet 5.5 (Thinking)' },
      { value: 'claude-opus-4.6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
      { value: 'gemini-4-argon', name: 'Duplicate label' },
      { value: 'not a valid model id', name: 'Malformed' },
    ] }])).toEqual([
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { id: 'claude-sonnet-5.5-thinking', name: 'Claude Sonnet 5.5 (Thinking)' },
      { id: 'claude-opus-4.6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
    ])
  })

  it('discovers only effort tiers backed by an ACP configuration option for the selected model', () => {
    const config = [
      { id: 'model', currentValue: 'claude-opus-5.5-thinking', options: [
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
        { value: 'claude-opus-5.5-thinking', name: 'Claude Opus 5.5 (Thinking)' },
      ] },
      { id: 'thinking_effort', name: 'Thinking effort', options: [
        { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }, { value: 'max', name: 'Max' },
      ] },
    ]
    expect(parseAntigravityModelEfforts(config)).toEqual({ 'claude-opus-5.5-thinking': ['auto', 'low', 'medium', 'high', 'max'] })
    expect(parseAntigravityModelEfforts(config, 'gemini-4-argon')).toEqual({ 'gemini-4-argon': ['auto', 'low', 'medium', 'high', 'max'] })
    expect(parseAntigravityModelEfforts([{ id: 'model', currentValue: 'claude-opus-5.5-thinking', options: config[0].options }])).toEqual({})
    expect(parseAntigravityModelEffortDefaults(config)).toEqual({})
  })

  it('does not treat an unsupported effort as available just because an unrelated option mentions reasoning', () => {
    expect(parseAntigravityModelEfforts([
      { id: 'model', currentValue: 'gemini-4-argon', options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon', reasoningEfforts: ['low', 'high', 'max'] }] },
      { id: 'response_format', name: 'Reasoning format', options: [{ value: 'json', name: 'JSON' }] },
    ])).toEqual({})
  })

  it('refreshes model-specific capabilities from ACP after switching each advertised model', async () => {
    const service = new AntigravityACPService(await mkdtemp(join(tmpdir(), 'athena-antigravity-test-')))
    vi.spyOn(service as any, 'discover').mockResolvedValue('/opt/google/agy')
    const gemini = 'gemini-4-argon'
    const claude = 'claude-opus-5.5-thinking'
    const models = [{ value: gemini, name: 'Gemini 4 Argon' }, { value: claude, name: 'Claude Opus 5.5 (Thinking)' }]
    const configFor = (model: string) => [
      { id: 'model', currentValue: model, options: models },
      ...(model === gemini ? [{ id: 'thinking_effort', name: 'Reasoning effort', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] }] : [
        { id: 'thinking_effort', name: 'Thinking effort', currentValue: 'extra', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'extra', name: 'Extra' }, { value: 'max', name: 'Max' }] },
      ]),
    ]
    const client = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'session/new') return { sessionId: 'catalog-session', configOptions: configFor(gemini) }
        if (method === 'session/set_config_option') return { configOptions: configFor(String(params?.value)) }
        return {}
      }),
      close: vi.fn(async () => {}),
    }
    vi.spyOn(service as any, 'start').mockResolvedValue({ client, initialize: {} })
    const result = await service.catalog(process.cwd())
    expect(result.status.models.map(model => model.id)).toEqual([gemini, claude])
    expect(result.status.modelEfforts).toEqual({ [gemini]: ['auto', 'low', 'medium'], [claude]: ['auto', 'low', 'high', 'xhigh', 'max'] })
    expect(result.status.modelEffortDefaults).toEqual({ [gemini]: 'medium', [claude]: 'xhigh' })
    expect(client.request).toHaveBeenCalledWith('session/set_config_option', { sessionId: 'catalog-session', configId: 'model', value: claude }, 20_000)
  })

  it('reports a missing CLI as status instead of surfacing an IPC exception on refresh', async () => {
    const service = new AntigravityACPService(await mkdtemp(join(tmpdir(), 'athena-antigravity-test-')))
    vi.spyOn(service as any, 'discover').mockResolvedValue(null)
    const result = await service.commandAction({ action: 'refresh' }, '/private/tmp/antigravity-workspace')
    expect(result.installed).toBe(false)
    expect(result.message).toContain('was not found')
  })

  it('parses only returned quota pools, percentages, model-specific quotas, and reset times', () => {
    const snapshot = parseAntigravityUsageData({ groups: [
      { id: 'gemini', name: 'Gemini Models', buckets: [
        { id: 'gemini-weekly', name: 'Weekly Limit', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-11-18T14:07:38Z' },
        { id: 'gemini-five-hour', name: 'Five Hour Limit', window: 'five_hour', remaining_fraction: 0.5, reset_time: null },
      ] },
      { id: 'claude-gpt', name: 'Claude and GPT Models', buckets: [
        { id: 'partner-weekly', name: 'Weekly Limit', window: 'weekly', remaining_fraction: 0.25, reset_time: 'not-a-date' },
      ] },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', buckets: [
        { id: 'argon-weekly', name: 'Weekly Limit', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-18T14:07:38Z' },
      ] },
    ] }, 1234)
    expect(snapshot.fetchedAt).toBe(1234)
    expect(snapshot.groups).toHaveLength(3)
    expect(snapshot.groups[0].buckets[0]).toMatchObject({ remainingFraction: 0.75, resetAt: '2026-11-18T14:07:38Z' })
    expect(snapshot.groups[0].buckets[1]).toMatchObject({ remainingFraction: 0.5, resetAt: null })
    expect(snapshot.groups[1].buckets[0]).toMatchObject({ remainingFraction: 0.25, resetAt: null })
    expect(snapshot.groups[2].name).toBe('Gemini 4 Argon')
    expect(snapshot.creditsRemaining).toBeNull()
    expect(snapshot.useG1Credits).toBeNull()
  })

  it('retrieves quota, credits, and overage configuration using official structured CLI responses', async () => {
    const service = new AntigravityACPService(await mkdtemp(join(tmpdir(), 'athena-antigravity-test-')))
    vi.spyOn(service as any, 'discover').mockResolvedValue('/opt/google/agy')
    ;(service as any).authState = 'authenticated'
    const calls: string[] = []
    vi.spyOn(service as any, 'structuredCommand').mockImplementation(async (rawName: unknown) => {
      const name = String(rawName)
      calls.push(name)
      if (name === 'usage') return { groups: [{ id: 'gemini', name: 'Gemini Models', buckets: [{ id: 'week', name: 'Weekly Limit', window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-11-18T14:07:38Z' }] }] }
      if (name === 'credits') return { remaining_credits: 0, upgrade_uri: 'not surfaced' }
      return { config: { useG1Credits: false, trustedDirectories: ['/private/path-not-surfaced'] } }
    })
    const result = await service.commandAction({ action: 'usage' })
    expect(calls).toEqual(['usage', 'credits', 'config'])
    expect(result.usage).toMatchObject({ creditsRemaining: 0, useG1Credits: false })
    expect(JSON.stringify(result)).not.toContain('not surfaced')
    expect(JSON.stringify(result)).not.toContain('private/path-not-surfaced')
  })

  it('does not query or retain usage for an unauthenticated Antigravity account', async () => {
    const service = new AntigravityACPService(await mkdtemp(join(tmpdir(), 'athena-antigravity-test-')))
    const query = vi.spyOn(service as any, 'structuredCommand')
    const result = await service.commandAction({ action: 'usage' })
    expect(query).not.toHaveBeenCalled()
    expect(result.usage).toBeNull()
    expect(result.usageError).toMatch(/verify native Google sign-in/i)
  })

  it('keeps the last successful quota snapshot on transient refresh failure without presenting it as fresh', async () => {
    const service = new AntigravityACPService(await mkdtemp(join(tmpdir(), 'athena-antigravity-test-')))
    vi.spyOn(service as any, 'discover').mockResolvedValue('/opt/google/agy')
    ;(service as any).authState = 'authenticated'
    ;(service as any).usage = { fetchedAt: 10, groups: [{ id: 'g', name: 'Gemini Models', buckets: [] }], creditsRemaining: null, useG1Credits: null }
    vi.spyOn(service as any, 'structuredCommand').mockRejectedValue(new Error('Antigravity structured usage command failed.'))
    const result = await service.commandAction({ action: 'usage' })
    expect(result.usage?.fetchedAt).toBe(10)
    expect(result.usageError).toMatch(/structured usage command failed/i)
  })

  it('restores native connection and manually refreshed usage state after a service restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-antigravity-test-'))
    const service = new AntigravityACPService(root)
    ;(service as any).command = '/opt/google/agy'
    ;(service as any).version = '1.5.5'
    ;(service as any).authState = 'authenticated'
    ;(service as any).authMethod = 'oauth-personal'
    ;(service as any).models = [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }]
    ;(service as any).lastCheckedAt = 100
    vi.spyOn(service as any, 'structuredCommand').mockImplementation(async (...args: unknown[]) => {
      const name = String(args[0])
      return name === 'usage'
        ? { groups: [{ id: 'gemini', name: 'Gemini Models', buckets: [{ id: 'weekly', name: 'Weekly Limit', window: 'weekly', remaining_fraction: 0.8, reset_time: '2026-11-18T14:07:38Z' }] }] }
        : name === 'credits' ? { remaining_credits: 0 } : { config: { useG1Credits: false } }
    })
    await service.commandAction({ action: 'usage' })

    const restored = new AntigravityACPService(root)
    const status = await restored.commandAction({ action: 'status' })
    expect(status.authState).toBe('authenticated')
    expect(status.authMethod).toBe('oauth-personal')
    expect(status.models).toEqual([{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }])
    expect(status.usage?.groups[0]?.id).toBe('gemini')
    expect(status.usage?.fetchedAt).toBeGreaterThan(0)
    expect(status.lastCheckedAt).toBe(100)
  })

  it('streams the official ACP response using the exact selected model', async () => {
    const { provider, client } = providerHarness()
    const chunks = []
    for await (const chunk of provider.streamMessage(messages)) chunks.push(chunk)
    expect(client.request).toHaveBeenCalledWith('session/set_config_option', expect.objectContaining({ configId: 'model', value: 'gemini-3-pro' }), 20_000)
    expect(client.request).toHaveBeenCalledWith('session/prompt', expect.objectContaining({ sessionId: 'session-1' }), 1_800_000, true)
    expect(chunks).toContainEqual({ type: 'text', text: 'Hello from Gemini.' })
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  it.each(accountModels)('routes $name through the common ACP lifecycle', async ({ id }) => {
    const { provider, client } = providerHarness(id)
    const phases: string[] = []
    const progress = vi.fn()
    const chunks = []
    for await (const chunk of provider.streamMessage(messages, { onStreamPhase: phase => phases.push(phase), onMeaningfulProgress: progress })) chunks.push(chunk)
    expect(client.request).toHaveBeenCalledWith('session/set_config_option', expect.objectContaining({ value: id }), 20_000)
    expect(client.request).toHaveBeenCalledWith('session/prompt', expect.anything(), 1_800_000, true)
    expect(phases).toEqual(expect.arrayContaining(['preparing', 'connecting', 'waiting-model', 'streaming']))
    expect(progress).toHaveBeenCalled()
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  it('ignores ACP heartbeats as progress and reports actual tool state', () => {
    expect(antigravityMeaningfulACPUpdate({ method: 'session/update', params: { update: { sessionUpdate: 'heartbeat' } } })).toBe(false)
    expect(antigravityMeaningfulACPUpdate({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: '' } } } })).toBe(false)
    expect(antigravityMeaningfulACPUpdate({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' } } })).toBe(true)
  })

  it.each([
    ['weekly quota exhausted', /subscription or model limit/i],
    ['authentication required', /authentication needs attention/i],
    ['ACP session closed', /disconnected before finishing/i],
  ])('classifies an ACP failure without switching providers: %s', async (failure, expected) => {
    const { provider, client } = providerHarness('gemini-4-argon')
    client.request.mockImplementation(async (method: string) => {
      if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: 'gemini-4-argon' }] }
      if (method === 'session/prompt') throw new Error(failure)
      return {}
    })
    await expect(async () => {
      for await (const _chunk of provider.streamMessage(messages)) { /* consume */ }
    }).rejects.toThrow(expected)
  })

  it('wakes a pending ACP event wait and sends cancellation for only its session', async () => {
    const { provider, client, service } = providerHarness('gemini-4-argon')
    client.request.mockImplementation(async (method: string): Promise<Record<string, unknown>> => {
      if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: 'gemini-4-argon' }] }
      if (method === 'session/prompt') return new Promise(() => {})
      return {}
    })
    const controller = new AbortController()
    const phases: string[] = []
    const request = (async () => {
      for await (const _chunk of provider.streamMessage(messages, { signal: controller.signal, onStreamPhase: phase => phases.push(phase) })) { /* consume */ }
    })()
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith('session/prompt', expect.anything(), 1_800_000, true))
    controller.abort()
    await expect(request).rejects.toThrow(/stopped by Athena or the user/i)
    expect(client.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'session-1' })
    expect(client.close).toHaveBeenCalledOnce()
    expect(service.acquireRequest).toHaveBeenCalledOnce()
    expect(phases).toContain('cancelling')
  })

  it.each([44, 'permission-44'])('keeps a native tool visibly waiting for approval with RPC ID %s', async permissionId => {
    const { provider, client } = providerHarness('gemini-4-argon')
    let finishPrompt: ((value: Record<string, unknown>) => void) | undefined
    let decide: ((allow: boolean) => void) | undefined
    client.request.mockImplementation(async (method: string): Promise<Record<string, unknown>> => {
      if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: 'gemini-4-argon' }] }
      if (method === 'session/prompt') return new Promise(resolve => { finishPrompt = resolve })
      return {}
    })
    const phases: string[] = []
    const request = (async () => { for await (const _chunk of provider.streamMessage(messages, {
      onStreamPhase: phase => phases.push(phase),
      requestApproval: () => new Promise<boolean>(resolve => { decide = resolve }),
    })) { /* drain */ } })()
    await vi.waitFor(() => expect(finishPrompt).toBeDefined())
    client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file', status: 'running' } } })
    client.onMessage?.({ id: permissionId, method: 'session/request_permission', params: { sessionId: 'session-1', options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }], toolCall: { title: 'Read file' } } })
    client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Read file', status: 'running', content: [{ type: 'text', text: 'Waiting for access' }] } } })
    expect(phases.at(-1)).toBe('waiting-approval')
    expect(client.respond).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(decide).toBeDefined())
    decide?.(true)
    await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith(permissionId, { outcome: { outcome: 'selected', optionId: 'allow' } }))
    expect(phases.at(-1)).toBe('running-tools')
    client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Read file', status: 'completed' } } })
    client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'File reviewed.' } } } })
    finishPrompt?.({})
    await request
  })

  it('passes a cancellation signal into ACP session startup', async () => {
    const { provider, service } = providerHarness('gemini-4-argon')
    const controller = new AbortController()
    for await (const _chunk of provider.streamMessage(messages, { signal: controller.signal })) { /* consume */ }
    expect(service.connect).toHaveBeenCalledWith('/authorized/workspace', controller.signal, undefined)
  })

  it.each(accountModels)('normalizes verified native ACP file edits for advertised model $id', async ({ id: model }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'athena-antigravity-file-change-'))
    try {
      await writeFile(join(cwd, 'events.yaml'), 'phase: draft\n')
      const { provider, client } = providerHarness(model, cwd)
      client.request.mockImplementation(async (method: string): Promise<Record<string, unknown>> => {
        if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: model, options: [{ value: model, name: model }] }] }
        if (method === 'session/prompt') return new Promise(resolve => {
          void (async () => {
            const input = { toolCallId: 'edit-1', kind: 'edit', rawInput: { path: 'events.yaml' } }
            client.onMessage?.({ id: 'permission-edit-1', method: 'session/request_permission', params: { sessionId: 'session-1', options: [{ optionId: 'allow', kind: 'allow_once' }], toolCall: input } })
            await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith('permission-edit-1', { outcome: { outcome: 'selected', optionId: 'allow' } }))
            // The permission request carried the kind/path; later notifications
            // need not repeat either field for the tracker to reconcile the edit.
            client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit events.yaml', status: 'running', rawInput: input.rawInput } } })
            await writeFile(join(cwd, 'events.yaml'), 'phase: reopened\n')
            // ACP completion notifications may omit `kind`; retain the operation
            // type learned from the earlier running event to reconcile the diff.
            client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', title: 'Edit events.yaml', status: 'completed' } } })
            client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Updated the event.' } } } })
            resolve({})
          })()
        })
        return {}
      })
      const chunks = []
      for await (const chunk of provider.streamMessage(messages, { requestApproval: async () => true })) chunks.push(chunk)
      const changeChunk = chunks.find(chunk => chunk.type === 'activity' && chunk.changes?.length)
      expect(changeChunk).toMatchObject({ type: 'activity', status: 'complete', changes: [{ path: 'events.yaml', status: 'applied', providerId: 'google-antigravity-subscription', verified: true }] })
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })

  it('includes every text block of an explicitly selected review attachment', async () => {
    const { provider, client } = providerHarness('gemini-4-argon')
    const full = Array.from({ length: 41 }, (_, index) => `SECTION ${index + 1}: ${'review detail '.repeat(40)}`).join('\n')
    const attachment = { id: 'document-1', name: 'review.txt', kind: 'text' as const, data: full }
    for await (const _chunk of provider.streamMessage(messages, { context: { attachments: [attachment], repositoryText: '', sources: [] } })) { /* consume */ }
    const promptCall = client.request.mock.calls.find(([method]) => method === 'session/prompt')
    const prompt = (promptCall?.[1] as { prompt: Array<{ text: string }> }).prompt[0].text
    expect(prompt).toContain(full)
    expect(prompt).toContain('SECTION 1:')
    expect(prompt).toContain('SECTION 41:')
  })

  it.each(accountModels.map(model => [model.id]))('sends the complete 131,193-byte paste with %s', async model => {
    const { provider, client } = providerHarness(model)
    const full = 'L'.repeat(131_193)
    const attachment = { id: 'pasted-log', name: 'Pasted code.log', kind: 'text' as const, data: full }
    for await (const _chunk of provider.streamMessage([{ ...messages[0], content: 'This is the response' }], {
      context: { attachments: [attachment], repositoryText: '', sources: [] },
    })) { /* consume */ }
    const promptCall = client.request.mock.calls.find(([method]) => method === 'session/prompt')
    const prompt = (promptCall?.[1] as { prompt: Array<{ text: string }> }).prompt[0].text
    expect(prompt).toContain(full)
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(160_000)
  })

  it('compacts a long existing conversation before ACP and keeps the current request complete', async () => {
    const { provider, client } = providerHarness()
    const history: ChatMessage[] = Array.from({ length: 48 }, (_, index) => ({
      id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', status: 'complete', createdAt: index,
      content: index === 0 ? 'MBM-11745: preserve the lifecycle behavior and authorization constraints.' : `Older conversation detail ${index}. ${'Implementation result and discussion. '.repeat(140)}`,
    } as ChatMessage))
    const current: ChatMessage = { id: 'current-request', role: 'user', status: 'complete', createdAt: 49, content: 'Review the current lifecycle behavior and report remaining risks.' }
    const chunks = []
    for await (const chunk of provider.streamMessage([...history, current], { conversationId: 'conversation-1', executionId: 'execution-1', context: { attachments: [], repositoryText: '', sources: [] } })) chunks.push(chunk)

    const promptCall = client.request.mock.calls.find(([method]) => method === 'session/prompt')
    const prompt = (promptCall?.[1] as { prompt: Array<{ text: string }> }).prompt[0].text
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(180_000)
    expect(prompt).toContain('Earlier conversation checkpoint')
    expect(prompt).toContain('MBM-11745')
    expect(prompt).toContain(current.content)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  it('rejects only when required current context cannot fit and explains the largest component', async () => {
    const { provider, client } = providerHarness()
    await expect(async () => {
      for await (const _chunk of provider.streamMessage(messages, { context: { attachments: [], repositoryText: 'required-project-context '.repeat(9_000), sources: [] } })) { /* consume */ }
    }).rejects.toThrow(/largest required component.*project context|largest required component.*conversation history/i)
    expect(client.request).not.toHaveBeenCalledWith('session/prompt', expect.anything(), expect.anything())
  })

  it('sets the exact runtime-advertised reasoning option before sending the prompt', async () => {
    const model = 'claude-sonnet-5.5-thinking'
    const { client, service } = providerHarness(model)
    const options = [
      { id: 'model', currentValue: model, options: [{ value: model, name: 'Claude Sonnet 5.5 (Thinking)' }] },
      { id: 'thinking_budget', name: 'Thinking effort', currentValue: 'balanced', options: [
        { value: 'concise', name: 'Low' }, { value: 'balanced', name: 'Medium' }, { value: 'deep', name: 'High' },
      ] },
    ]
    client.request.mockImplementation(async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === 'session/set_config_option' && params?.configId === 'model') return { configOptions: options }
      if (method === 'session/set_config_option' && params?.configId === 'thinking_budget') return { configOptions: options.map(option => option.id === 'thinking_budget' ? { ...option, currentValue: params.value } : option) }
      if (method === 'session/prompt') {
        queueMicrotask(() => client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Claude response.' } } } }))
        return {}
      }
      return {}
    })
    const withEffort = new AntigravityProvider(service, '/authorized/workspace', model, async () => {}, false, 'high')
    for await (const _chunk of withEffort.streamMessage(messages)) { /* drain */ }
    expect(client.request).toHaveBeenCalledWith('session/set_config_option', { sessionId: 'session-1', configId: 'thinking_budget', value: 'deep' }, 20_000)
    const calls = client.request.mock.calls as unknown as Array<[string, Record<string, unknown>?]>
    expect(calls.findIndex(([method, params]) => method === 'session/set_config_option' && params?.configId === 'thinking_budget'))
      .toBeLessThan(calls.findIndex(([method]) => method === 'session/prompt'))
  })

  it('blocks an effort missing from the selected model runtime config without sending a prompt', async () => {
    const { service, client } = providerHarness('claude-opus-4.6-thinking')
    const withMax = new AntigravityProvider(service, '/authorized/workspace', 'claude-opus-4.6-thinking', async () => {}, false, 'max')
    await expect(async () => {
      for await (const _chunk of withMax.streamMessage(messages)) { /* no prompt expected */ }
    }).rejects.toThrow(/did not advertise max reasoning/i)
    expect(client.request).not.toHaveBeenCalledWith('session/prompt', expect.anything(), expect.anything())
  })

  it('does not send a project prompt when Athena is in Read Only mode', async () => {
    const { service } = providerHarness()
    const projectProvider = new AntigravityProvider(service, '/authorized/workspace', 'gemini-3-pro', async () => {}, true)
    await expect(async () => {
      for await (const _chunk of projectProvider.streamMessage(messages, { permissionMode: 'read-only' })) { /* no output expected */ }
    }).rejects.toThrow(/read-only project mode.*no prompt was sent/i)
    expect(service.connect).not.toHaveBeenCalled()
  })

  it('does not use an ACP default model when Athena has no selected catalog model', async () => {
    const { service } = providerHarness()
    const provider = new AntigravityProvider(service, '/authorized/workspace', null)
    await expect(async () => {
      for await (const _chunk of provider.streamMessage(messages)) { /* no output expected */ }
    }).rejects.toThrow(/choose a model.*no default or alternate model/i)
  })

  it('never grants ACP permission automatically when Athena approval UI is unavailable', async () => {
    const { provider, client } = providerHarness()
    client.request.mockImplementation(async (method: string) => {
      if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: 'gemini-3-pro', options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }] }] }
      if (method === 'session/prompt') {
        client.onMessage?.({ jsonrpc: '2.0', id: 44, method: 'session/request_permission', params: {
          sessionId: 'session-1', options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }], toolCall: { title: 'Edit file', rawInput: { path: 'src/app.ts' } },
        } })
        await new Promise(resolve => setTimeout(resolve, 0))
        client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'The operation was denied.' } } } })
        return {}
      }
      return {}
    })
    for await (const _chunk of provider.streamMessage(messages)) { /* drain */ }
    expect(client.respond).toHaveBeenCalledWith(44, { outcome: { outcome: 'selected', optionId: 'deny' } })
  })
  it('routes every native ACP request through Full Access automatic approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'athena-acp-full-access-'))
    const { client, service } = providerHarness('gemini-3-pro', cwd)
    const provider = new AntigravityProvider(service, cwd, 'gemini-3-pro', async () => {}, true)
    const approval = vi.fn(async () => true)
    client.request.mockImplementation(async (method: string) => {
      if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: 'gemini-3-pro', options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }] }] }
      if (method === 'session/prompt') {
        for (const [id, toolCall] of [
          ['permission-file', { kind: 'edit', title: 'Edit project file', rawInput: { path: 'src/app.ts' } }],
          ['permission-command', { kind: 'execute', title: 'Run command', rawInput: { command: 'ls /Applications; npm view three version' } }],
          ['permission-unknown', { title: 'Unclassified ACP tool' }],
        ] as const) {
          client.onMessage?.({ id, method: 'session/request_permission', params: { sessionId: 'session-1', options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }], toolCall } })
          await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith(id, { outcome: { outcome: 'selected', optionId: 'allow' } }))
        }
        client.onMessage?.({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Read complete.' } } } })
        return {}
      }
      return {}
    })
    const chunks = []
    try { for await (const chunk of provider.streamMessage(messages, { permissionMode: 'full-access', requestApproval: approval })) chunks.push(chunk) }
    finally { await rm(cwd, { recursive: true, force: true }) }
    expect(service.connect).toHaveBeenCalledWith(cwd, expect.any(AbortSignal), undefined)
    expect(approval).toHaveBeenCalledTimes(3)
    for (const call of approval.mock.calls) expect(call).toEqual([expect.stringContaining('Antigravity'), expect.any(String), expect.any(AbortSignal), undefined, undefined, true])
    expect(chunks).toContainEqual({ type: 'text', text: 'Read complete.' })
  })
  it('closes an open native approval when ACP disconnects', async () => {
    const { provider, client } = providerHarness()
    let approvalSignal: AbortSignal | undefined
    client.request.mockImplementation(async (method: string) => {
      if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', currentValue: 'gemini-3-pro', options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }] }] }
      if (method === 'session/prompt') {
        client.onMessage?.({ id: 'pending-approval', method: 'session/request_permission', params: { sessionId: 'session-1', options: [{ optionId: 'allow', kind: 'allow_once' }] } })
        await vi.waitFor(() => expect(approvalSignal).toBeDefined())
        throw new Error('Antigravity ACP connection closed.')
      }
      return {}
    })
    await expect(async () => {
      for await (const _chunk of provider.streamMessage(messages, { permissionMode: 'full-access', requestApproval: async (_title, _description, signal) => {
        approvalSignal = signal
        return new Promise<boolean>(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }))
      } })) { /* drain */ }
    }).rejects.toThrow(/disconnected/i)
    expect(approvalSignal?.aborted).toBe(true)
  })
})
