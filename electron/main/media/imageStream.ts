import { Stream } from 'openai/core/streaming'
import { z } from 'zod'
import { mediaMime, MediaFailure, type MediaFile, type MediaResult } from './protocols'

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
})
export const imageUsage = (value: unknown) => usageSchema.safeParse(value).data
export async function consumeImageStream(
  response: Response,
  signal: AbortSignal,
  preview: (file: MediaFile) => Promise<void>,
): Promise<MediaResult> {
  const cancel = new AbortController(),
    abort = () => cancel.abort()
  signal.addEventListener('abort', abort, { once: true })
  const files: MediaFile[] = []
  let usage: MediaResult['usage']
  // Bound the raw response before the SSE parser buffers a whole event.
  let total = 0
  const body = response.body?.pipeThrough(
    new TransformStream({
      transform(chunk: Uint8Array, controller) {
        total += chunk.length
        if (total > 160 * 1024 * 1024) throw new MediaFailure('Image stream exceeds the local media limit.')
        controller.enqueue(chunk)
      },
    }),
  )
  if (!body) throw new MediaFailure('The endpoint returned an empty image stream.')
  try {
    signal.throwIfAborted()
    for await (const raw of Stream.fromSSEResponse<unknown>(
      new Response(body, { headers: response.headers }),
      cancel,
    )) {
      signal.throwIfAborted()
      const e = z
        .object({
          type: z.string(),
          b64_json: z.string().optional(),
          partial_image_b64: z.string().optional(),
          usage: usageSchema.optional(),
          response: z
            .object({
              status: z.string(),
              output: z
                .array(
                  z.object({
                    type: z.string(),
                    result: z.string().optional(),
                    revised_prompt: z.string().optional(),
                  }),
                )
                .optional(),
              usage: usageSchema.optional(),
            })
            .optional(),
        })
        .parse(raw)
      const file = (data: string, revisedPrompt?: string) => {
        const bytes = Buffer.from(data, 'base64')
        return { bytes, mime: mediaMime(bytes), revisedPrompt }
      }
      if (
        [
          'image_edit.partial_image',
          'image_generation.partial_image',
          'response.image_generation_call.partial_image',
        ].includes(e.type)
      ) {
        const b64 = e.b64_json ?? e.partial_image_b64
        if (b64) await preview(file(b64))
      } else if (['image_edit.completed', 'image_generation.completed'].includes(e.type) && e.b64_json) {
        files.push(file(e.b64_json))
        usage = e.usage
      } else if (e.type === 'response.completed' && e.response?.status === 'completed') {
        for (const item of e.response.output ?? [])
          if (item.type === 'image_generation_call' && item.result)
            files.push(file(item.result, item.revised_prompt))
        usage = e.response.usage
      } else if (['error', 'response.failed', 'response.incomplete'].includes(e.type))
        throw new MediaFailure('The provider reported a failed or incomplete image stream.')
      if (files.length) return { files, usage }
    }
    throw new MediaFailure('The image stream ended before its completion event.')
  } finally {
    signal.removeEventListener('abort', abort)
    cancel.abort()
  }
}
