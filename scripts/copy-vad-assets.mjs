import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'public', 'vad-assets')
const assets = [
  ['node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', 'vad.worklet.bundle.min.js'],
  ['node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'silero_vad_v5.onnx'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
]

await mkdir(target, { recursive: true })
for (const [source, destination] of assets) {
  const from = join(root, source), to = join(target, destination)
  const original = await readFile(from)
  const existing = await readFile(to).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  // Avoid a spurious dev-server reload every time a production build starts.
  if (!existing?.equals(original)) await copyFile(from, to)
}
