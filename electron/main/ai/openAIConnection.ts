import { z } from 'zod'
import { modelIdSchema } from '../../../shared/ai'
import { billingErrorMessage } from './apiErrors'
import { readResponseBytes } from './responseBody'

export type ConnectionResult = { ok: true; models: string[] } | { ok: false; kind: 'invalid-key' | 'failed'; message: string }
export interface ConnectionTester { test(apiKey: string): Promise<ConnectionResult> }
const modelsSchema = z.object({ object: z.literal('list'), data: z.array(z.object({ id: modelIdSchema })).max(2000) })

export class OpenAIConnection implements ConnectionTester {
  constructor(private request: typeof fetch = (...args) => fetch(...args)) {}
  async test(apiKey: string): Promise<ConnectionResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.request('https://api.openai.com/v1/models', {
        method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
      })
      if (!response.ok) {
        let code: string | undefined
        if (response.status === 429) {
          try { const data = JSON.parse(new TextDecoder().decode(await readResponseBytes(response, 32_768, controller.signal))); if (typeof data?.error?.code === 'string') code = data.error.code } catch { /* Untrusted errors are never returned. */ }
        } else await response.body?.cancel()
        if (response.status === 401) return { ok: false, kind: 'invalid-key', message: 'Invalid API key. Check the key or replace it.' }
        const message = billingErrorMessage(code) ?? (response.status === 403 ? 'Connection failed. This key needs permission to list models.'
          : response.status === 429 ? 'Connection failed. OpenAI rate limit reached; try again later.'
          : 'Connection failed. OpenAI is unavailable; try again later.')
        return { ok: false, kind: 'failed', message }
      }
      const parsed = modelsSchema.safeParse(JSON.parse(new TextDecoder().decode(await readResponseBytes(response, 2 * 1024 * 1024, controller.signal))))
      if (!parsed.success) return { ok: false, kind: 'failed', message: 'Connection failed. OpenAI returned an unexpected response.' }
      const models = [...new Set(parsed.data.data.map(({ id }) => id).filter((id) => !id.includes(apiKey)))].sort()
      return { ok: true, models }
    } catch {
      return { ok: false, kind: 'failed', message: controller.signal.aborted ? 'Connection failed. The request timed out; try again.' : 'Connection failed. Check your internet connection and try again.' }
    } finally { clearTimeout(timeout) }
  }
}
