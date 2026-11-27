import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { mediaDefaults, mediaJobSchema } from '../shared/mediaGeneration'
import { MediaRegistry } from '../electron/main/media/registry'
import type { AIConfiguration } from '../electron/main/ai/aiConfiguration'
import type { ThirdPartyInferenceService } from '../electron/main/ai/thirdPartyInference'

const vertex = vi.hoisted(() => ({ generate: vi.fn(), get: vi.fn() }))
vi.mock('@google/genai', () => ({
  GenerateVideosOperation: class {},
  GoogleGenAI: class {
    models = { generateVideos: vertex.generate }
    operations = { getVideosOperation: vertex.get }
  },
}))

test('Veo uses the configured project, accepted operation ID and audio options with one paid submission', async () => {
  const model = 'veo-3.1-generate-001'
  const profile = {
    id: randomUUID(),
    name: 'Vertex fixture',
    provider: 'vertex',
    enabled: true,
    region: 'us-central1',
    projectId: 'fixture',
    auth: 'google-adc',
    models: [{ id: model, enabled: true }],
  }
  const remoteId =
    'projects/fixture/locations/us-central1/publishers/google/models/' + model + '/operations/accepted'
  const video = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
  vertex.generate.mockResolvedValue({ name: remoteId })
  vertex.get.mockResolvedValue({
    done: true,
    response: { generatedVideos: [{ video: { videoBytes: video.toString('base64') } }] },
  })
  const registry = new MediaRegistry(
    { mediaCredential: async () => undefined } as unknown as AIConfiguration,
    {
      list: async () => [profile],
      secretsForProvider: async () => ({}),
      endpointForProvider: () => 'https://us-central1-aiplatform.googleapis.com',
    } as unknown as ThirdPartyInferenceService,
    mediaDefaults,
  )
  const catalog = await registry.discover({ selected: profile.id, model, offline: false })
  const adapter = catalog.adapters.find((a) => a.model === model)!
  expect(adapter.billing).toBe('api')
  const job = mediaJobSchema.parse({
    requestId: randomUUID(),
    operation: 'video',
    status: 'submitting',
    prompt: 'Create a cinematic forest video',
    selected: profile.id,
    started: 0,
    updated: 0,
    options: { duration: 8, audio: true },
  })
  const signal = new AbortController().signal
  expect(await adapter.submit(job, undefined, signal)).toEqual({ remoteId })
  expect(vertex.generate).toHaveBeenCalledWith(
    expect.objectContaining({
      model,
      config: expect.objectContaining({ durationSeconds: 8, generateAudio: true }),
    }),
  )
  expect(await adapter.poll!(remoteId, signal)).toMatchObject({
    files: [{ mime: 'video/mp4', bytes: video }],
  })
  await expect(
    adapter.poll!(remoteId.replace('projects/fixture/', 'projects/other/'), signal),
  ).rejects.toThrow(/project and model/)
  expect(vertex.generate).toHaveBeenCalledTimes(1)
  expect(vertex.get).toHaveBeenCalledTimes(1)
})
