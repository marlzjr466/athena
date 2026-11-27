import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isVideoOperation, type MediaSettings } from '../../../shared/mediaGeneration'
import { jsonPost, mediaMime, MediaFailure, readJson, safeJobId, type MediaAdapter } from './protocols'
import { readResponseBytes } from '../ai/responseBody'

// Local-only routes accept installed inference and output nodes. Partner API
// nodes, arbitrary extensions, file-loading scripts, and model downloaders
// cannot acquire the "local" billing classification.
const localNodes = new Set(
  'CheckpointLoaderSimple UNETLoader VAELoader CLIPLoader DualCLIPLoader TripleCLIPLoader LoraLoader CLIPTextEncode CLIPTextEncodeFlux FluxGuidance ConditioningZeroOut ConditioningCombine EmptyLatentImage EmptySD3LatentImage EmptyHunyuanLatentVideo EmptyLTXVLatentVideo LTXVConditioning LTXVImgToVideo LTXVScheduler WanImageToVideo WanFirstLastFrameToVideo KSampler KSamplerAdvanced VAEDecode VAEDecodeTiled VAEEncode ModelSamplingFlux ModelSamplingSD3 RandomNoise BasicGuider CFGGuider BasicScheduler SamplerCustomAdvanced KSamplerSelect LoadImage ImageScale ImageScaleBy SaveImage CreateVideo SaveVideo SaveAnimatedWEBP SaveAnimatedPNG'.split(
    ' ',
  ),
)
const graphSchema = z.record(
  z.string().regex(/^\d+$/),
  z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) }),
)
const infoSchema = z.record(
  z.string(),
  z.object({
    input: z
      .object({
        required: z.record(z.string(), z.unknown()).optional(),
        optional: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
)
const fileSchema = z.object({
  filename: z.string().max(255),
  subfolder: z.string().max(255).default(''),
  type: z.literal('output'),
})
export async function discoverComfy(
  settings: MediaSettings,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<MediaAdapter[]> {
  if (!settings.workflows.length) return []
  const endpoint = 'http://127.0.0.1:' + settings.comfyPort
  const call = (path: string, init: RequestInit) =>
    request(endpoint + path, { ...init, redirect: 'error', credentials: 'omit' })
  const [stats, info] = await Promise.all([
    call('/system_stats', { signal })
      .then((r) => readJson(r, signal, true))
      .then((v) =>
        z
          .object({
            devices: z.array(z.object({ type: z.string(), vram_total: z.number() })),
            system: z.object({ ram_total: z.number().optional() }).optional(),
          })
          .parse(v),
      ),
    call('/object_info', { signal })
      .then((r) => readJson(r, signal))
      .then((v) => infoSchema.parse(v)),
  ])
  return settings.workflows.flatMap((w) => {
    let graph: z.infer<typeof graphSchema>
    try {
      graph = graphSchema.parse(JSON.parse(w.graph))
    } catch {
      return []
    }
    if (
      !stats.devices.some(
        (d) =>
          (d.vram_total || (['cpu', 'mps'].includes(d.type) ? stats.system?.ram_total : 0) || 0) >=
          w.minimumMemoryGB * 1024 ** 3,
      )
    )
      return []
    let promptSlots = 0,
      fileSlots = 0,
      output = false
    for (const n of Object.values(graph)) {
      if (!localNodes.has(n.class_type) || !info[n.class_type]) return []
      const inputs = { ...info[n.class_type].input?.required, ...info[n.class_type].input?.optional }
      for (const [k, v] of Object.entries(n.inputs)) {
        if (v === '$prompt') {
          if (!n.class_type.startsWith('CLIPTextEncode') || !['text', 'clip_l', 't5xxl'].includes(k))
            return []
          promptSlots++
        }
        if (n.class_type === 'LoadImage' && k === 'image') {
          if (v !== '$image') return []
          fileSlots++
        }
        if (k === 'filename_prefix') n.inputs[k] = 'Athena'
        const definition = inputs[k]
        if (
          typeof v === 'string' &&
          Array.isArray(definition) &&
          Array.isArray(definition[0]) &&
          v !== '$image' &&
          !definition[0].includes(v)
        )
          return []
      }
      if (['SaveImage', 'SaveVideo', 'SaveAnimatedWEBP'].includes(n.class_type)) output = true
    }
    if (
      !promptSlots ||
      !output ||
      Boolean(fileSlots) !== ['edit-image', 'animate'].includes(w.operation) ||
      ['edit-video', 'extend-video', 'gif'].includes(w.operation)
    )
      return []
    const id =
      'comfy:' +
      createHash('sha256')
        .update(endpoint + w.name + w.graph + w.operation)
        .digest('hex')
        .slice(0, 32)
    const adapter: MediaAdapter = {
      id,
      provider: 'ComfyUI',
      model: w.name,
      billing: 'local',
      connection: 'comfy',
      operations: [w.operation],
      controls: [],
      async submit(job, parent, signal) {
        let uploaded: string | undefined
        if (parent) {
          const name = randomUUID() + '.' + parent.mime.split('/')[1],
            form = new FormData()
          form.set('image', new Blob([new Uint8Array(parent.bytes)], { type: parent.mime }), name)
          const res = z
            .object({ name: z.literal(name), type: z.literal('input'), subfolder: z.literal('') })
            .parse(
              await readJson(
                await call('/upload/image', { method: 'POST', body: form, signal }),
                signal,
                true,
              ),
            )
          uploaded = res.name
        }
        const prompt = structuredClone(graph)
        for (const node of Object.values(prompt))
          for (const [key, val] of Object.entries(node.inputs)) {
            if (val === '$prompt') node.inputs[key] = job.prompt
            if (val === '$image') node.inputs[key] = uploaded
          }
        const res = z
          .object({ prompt_id: safeJobId })
          .parse(await readJson(await call('/prompt', jsonPost({ prompt }, signal)), signal, true))
        return { remoteId: res.prompt_id }
      },
      async poll(id, signal) {
        const hist = z
          .record(
            z.string(),
            z.object({
              status: z.object({ completed: z.boolean(), status_str: z.string() }),
              outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
            }),
          )
          .parse(await readJson(await call('/history/' + safeJobId.parse(id), { signal }), signal, true))
        const entry = hist[id]
        if (entry?.status.status_str === 'error')
          throw new MediaFailure('ComfyUI reported an execution error. Check its workflow and device memory.')
        if (!entry?.status.completed) return { remoteId: id }
        const outputs = Object.values(entry.outputs).flatMap((node) =>
          Object.values(node).flatMap((value) => (Array.isArray(value) ? value : [])),
        )
        const files = []
        for (const output of outputs.slice(0, 8)) {
          const parsed = fileSchema.safeParse(output)
          if (!parsed.success) continue
          const f = parsed.data
          if (
            /[\\/\0]/.test(f.filename) ||
            f.subfolder.split(/[\\/]/).some((s) => s === '..') ||
            f.subfolder.startsWith('/')
          )
            throw new MediaFailure('Unsafe ComfyUI output path.')
          const res = await call('/view?' + new URLSearchParams(f), { signal })
          if (!res.ok) throw new MediaFailure('Unable to retrieve ComfyUI output.')
          const bytes = await readResponseBytes(res, 100 * 1024 * 1024, signal),
            mime = mediaMime(bytes)
          if (mime.startsWith(isVideoOperation(w.operation) ? 'video/' : 'image/'))
            files.push({ bytes, mime })
        }
        return { files }
      },
    }
    return [adapter]
  })
}
