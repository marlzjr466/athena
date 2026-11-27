import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MediaService } from '../electron/main/media/mediaService'
import { ArtifactService } from '../electron/main/ai/artifactService'
import { newConversation, ConversationRepository } from '../electron/main/ai/conversationRepository'
import { mediaDefaults, mediaIntent, mediaRoutes, type MediaJob } from '../shared/mediaGeneration'
import {
  googleInteraction,
  imageAdapter,
  MediaFailure,
  xaiVideo,
  readJson,
  type MediaAdapter,
} from '../electron/main/media/protocols'
import { MediaRegistry } from '../electron/main/media/registry'
import type { AIConfiguration } from '../electron/main/ai/aiConfiguration'
import type { ThirdPartyInferenceService } from '../electron/main/ai/thirdPartyInference'
import { consumeImageStream } from '../electron/main/media/imageStream'
import { discoverComfy } from '../electron/main/media/comfy'
const roots: string[] = []
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i5K0AAAAASUVORK5CYII=',
  'base64',
)
const img = { bytes: png, mime: 'image/png' }
const video = {
  bytes: Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'),
  mime: 'video/mp4',
}
const task = (
  op: MediaJob['operation'] = 'image',
  prompt = 'Generate a photorealistic emerald-green forest covered with snow',
) => ({ requestId: randomUUID(), operation: op, prompt, options: {} })
const base = (id: string, billing: MediaAdapter['billing'] = 'local'): MediaAdapter => ({
  id,
  provider: id,
  connection: id,
  model: id + '-model',
  billing,
  operations: ['image', 'edit-image', 'video', 'animate'],
  controls: [],
  submit: vi.fn(async () => ({ files: [img] })),
})
function setup(routes: MediaAdapter[]) {
  const root = mkdtempSync(join(tmpdir(), 'athena-media-test-'))
  roots.push(root)
  const settings = mediaDefaults(),
    session = newConversation(),
    other = newConversation(),
    repository = new ConversationRepository(root)
  const host = {
    session: (id: string) => [session, other].find((s) => s.id === id),
    persist: vi.fn(() =>
      repository.save({
        version: 1,
        activeId: session.id,
        sessions: [session, other],
      }),
    ),
  }
  const registry = {
      discover: vi.fn(async () => ({ adapters: routes, notices: [] })),
    },
    store = new ArtifactService(join(root, 'files'))
  const make = () =>
    new MediaService(
      registry,
      () => settings,
      () => ({ selected: 'text-only', offline: false }),
      store,
      async () => img,
      join(root, 'ledger.json'),
      2,
    )
  return {
    settings,
    session,
    other,
    repository,
    host,
    make,
    service: make(),
    store,
  }
}
const until = async (f: () => boolean) => vi.waitFor(() => expect(f()).toBe(true), { interval: 5 })
describe('conversation-scoped media generation', () => {
  it('routes a text-only conversation through image, waterfall edit and video fixtures without switching models', async () => {
    const a = base('local fixture'),
      seen: string[] = []
    a.submit = async (j, parent) => {
      seen.push(parent?.mime ?? 'none')
      return { files: [j.operation === 'animate' ? video : img] }
    }
    const { service, session, host, other, repository, store } = setup([a])
    const config = structuredClone(session.config)
    const m = service.create(host, session, task())
    await until(() => m.mediaJob?.status === 'ready')
    const edit = service.create(host, session, task('edit-image', 'Add a waterfall'))
    await until(() => edit.mediaJob?.status === 'ready')
    const v = service.create(
      host,
      session,
      task('animate', 'Turn this into a cinematic video with falling snow'),
    )
    await until(() => v.mediaJob?.status === 'ready')
    expect(seen).toEqual(['none', 'image/png', 'image/png'])
    expect(v.mediaJob?.parentId).toBe(edit.artifacts![0].id)
    expect(await store.read(m.artifacts![0])).toEqual(png)
    expect(repository.load().sessions[0].messages.at(-1)?.mediaJob).toEqual(v.mediaJob)
    expect(session.config).toEqual(config)
    expect(() =>
      service.create(host, other, {
        ...task('edit-image'),
        parentId: m.artifacts![0].id,
      }),
    ).toThrow(/source/)
  })
  it('requires paid consent and falls back only after an explicit rejection', async () => {
    const a = base('paid', 'api'),
      b = base('local')
    a.submit = vi.fn(async () => {
      throw new MediaFailure('Out of credits', true)
    })
    const { service, session, host, settings } = setup([a, b])
    settings.image.preferred = a.id
    const req = task(),
      m = service.create(host, session, req)
    await until(() => m.mediaJob?.status === 'approval')
    expect(a.submit).not.toHaveBeenCalled()
    expect(service.create(host, session, req)).toBe(m)
    service.control(host, session, m, 'approve', 'paid')
    service.control(host, session, m, 'approve', 'paid')
    await until(() => m.mediaJob?.status === 'ready')
    expect(a.submit).toHaveBeenCalledTimes(1)
    expect(b.submit).toHaveBeenCalledTimes(1)
  })
  it.each([new Error('connection reset after POST'), new MediaFailure('Blocked by moderation')])(
    'never replays uncertain submissions or moderated requests',
    async (err) => {
      const a = base('a'),
        b = base('b')
      a.submit = vi.fn(async () => {
        throw err
      })
      const { service, host, session } = setup([a, b]),
        m = service.create(host, session, task())
      await until(() => m.mediaJob?.status === 'failed')
      expect(b.submit).not.toHaveBeenCalled()
      expect(m.artifacts).toBeUndefined()
    },
  )
  it('requires no OpenAI key and selects only verified included and local routes in no-charges mode', async () => {
    const paid = base('api', 'api'),
      native = {
        ...base('text-only', 'subscription'),
        native: true,
        included: true,
      }
    const { service, host, session, settings } = setup([paid, native])
    settings.image.mode = 'no-charges'
    const m = service.create(host, session, task())
    await until(() => m.mediaJob?.status === 'ready')
    expect(paid.submit).not.toHaveBeenCalled()
    expect(native.submit).toHaveBeenCalledTimes(1)
  })
  it('restores an accepted remote job by polling only and isolates concurrent conversations', async () => {
    const a = base('video')
    a.submit = vi.fn(async () => ({ remoteId: 'existing-id' }))
    a.poll = vi.fn(async () => ({ remoteId: 'existing-id' }))
    const { service, host, session, other, make, repository } = setup([a])
    const m = service.create(host, session, task('video')),
      another = service.create(host, other, task('video'))
    await until(() => m.mediaJob?.status === 'processing' && another.mediaJob?.status === 'processing')
    service.dispose()
    const recovered = repository.load().sessions[0],
      restored = recovered.messages[0],
      newHost = { ...host, session: () => recovered }
    a.poll = vi.fn(async () => ({ files: [video] }))
    make().recover(newHost, recovered)
    await until(() => restored.mediaJob?.status === 'ready')
    expect(a.submit).toHaveBeenCalledTimes(2)
    expect(a.poll).toHaveBeenCalledWith('existing-id', expect.any(AbortSignal))
  })
  it('stops monitoring without claiming remote cancellation', async () => {
    const a = base('video')
    a.submit = async () => ({ remoteId: 'id' })
    a.poll = async () => ({ remoteId: 'id' })
    const { service, session, host } = setup([a])
    const m = service.create(host, session, task('video'))
    await until(() => m.mediaJob?.status === 'processing')
    service.control(host, session, m, 'stop')
    expect(m.content).toMatch(/still complete/)
    expect(m.artifacts).toBeUndefined()
  })
  it('configuration failure and the spending ceiling do not produce media', async () => {
    for (const routes of [[], [base('paid', 'api')]]) {
      const { service, session, host, settings } = setup(routes)
      settings.maxCostUSD = 0.01
      const m = service.create(host, session, task())
      await until(() => m.mediaJob?.status === 'failed')
      expect(m.artifacts).toBeUndefined()
    }
  })
})
describe('intent and wire contracts', () => {
  it.each([
    ['Generate an image of a green forest', 'image'],
    ['Add a waterfall', 'edit-image'],
    ['Animate the last generated image', 'animate'],
    ['Turn this into a cinematic video', 'animate'],
    ['Write an image prompt', undefined],
    ['Generate a code sample for image generation', undefined],
    ['Explain how to generate an image', undefined],
  ])('%s', (text, op) => expect(mediaIntent(text!, 'image')).toBe(op))
  it('rejects unrelated operations in local-only routing', () => {
    const s = mediaDefaults()
    s.image.mode = 'local'
    expect(
      mediaRoutes([base('cloud', 'api')], { ...task(), attempted: [] } as unknown as MediaJob, s, false),
    ).toEqual([])
  })
  it('sends JSON for Images, multipart for edits and a separate native Responses tool', async () => {
    const call = vi.fn(async (_path: string, _init: RequestInit) =>
        Response.json({ data: [{ b64_json: png.toString('base64') }] }),
      ),
      a = imageAdapter(base('image'), call, 'images'),
      signal = new AbortController().signal
    await a.submit(task() as MediaJob, undefined, signal)
    expect(call.mock.calls[0][0]).toBe('/images/generations')
    await a.submit(task('edit-image') as MediaJob, img, signal)
    expect(call.mock.calls[1][1].body).toBeInstanceOf(FormData)
    const native = imageAdapter(
      base('image'),
      async (path, init) => {
        expect(path).toBe('/responses')
        expect(JSON.parse(String(init.body)).tools[0].type).toBe('image_generation')
        return Response.json({
          status: 'completed',
          output: [{ type: 'image_generation_call', result: png.toString('base64') }],
        })
      },
      'responses',
      'test-host-model',
    )
    expect((await native.submit(task() as MediaJob, undefined, signal)).files?.[0].bytes).toEqual(png)
  })
  it('posts xAI video once and polls its assigned request ID', async () => {
    const call = vi.fn(async (path: string) =>
        Response.json(
          path === '/videos/generations'
            ? { request_id: 'vid' }
            : { status: 'done', video: { url: 'https://media.x.ai/test.mp4' } },
        ),
      ),
      a = xaiVideo(base('xAI fixture'), call, async () => video),
      signal = new AbortController().signal
    expect((await a.submit(task('animate') as MediaJob, img, signal)).remoteId).toBe('vid')
    expect((await a.poll!('vid', signal)).files).toEqual([video])
    expect(call.mock.calls.map((x) => x[0])).toEqual(['/videos/generations', '/videos/vid'])
  })
  it('does not route around moderation or uncertain HTTP 503', async () => {
    for (const [status, code, rejected] of [
      [400, 'moderation_blocked', false],
      [503, 'server_error', false],
      [402, 'insufficient_quota', true],
    ] as const)
      await expect(
        readJson(Response.json({ error: { code } }, { status }), new AbortController().signal),
      ).rejects.toMatchObject({ rejected })
  })
  it('requires compatible installed ComfyUI nodes and device memory', async () => {
    const s = mediaDefaults()
    s.workflows = [
      {
        name: 'local-fixture',
        graph: JSON.stringify({
          1: { class_type: 'CLIPTextEncode', inputs: { text: '$prompt' } },
          2: { class_type: 'SaveImage', inputs: {} },
        }),
        operation: 'image',
        minimumMemoryGB: 8,
      },
    ]
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      Response.json(
        String(url).endsWith('system_stats')
          ? { devices: [{ type: 'cuda', vram_total: 10 * 1024 ** 3 }] }
          : { CLIPTextEncode: {}, SaveImage: {} },
      ),
    )
    expect(await discoverComfy(s, new AbortController().signal, fetcher)).toHaveLength(1)
    s.workflows[0].minimumMemoryGB = 12
    expect(await discoverComfy(s, new AbortController().signal, fetcher)).toHaveLength(0)
  })
})

describe('subscription preflight and media contracts', () => {
  const signal = new AbortController().signal
  it('checks the selected ChatGPT model without reading API keys or contacting a paid endpoint', async () => {
    const ai = { mediaCredential: vi.fn() },
      third = { list: vi.fn() },
      runtime = vi.fn(async () => [])
    const registry = new MediaRegistry(
      ai as unknown as AIConfiguration,
      third as unknown as ThirdPartyInferenceService,
      mediaDefaults,
      runtime,
    )
    const result = await registry.discover({
      selected: 'subscription',
      model: 'gpt-6-astra',
      offline: false,
      includedOnly: true,
    })
    expect(result.adapters).toHaveLength(0)
    expect(result.notices.join(' ')).toMatch(/Sign in with ChatGPT/)
    expect(ai.mediaCredential).not.toHaveBeenCalled()
    expect(third.list).not.toHaveBeenCalled()
  })
  it('does not misinterpret ordinary development requests after an unrelated turn', async () => {
    const { service, session, host } = setup([base('local')])
    const m = service.create(host, session, task())
    await until(() => m.mediaJob?.status === 'ready')
    expect(service.intent(session, 'Add a waterfall')).toBe('edit-image')
    expect(service.intent(session, 'Create a video player')).toBeUndefined()
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      status: 'complete',
      content: 'The settings screen is open.',
      createdAt: Date.now(),
    })
    expect(service.intent(session, 'Add a Save button')).toBeUndefined()
    expect(service.intent(session, 'Animate the last generated image')).toBe('animate')
  })
  it('collects an image preview, requires a completion event, and records the usage receipt', async () => {
    const data = png.toString('base64')
    const input = (events: unknown[]) =>
      new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    const partial = { type: 'image_generation.partial_image', b64_json: data }
    const completed = {
      type: 'image_generation.completed',
      b64_json: data,
      usage: { total_tokens: 42 },
    }
    const preview = vi.fn(async () => {})
    expect(await consumeImageStream(input([partial, completed]), signal, preview)).toMatchObject({
      files: [img],
      usage: { total_tokens: 42 },
    })
    expect(preview).toHaveBeenCalledTimes(1)
    await expect(consumeImageStream(input([partial]), signal, preview)).rejects.toThrow(/completion event/)
  })
  it('uses the native Grok Responses image tool and accepts the actual image format', async () => {
    const call = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).toBe('/responses')
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: 'grok-4.7',
        tools: [{ type: 'image_generation', action: 'edit' }],
      })
      return Response.json({
        status: 'completed',
        output: [{ type: 'image_generation_call', result: png.toString('base64') }],
      })
    })
    const native = imageAdapter(base('Grok'), call, 'xai-native', 'grok-4.7')
    expect((await native.submit(task('edit-image') as MediaJob, img, signal)).files).toMatchObject([img])
  })
  it('retrieves the authenticated Google file after an Omni video interaction', async () => {
    const call = vi.fn(async (path: string, init: RequestInit) => {
      if (path === '/interactions') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          model: 'gemini-omni-1.2-flash',
          response_format: { duration: '10s', delivery: 'uri' },
          input: [{ type: 'user_input' }],
        })
        return Response.json({ status: 'in_progress', id: 'interaction1' })
      }
      if (path === '/interactions/interaction1')
        return Response.json({
          status: 'completed',
          id: 'interaction1',
          output_video: { type: 'video', uri: 'files/test-file' },
        })
      if (path === '/files/test-file') return Response.json({ state: 'ACTIVE' })
      expect(path).toBe('/files/test-file:download?alt=media')
      return new Response(video.bytes)
    })
    const a = googleInteraction({ ...base('Omni'), model: 'gemini-omni-1.2-flash' }, call)
    expect(
      await a.submit({ ...task('animate'), options: { duration: 10 } } as MediaJob, img, signal),
    ).toEqual({ remoteId: 'interaction1' })
    expect(await a.poll!('interaction1', signal)).toEqual({
      remoteId: 'file:test-file',
    })
    const output = await a.poll!('file:test-file', signal)
    expect(output.files?.[0].mime).toBe('video/mp4')
    expect(Buffer.from(output.files![0].bytes)).toEqual(video.bytes)
  })
})

describe('provider job controls', () => {
  it('cancels only the accepted background interaction, and verifies its status', async () => {
    const call = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).toBe('/interactions/owned/cancel')
      expect(init.method).toBe('POST')
      return Response.json({ id: 'owned', status: 'cancelled' })
    })
    const adapter = googleInteraction({ ...base('Google fixture'), model: 'gemini-omni-1.2-flash' }, call)
    expect(await adapter.cancel!('owned', new AbortController().signal)).toBe(true)
    expect(await adapter.cancel!('file:already-finished', new AbortController().signal)).toBe(false)
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('emits a background completion only for verified media and keeps both conversation IDs', async () => {
    const { service, host, session, other } = setup([base('local')])
    const m = service.create(host, session, task()),
      n = service.create(host, other, task())
    await until(() => m.mediaJob?.status === 'ready' && n.mediaJob?.status === 'ready')
    const completions = (
      host.persist.mock.calls as unknown as Array<[typeof session, typeof m, boolean]>
    ).filter((call) => call[2])
    expect(completions.map((call) => call[0].id).sort()).toEqual([session.id, other.id].sort())
    expect(completions.every((call) => call[1].artifacts?.length === 1)).toBe(true)
  })
})

describe('composer modes, defaults and reference isolation', () => {
  it('resolves manual image/video intent without changing the selected conversation model', () => {
    const { service, session, other } = setup([])
    session.config.mediaMode = 'image'
    expect(service.intent(session, 'A snowy forest')).toBe('image')
    expect(service.intent(other, 'A snowy forest')).toBeUndefined()
    session.attachments.push({
      id: randomUUID(),
      kind: 'image',
      name: 'forest.png',
      mime: 'image/png',
      size: 4,
      characters: 0,
    })
    expect(service.intent(session, 'Add a waterfall')).toBe('edit-image')
    session.config.mediaMode = 'video'
    expect(service.intent(session, 'Falling snow')).toBe('animate')
    session.attachments[0].kind = 'video'
    session.attachments[0].mime = 'video/mp4'
    expect(service.intent(session, 'Make the previous video longer')).toBe('extend-video')
    session.config.mediaMode = null
    expect(service.intent(session, 'Explain how to edit this video')).toBeUndefined()
  })
  it('applies saved image defaults to actual requests independently of video defaults', async () => {
    const route = base('image')
    route.controls = ['quality']
    route.values = { quality: ['high'] }
    const { service, settings, session, host } = setup([route])
    settings.image.defaults = { quality: 'high' }
    settings.video.defaults = { duration: 10 }
    const m = service.create(host, session, task())
    await until(() => m.mediaJob?.status === 'ready')
    expect(route.submit).toHaveBeenCalledWith(
      expect.objectContaining({ options: { quality: 'high' } }),
      undefined,
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(m.mediaJob?.options).not.toHaveProperty('duration')
  })
  it('preserves drafts and generation mode across storage reloads', () => {
    const { session, other, repository, host } = setup([])
    session.config.mediaMode = 'image'
    session.draft = 'Unsent forest'
    other.config.mediaMode = 'video'
    other.draft = 'Unsent waterfall'
    host.persist()
    const restored = repository.load().sessions
    expect(restored.find((s) => s.id === session.id)).toMatchObject({
      draft: 'Unsent forest',
      config: { mediaMode: 'image' },
    })
    expect(restored.find((s) => s.id === other.id)).toMatchObject({
      draft: 'Unsent waterfall',
      config: { mediaMode: 'video' },
    })
  })
  it('blocks unknown paid prices under a monthly dollar cap before submission', async () => {
    const paid = base('paid', 'api')
    const { service, settings, session, host } = setup([paid])
    settings.monthlyCostUSD = 10
    settings.confirmPaid = false
    settings.paidRoutes = ['paid']
    const m = service.create(host, session, task())
    await until(() => m.mediaJob?.status === 'failed')
    expect(paid.submit).not.toHaveBeenCalled()
    expect(m.content).toContain('binding price')
  })
  it('recognizes explicit prior-media edits after intervening text and excludes prompt requests', () => {
    expect(mediaIntent('Make the previous video longer', 'video')).toBe('extend-video')
    expect(mediaIntent('Create a prompt for a cinematic video')).toBeUndefined()
    const { session, service } = setup([])
    session.messages.push(
      {
        id: randomUUID(),
        role: 'user',
        status: 'complete',
        content: 'image',
        createdAt: 1,
        attachments: [
          {
            id: randomUUID(),
            kind: 'image',
            name: 'forest.png',
            mime: 'image/png',
            size: 4,
            characters: 0,
          },
        ],
      },
      {
        id: randomUUID(),
        role: 'assistant',
        status: 'complete',
        content: 'Other discussion',
        createdAt: 2,
      },
    )
    expect(service.intent(session, 'Add snow to the image you generated')).toBe('edit-image')
  })
})

it('starts a new conversation without inheriting a source media reference or mode', () => {
  const old = newConversation()
  old.config.mediaMode = 'video'
  old.config.mediaParentId = randomUUID()
  old.config.mediaOperation = 'animate'
  old.config.model = 'text-only'
  const next = newConversation(old.config)
  expect(next.config.model).toBe('text-only')
  expect(next.config.mediaMode).toBeUndefined()
  expect(next.config.mediaParentId).toBeUndefined()
  expect(next.config.mediaOperation).toBeUndefined()
})

 it('uses newly attached media for automatic routing without a manually selected mode',()=>{
  const {session,service}=setup([])
  session.attachments.push({id:randomUUID(),name:'forest.png',mime:'image/png',kind:'image',size:4,characters:0})
  expect(service.intent(session,'Create a cinematic video of a waterfall')).toBe('animate')
  expect(service.intent(session,'Generate an image of a snowy forest')).toBe('edit-image')
  expect(service.intent(session,'Explain the image')).toBeUndefined()
  session.attachments[0].kind='video';session.attachments[0].mime='video/mp4'
  expect(service.intent(session,'Create a cinematic video of a waterfall')).toBe('edit-video')
})
