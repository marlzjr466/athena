import { createHash } from 'node:crypto'
import { GenerateVideosOperation, GoogleGenAI } from '@google/genai'
import type { AIConfiguration } from '../ai/aiConfiguration'
import type { ThirdPartyInferenceService } from '../ai/thirdPartyInference'
import type { MediaCapability, MediaOperation, MediaSettings } from '../../../shared/mediaGeneration'
import { readResponseBytes } from '../ai/responseBody'
import { discoverComfy } from './comfy'
import {
  geminiImageModels,
  googleInteraction,
  imageAdapter,
  mediaMime,
  MediaFailure,
  openAIImageModels,
  readJson,
  xaiVideo,
  type MediaAdapter,
  type MediaFetch,
} from './protocols'
import { z } from 'zod'

// Official Responses image-tool host catalog; a chat model accepting image inputs is insufficient.
const responseImageHosts = new Set([
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-pro',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.6-cyber',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-cyber',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6.2-astra',
  'gpt-6.2-sol',
])
export interface RouteContext {
  selected: string
  model?: string | null
  offline: boolean
  includedOnly?: boolean
}
export interface Discovery {
  adapters: MediaAdapter[]
  notices: string[]
}
const labels = (
  provider: string,
  connection: string,
  model: string,
  billing: MediaCapability['billing'],
  operations: MediaOperation[],
  controls: MediaCapability['controls'],
): MediaCapability => ({
  id: connection + ':' + model,
  connection,
  provider,
  model,
  billing,
  operations,
  controls,
})
export class MediaRegistry {
  constructor(
    private ai: AIConfiguration,
    private third: ThirdPartyInferenceService,
    private settings: () => MediaSettings,
    private native?: (ctx: RouteContext) => Promise<MediaAdapter[]>,
    private enabled: (provider: 'cursor' | 'cloud' | 'third-party', id: string) => boolean = () => true,
  ) {}
  async discover(ctx: RouteContext): Promise<Discovery> {
    const adapters: MediaAdapter[] = [],
      notices: string[] = []
    const settings = this.settings(),
      signal = AbortSignal.timeout(12000)
    const checks: Promise<void>[] = []
    const check = (label: string, fn: () => Promise<void>) =>
      checks.push(
        fn().catch(() => {
          notices.push(label + ' capability check failed. Check the connection in AI Settings.')
        }),
      )
    if (settings.localEnabled)
      check('ComfyUI', async () => {
        const routes = await discoverComfy(settings, signal)
        adapters.push(...routes)
        if (settings.workflows.length && !routes.length)
          notices.push('ComfyUI has no matching installed workflow, model files, and device memory.')
      })
    if (!ctx.offline) {
      if (this.native && this.enabled('cursor', 'cursor'))
        check('Selected native tool', async () => {
          adapters.push(...(await this.native!(ctx)))
        })
    }
    if (!ctx.offline && !ctx.includedOnly) {
      check('OpenAI API', async () => {
        if (!this.enabled('cloud', 'openai-api')) return
        const key = await this.ai.mediaCredential()
        if (!key) return
        const account = createHash('sha256').update(key).digest('hex').slice(0, 16)
        const call: MediaFetch = async (path, init) => {
          if (!this.enabled('cloud', 'openai-api') || (await this.ai.mediaCredential()) !== key)
            throw new MediaFailure('The authorized OpenAI API account changed.')
          const headers = new Headers(init.headers)
          headers.set('Authorization', 'Bearer ' + key)
          return fetch('https://api.openai.com/v1' + path, {
            ...init,
            headers,
            redirect: 'error',
          })
        }
        const models = z
          .object({ data: z.array(z.object({ id: z.string() })) })
          .parse(await readJson(await call('/models', { signal }), signal, true))
          .data.map((m) => m.id)
        for (const model of openAIImageModels.filter((m) => models.includes(m))) {
          const modern = model.startsWith('gpt-image-2.6-')
          const base = labels(
            'OpenAI Images',
            'openai-' + account,
            model,
            'api',
            modern ? ['image', 'edit-image', 'gif'] : ['image', 'edit-image'],
            [
              'format',
              'count',
              'size',
              'quality',
              ...(model === 'gpt-image-2' ? [] : ['transparent' as const]),
            ],
          )
          adapters.push(imageAdapter(base, call, 'images'))
          if (
            ctx.selected === 'cloud' &&
            ctx.model &&
            models.includes(ctx.model) &&
            responseImageHosts.has(ctx.model)
          ) {
            adapters.push(
              imageAdapter(
                {
                  ...base,
                  id: base.id + ':responses:' + ctx.model,
                  connection: 'cloud',
                  provider: 'OpenAI Responses',
                  native: true,
                  operations: ['image', 'edit-image'],
                  controls: ['size', 'quality', 'format'],
                },
                call,
                'responses',
                ctx.model,
              ),
            )
          }
        }
      })
      const profiles = await this.third.list().catch(() => {
        notices.push(
          'Third-Party Inference profiles could not be loaded. Other discovered routes remain available.',
        )
        return []
      })
      for (const p of profiles.filter((p) => p.enabled && this.enabled('third-party', p.id))) {
        check(p.name, async () => {
          const endpoint = this.third.endpointForProvider(p)
          const officialXai = endpoint === 'https://api.x.ai/v1'
          const custom = settings.custom.filter((c) => c.connection === p.id)
          if (!officialXai && !['gemini', 'vertex'].includes(p.provider) && !custom.length) return
          const keyMaterial = await this.third.secretsForProvider(p.id)
          const signingIdentity = (value: typeof keyMaterial) =>
            createHash('sha256')
              .update(JSON.stringify([p.id, endpoint, p.projectId, p.region, p.auth, value]))
              .digest('hex')
              .slice(0, 20)
          const fingerprint = signingIdentity(keyMaterial)
          const checkProfile = async () => {
            const current = (await this.third.list()).find((c) => c.id === p.id)
            if (
              !current?.enabled ||
              !this.enabled('third-party', p.id) ||
              this.third.endpointForProvider(current) !== endpoint ||
              current.auth !== p.auth ||
              current.projectId !== p.projectId ||
              current.region !== p.region ||
              signingIdentity(await this.third.secretsForProvider(p.id)) !== fingerprint
            )
              throw new MediaFailure('The original media connection is no longer authorized.')
          }
          const call: MediaFetch = async (path, init) => {
            await checkProfile()
            if (!path.startsWith('/') || path.startsWith('//'))
              throw new MediaFailure('Invalid endpoint path.')
            return this.third.fetchForProvider(p, endpoint + path, init)
          }
          const connection = p.id,
            start = adapters.length,
            ids = p.models.filter((m) => m.enabled).map((m) => m.id)
          if (officialXai) {
            if (ctx.selected === connection && ctx.model === 'grok-4.7' && ids.includes(ctx.model)) {
              const native = {
                ...labels(p.name, connection, ctx.model, 'api', ['image', 'edit-image'], []),
                native: true,
              }
              adapters.push(imageAdapter(native, call, 'xai-native', ctx.model))
            }
            const listing = z.object({
              models: z.array(
                z.object({
                  id: z.string(),
                  input_modalities: z.array(z.string()).optional(),
                }),
              ),
            })
            const [imageModels, videoModels] = await Promise.all(
              ['/image-generation-models', '/video-generation-models'].map(
                async (path) =>
                  listing.parse(await readJson(await call(path, { signal }), signal, true)).models,
              ),
            )
            for (const model of new Set([...imageModels, ...videoModels].map((m) => m.id))) {
              const image = imageModels.find((m) => m.id === model)
              if (image)
                adapters.push(
                  imageAdapter(
                    labels(
                      p.name,
                      connection,
                      model,
                      'api',
                      image.input_modalities?.includes('image') ||
                        [
                          'grok-imagine-image-2.0',
                          'grok-imagine-image',
                          'grok-imagine-image-quality',
                        ].includes(model)
                        ? ['image', 'edit-image']
                        : ['image'],
                      ['aspect', 'count'],
                    ),
                    call,
                    'xai',
                  ),
                )
              if (videoModels.some((m) => m.id === model)) {
                const base = labels(
                  p.name,
                  connection,
                  model,
                  'api',
                  videoModels.find((m) => m.id === model)?.input_modalities?.includes('image') ||
                    ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video'].includes(
                      model,
                    )
                    ? ['video', 'animate']
                    : ['video'],
                  ['duration', 'aspect', 'resolution'],
                )
                const download = async (raw: string, s: AbortSignal) => {
                  const u = new URL(raw)
                  if (u.protocol !== 'https:' || !/(^|\.)x\.ai$/.test(u.hostname) || u.username || u.password)
                    throw new MediaFailure('xAI returned an unverified download origin.')
                  const r = await fetch(u, { signal: s, redirect: 'error' })
                  if (!r.ok) throw new MediaFailure('The temporary xAI video could not be downloaded.')
                  const bytes = await readResponseBytes(r, 100 * 1024 * 1024, s)
                  return { bytes, mime: mediaMime(bytes) }
                }
                adapters.push(xaiVideo(base, call, download))
                if (model === 'grok-imagine-video') {
                  adapters.push(
                    xaiVideo(
                      {
                        ...base,
                        id: base.id + ':editing',
                        operations: ['edit-video'],
                        controls: [],
                      },
                      call,
                      download,
                    ),
                    xaiVideo(
                      {
                        ...base,
                        id: base.id + ':extension',
                        operations: ['extend-video'],
                        controls: ['duration'],
                      },
                      call,
                      download,
                    ),
                  )
                }
              }
            }
          }
          if (
            p.provider === 'gemini' &&
            p.credentialConfigured &&
            (!p.baseUrl || endpoint === 'https://generativelanguage.googleapis.com/v1beta')
          ) {
            const key = keyMaterial.apiKey
            if (!key) return
            const googleCall: MediaFetch = async (path, init) => {
              await checkProfile()
              if ((await this.third.secretsForProvider(p.id)).apiKey !== key)
                throw new MediaFailure('The original Google account changed.')
              const headers = new Headers(init.headers)
              headers.set('x-goog-api-key', key)
              return fetch('https://generativelanguage.googleapis.com/v1beta' + path, {
                ...init,
                headers,
                redirect: 'error',
              })
            }
            const discovered = z
              .object({ models: z.array(z.object({ name: z.string() })) })
              .parse(await readJson(await googleCall('/models?pageSize=1000', { signal }), signal, true))
              .models.map((m) => m.name.replace(/^models\//, ''))
            for (const model of [...geminiImageModels, 'gemini-omni-1.2-flash'].filter((m) =>
              discovered.includes(m),
            )) {
              const video = model === 'gemini-omni-1.2-flash'
              adapters.push(
                googleInteraction(
                  {
                    ...labels(
                      p.name,
                      connection,
                      model,
                      'api',
                      video ? ['video', 'animate', 'edit-video', 'extend-video'] : ['image', 'edit-image'],
                      video ? ['duration', 'aspect', 'resolution'] : ['aspect'],
                    ),
                    ...(video
                      ? {
                          values: {
                            duration: Array.from({ length: 13 }, (_, i) => i + 3),
                            resolution: ['720p', '1080p'],
                            aspect: ['16:9', '9:16'],
                          },
                        }
                      : {}),
                    native: model === ctx.model,
                  },
                  googleCall,
                ),
              )
            }
          }
          if (p.provider === 'vertex' && p.auth === 'google-adc' && p.projectId) {
            for (const model of ids.filter((m) => /^veo-3\.1-(?:fast-)?generate-001$/.test(m))) {
              const client = new GoogleGenAI({
                vertexai: true,
                project: p.projectId,
                location: p.region || 'us-central1',
                httpOptions: { retryOptions: { attempts: 1 } },
              })
              const base = labels(
                p.name,
                connection,
                model,
                'api',
                ['video', 'animate', 'extend-video'],
                ['duration', 'resolution', 'aspect', 'audio'],
              )
              adapters.push({
                ...base,
                values: {
                  duration: [4, 6, 8],
                  aspect: ['16:9', '9:16'],
                  resolution: ['720p', '1080p'],
                },
                async submit(job, parent, signal) {
                  const o = job.options
                  if (
                    (o.duration && ![4, 6, 8].includes(o.duration)) ||
                    o.aspect === '1:1' ||
                    o.resolution === '480p'
                  )
                    throw new MediaFailure(
                      'Veo requires 4, 6, or 8 seconds, widescreen or portrait, and at least 720p.',
                      true,
                    )
                  const data = parent && Buffer.from(parent.bytes).toString('base64')
                  await checkProfile()
                  const op = await client.models.generateVideos({
                    model,
                    prompt: job.prompt,
                    ...(parent && data
                      ? parent.mime.startsWith('image/')
                        ? { image: { imageBytes: data, mimeType: parent.mime } }
                        : { video: { videoBytes: data, mimeType: parent.mime } }
                      : {}),
                    config: {
                      abortSignal: signal,
                      numberOfVideos: 1,
                      durationSeconds: o.duration,
                      generateAudio: o.audio ?? true,
                      aspectRatio: o.aspect,
                      resolution: o.resolution,
                    },
                  })
                  if (!op.name) throw new MediaFailure('Google did not return a video operation ID.')
                  return { remoteId: op.name }
                },
                async poll(id, signal) {
                  if (
                    !id.startsWith('projects/' + p.projectId + '/locations/') ||
                    !id.includes('/models/' + model + '/operations/')
                  )
                    throw new MediaFailure('The saved Veo job does not match this project and model.')
                  await checkProfile()
                  const operation = new GenerateVideosOperation()
                  operation.name = id
                  const r = await client.operations.getVideosOperation({
                    operation,
                    config: { abortSignal: signal },
                  })
                  if (!r.done) return { remoteId: id }
                  if (r.error || r.response?.raiMediaFilteredCount)
                    throw new MediaFailure('Google reported a failed or filtered video job.')
                  return {
                    files: (r.response?.generatedVideos ?? []).map((v) => {
                      if (!v.video?.videoBytes)
                        throw new MediaFailure('Google did not return inline video bytes.')
                      return {
                        bytes: Buffer.from(v.video.videoBytes, 'base64'),
                        mime: 'video/mp4',
                      }
                    }),
                  }
                },
              })
            }
          }
          for (const c of custom) {
            const base = labels(
              p.name,
              connection,
              c.model,
              'api',
              c.protocol === 'images' ? ['image', 'edit-image'] : ['video', 'animate'],
              c.protocol === 'images'
                ? ['size', 'quality', 'count', 'format']
                : ['duration', 'aspect', 'resolution'],
            )
            if (c.protocol === 'images') adapters.push(imageAdapter(base, call, 'images'))
            else
              adapters.push(
                xaiVideo(base, call, async (raw, s) => {
                  const url = new URL(raw, endpoint)
                  if (url.origin !== new URL(endpoint).origin || url.username || url.password)
                    throw new MediaFailure('Custom video download must use the configured origin.')
                  const r = await this.third.fetchForProvider(p, url, {
                    signal: s,
                  })
                  if (!r.ok) throw new MediaFailure('Custom video download failed.')
                  const bytes = await readResponseBytes(r, 100 * 1024 * 1024, s)
                  return { bytes, mime: mediaMime(bytes) }
                }),
              )
          }
          for (const adapter of adapters.slice(start))
            if (adapter.connection === p.id) adapter.id += ':' + fingerprint
        })
      }
    }
    await Promise.all(checks)
    if (ctx.selected === 'subscription')
      notices.push(
        'Sign in with ChatGPT: the current authenticated interface excludes hosted image generation and documents no video-generation tool. ChatGPT app entitlements do not grant API access. Configure a separate authorized generation endpoint.',
      )
    return {
      adapters: [...new Map(adapters.map((a) => [a.id, a])).values()],
      notices,
    }
  }
}
