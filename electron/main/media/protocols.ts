import { consumeImageStream, imageUsage } from './imageStream'
import { z } from 'zod'
import { readResponseBytes } from '../ai/responseBody'
import type { MediaCapability, MediaJob } from '../../../shared/mediaGeneration'

export interface MediaFile {
  mime: string
  bytes: Uint8Array
  revisedPrompt?: string
}
export interface MediaResult {
  files?: MediaFile[]
  remoteId?: string
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  actualCostUSD?: number
}
export interface MediaAdapter extends MediaCapability {
  estimate?(job: MediaJob): number | undefined
  submit(
    job: MediaJob,
    parent: MediaFile | undefined,
    signal: AbortSignal,
    preview?: (file: MediaFile) => Promise<void>,
  ): Promise<MediaResult>
  cancel?(id: string, signal: AbortSignal): Promise<boolean>
  poll?(id: string, signal: AbortSignal): Promise<MediaResult>
}
// Eligible only when the endpoint explicitly rejected submission. Failures after
// acceptance, transport exceptions, and content-policy decisions never reroute.
export class MediaFailure extends Error {
  constructor(
    message: string,
    readonly rejected = false,
  ) {
    super(message)
  }
}
export type MediaFetch = (path: string, init: RequestInit) => Promise<Response>
const maxBytes = 100 * 1024 * 1024
export const jsonPost = (body: unknown, signal: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal,
  redirect: 'error',
})
export async function readJson(response: Response, signal: AbortSignal, small = false): Promise<unknown> {
  const bytes = await readResponseBytes(
    response,
    response.ok && !small ? Math.ceil(maxBytes * 1.4) : 4 * 1024 * 1024,
    signal,
  )
  let body
  try {
    body = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    /* HTTP status still matters. */
  }
  if (!response.ok) {
    const code = String(body?.error?.code ?? body?.code ?? '')
    if (
      /safety|moderation|content.policy|blocked|content.filter|responsible.ai/i.test(
        [code, body?.error?.type, body?.error?.message, body?.message]
          .filter((x) => typeof x === 'string')
          .join(' '),
      ) ||
      response.status === 403
    )
      throw new MediaFailure('The provider blocked this request. Review its access and content policies.')
    if (response.status === 401)
      throw new MediaFailure('The endpoint rejected its credential. Reconnect that account.', true)
    if (response.status === 402 || code === 'insufficient_quota')
      throw new MediaFailure(
        'The endpoint declined the request because its available allowance is exhausted.',
        true,
      )
    if (response.status === 429)
      throw new MediaFailure('The endpoint rejected the request at its rate limit.', true)
    if (response.status === 404)
      throw new MediaFailure('The model or generation endpoint is unavailable.', true)
    throw new MediaFailure(
      `The generation endpoint returned HTTP ${response.status}. Review the request in your provider dashboard before submitting again.`,
    )
  }
  if (!body)
    throw new MediaFailure(
      'The provider returned an unreadable response. Check the provider before submitting again.',
    )
  return body
}
function decoded(data: string, mime: string, revisedPrompt?: string): MediaFile {
  if (!data || data.length > Math.ceil((maxBytes * 4) / 3) + 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data))
    throw new MediaFailure('The provider returned invalid encoded media.')
  return { bytes: Buffer.from(data, 'base64'), mime, revisedPrompt }
}
export function mediaMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (b.length >= 10 && /^GIF8[79]a/.test(b.toString('ascii', 0, 6))) return 'image/gif'
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp'
  if (b.length >= 16 && b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  if (b.length >= 8 && b.readUInt32BE(0) === 0x1a45dfa3 && b.subarray(0, 4096).includes(Buffer.from('webm')))
    return 'video/webm'
  throw new MediaFailure('The returned file has an unsupported or invalid media signature.')
}
const uri = (f: MediaFile) => `data:${f.mime};base64,${Buffer.from(f.bytes).toString('base64')}`
export const safeJobId = z.string().regex(/^[a-zA-Z0-9_-]{1,220}$/)
export const openAIImageModels = [
  'gpt-image-2.6-flare',
  'gpt-image-2.6-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1-mini',
]
export const geminiImageModels = [
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gemini-2.5-flash-image',
]
export function imageAdapter(
  base: MediaCapability,
  call: MediaFetch,
  kind: 'images' | 'xai' | 'responses' | 'xai-native',
  mainModel?: string,
): MediaAdapter {
  return {
    ...base,
    estimate:
      kind === 'xai' && base.model === 'grok-imagine-image-2.0'
        ? (j) => 0.06 * (j.options.count ?? 1) + (j.parentId ? 0.01 : 0)
        : undefined,
    async submit(job, parent, signal, preview) {
      const stream =
        !!preview &&
        (kind === 'responses' || base.provider === 'OpenAI Images') &&
        job.operation !== 'gif' &&
        (job.options.count ?? 1) === 1
      const receive = async (response: Response) => {
        if (
          stream &&
          preview &&
          response.ok &&
          response.headers.get('content-type')?.includes('text/event-stream')
        )
          return { streamed: await consumeImageStream(response, signal, preview) }
        return { json: await readJson(response, signal) }
      }
      const format = job.operation === 'gif' ? 'gif' : (job.options.format ?? 'png')
      const options = {
        size: job.options.size,
        quality: job.options.quality,
        output_format: format,
        background: job.options.transparent ? 'transparent' : undefined,
      }
      if (kind === 'responses' || kind === 'xai-native') {
        const input = [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: job.prompt },
              ...(parent ? [{ type: 'input_image', image_url: uri(parent) }] : []),
            ],
          },
        ]
        const bodyToSend =
          kind === 'xai-native'
            ? {
                model: mainModel,
                input,
                tools: [{ type: 'image_generation', action: parent ? 'edit' : 'generate' }],
              }
            : {
                model: mainModel,
                store: false,
                input,
                ...(stream ? { stream: true } : {}),
                tools: [
                  {
                    type: 'image_generation',
                    model: base.model,
                    ...options,
                    ...(stream ? { partial_images: 2 } : {}),
                  },
                ],
                tool_choice: { type: 'image_generation' },
              }
        const received = await receive(await call('/responses', jsonPost(bodyToSend, signal)))
        if (received.streamed) return received.streamed
        const body = received.json
        const result = z
          .object({
            usage: z.unknown().optional(),
            status: z.literal('completed'),
            output: z.array(
              z.object({
                type: z.string(),
                result: z.string().nullish(),
                revised_prompt: z.string().optional(),
              }),
            ),
          })
          .parse(body)
        return {
          usage: imageUsage(result.usage),
          files: result.output
            .filter((x) => x.type === 'image_generation_call' && x.result)
            .map((x) => {
              const file = decoded(x.result!, 'image/' + format, x.revised_prompt)
              if (kind === 'xai-native') file.mime = mediaMime(file.bytes)
              return file
            }),
        }
      }
      let post: RequestInit
      if (kind === 'xai') {
        post = jsonPost(
          {
            model: base.model,
            prompt: job.prompt,
            response_format: 'b64_json',
            n: job.options.count,
            aspect_ratio: job.options.aspect,
            ...(parent ? { image: { url: uri(parent), type: 'image_url' } } : {}),
          },
          signal,
        )
      } else if (parent) {
        const form = new FormData()
        for (const [k, v] of Object.entries({
          model: base.model,
          prompt: job.prompt,
          n: job.options.count,
          ...options,
        }))
          if (v !== undefined) form.set(k, String(v))
        if (stream) {
          form.set('stream', 'true')
          form.set('partial_images', '2')
        }
        form.set(
          'image',
          new Blob([new Uint8Array(parent.bytes)], { type: parent.mime }),
          'source.' + parent.mime.split('/')[1],
        )
        post = { method: 'POST', body: form, signal, redirect: 'error' }
      } else
        post = jsonPost(
          {
            model: base.model,
            prompt: job.prompt,
            n: job.options.count,
            ...options,
            ...(stream ? { stream: true, partial_images: 2 } : {}),
          },
          signal,
        )
      const received = await receive(await call(parent ? '/images/edits' : '/images/generations', post))
      if (received.streamed) return received.streamed
      const body = received.json
      const data = z
        .object({
          usage: z.unknown().optional(),
          data: z
            .array(
              z.object({
                b64_json: z.string(),
                revised_prompt: z.string().optional(),
                respect_moderation: z.boolean().optional(),
              }),
            )
            .nonempty()
            .max(4),
        })
        .parse(body)
      if (data.data.some((row) => row.respect_moderation === false))
        throw new MediaFailure('Image output was blocked by provider moderation.')
      return {
        usage: imageUsage(data.usage),
        files: data.data.map((row) => {
          const file = decoded(row.b64_json, 'image/' + format, row.revised_prompt)
          if (kind === 'xai') file.mime = mediaMime(file.bytes)
          return file
        }),
      }
    },
  }
}
export function xaiVideo(
  base: MediaCapability,
  call: MediaFetch,
  download: (url: string, signal: AbortSignal) => Promise<MediaFile>,
): MediaAdapter {
  return {
    ...base,
    async submit(job, parent, signal) {
      const editing = job.operation === 'edit-video',
        extending = job.operation === 'extend-video'
      const path = editing ? '/videos/edits' : extending ? '/videos/extensions' : '/videos/generations'
      const payload = {
        model: base.model,
        prompt: job.prompt,
        duration: job.options.duration,
        aspect_ratio: job.options.aspect,
        resolution: job.options.resolution,
        ...(parent ? { [parent.mime.startsWith('video/') ? 'video' : 'image']: { url: uri(parent) } } : {}),
      }
      const result = z
        .object({ request_id: safeJobId })
        .parse(await readJson(await call(path, jsonPost(payload, signal)), signal, true))
      return { remoteId: result.request_id }
    },
    async poll(id, signal) {
      const r = z
        .object({
          status: z.string(),
          video: z
            .object({ url: z.string().optional(), respect_moderation: z.boolean().optional() })
            .optional(),
        })
        .parse(await readJson(await call('/videos/' + safeJobId.parse(id), { signal }), signal, true))
      if (r.status === 'pending' || r.status === 'processing' || r.status === 'queued')
        return { remoteId: id }
      if (r.status !== 'done' || !r.video?.url || r.video.respect_moderation === false)
        throw new MediaFailure('The video job failed, expired, or was filtered. No video was delivered.')
      return { files: [await download(r.video.url, signal)] }
    },
  }
}
export function googleInteraction(base: MediaCapability, call: MediaFetch): MediaAdapter {
  const parse = (raw: unknown): MediaResult => {
    const part = z.object({
      type: z.string(),
      mime_type: z.string().optional(),
      data: z.string().optional(),
      uri: z.string().optional(),
    })
    const response = z
      .object({
        id: safeJobId,
        status: z.string(),
        steps: z.array(z.object({ type: z.string(), content: z.array(part).optional() })).optional(),
        output_image: part.optional(),
        output_video: part.optional(),
      })
      .parse(raw)
    if (['in_progress', 'queued'].includes(response.status)) return { remoteId: response.id }
    if (response.status !== 'completed')
      throw new MediaFailure('Google did not complete this media interaction.')
    const parts =
      response.steps
        ?.filter((s) => s.type === 'model_output')
        .flatMap((s) => s.content ?? [])
        .filter((p) => ['image', 'video'].includes(p.type) && (p.data || p.uri)) ?? []
    if (!parts.length) {
      const output = response.output_image ?? response.output_video
      if (output) parts.push(output)
    }
    if (parts[0]?.uri && !parts[0].data) {
      const match =
        /^(?:https:\/\/generativelanguage\.googleapis\.com\/v1beta\/)?files\/([A-Za-z0-9_-]+)$/.exec(
          parts[0].uri,
        )
      if (!match) throw new MediaFailure('Google returned an unrecognized media file location.')
      return { remoteId: 'file:' + safeJobId.parse(match[1]) }
    }
    return {
      files: parts.map((p) =>
        decoded(p.data ?? '', p.mime_type ?? (p.type === 'video' ? 'video/mp4' : 'image/png')),
      ),
    }
  }
  return {
    ...base,
    async submit(job, parent, signal) {
      const video = base.model === 'gemini-omni-1.2-flash'
      const input = [
        { type: 'text', text: job.prompt },
        ...(parent
          ? [
              {
                type: parent.mime.split('/')[0],
                mime_type: parent.mime,
                data: Buffer.from(parent.bytes).toString('base64'),
              },
            ]
          : []),
      ]
      if (
        video &&
        job.options.duration &&
        (job.options.duration < 3 || (job.operation === 'extend-video' && job.options.duration > 10))
      )
        throw new MediaFailure('Omni supports 3–15 seconds, or up to 10 seconds per extension.', true)
      const post = jsonPost(
        {
          model: base.model,
          input: [{ type: 'user_input', content: input }],
          response_format: {
            type: video ? 'video' : 'image',
            aspect_ratio: job.options.aspect,
            ...(video
              ? {
                  delivery: 'uri',
                  resolution: job.options.resolution,
                  duration: job.options.duration ? job.options.duration + 's' : undefined,
                }
              : {}),
          },
          ...(video ? { background: true } : {}),
        },
        signal,
      )
      return parse(
        await readJson(
          await call('/interactions', {
            ...post,
            headers: { ...post.headers, 'Api-Revision': '2026-05-20' },
          }),
          signal,
        ),
      )
    },
    async cancel(id, signal) {
      if (id.startsWith('file:')) return false
      const reply = z
        .object({ id: safeJobId, status: z.string() })
        .parse(
          await readJson(
            await call('/interactions/' + safeJobId.parse(id) + '/cancel', {
              method: 'POST',
              signal,
              headers: { 'Api-Revision': '2026-05-20' },
            }),
            signal,
            true,
          ),
        )
      return reply.id === id && ['cancelled', 'canceled'].includes(reply.status)
    },
    async poll(id, signal) {
      if (id.startsWith('file:')) {
        const path = '/files/' + safeJobId.parse(id.slice(5))
        const file = z
          .object({ state: z.string() })
          .parse(await readJson(await call(path, { signal }), signal, true))
        if (file.state === 'PROCESSING') return { remoteId: id }
        if (file.state !== 'ACTIVE') throw new MediaFailure('Google could not prepare the generated file.')
        const response = await call(path + ':download?alt=media', { signal })
        if (!response.ok) throw new MediaFailure('Google could not deliver the generated file.')
        const bytes = await readResponseBytes(response, maxBytes, signal)
        return { files: [{ bytes, mime: mediaMime(bytes) }] }
      }
      return parse(
        await readJson(
          await call('/interactions/' + safeJobId.parse(id), {
            signal,
            headers: { 'Api-Revision': '2026-05-20' },
          }),
          signal,
        ),
      )
    },
  }
}
