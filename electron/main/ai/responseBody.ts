// Bound downloads after headers as well as before them. SDK request deadlines
// need not cover a streamed response body that the caller reads itself.
export async function readResponseBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new Error('Missing response body')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0, complete = false
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) { complete = true; break }
      size += chunk.value.byteLength
      if (size > limit) throw new Error('Response body exceeds limit')
      chunks.push(chunk.value)
    }
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) { try { await reader.cancel() } catch { /* Failed stream is discarded. */ } }
    reader.releaseLock()
  }
}
