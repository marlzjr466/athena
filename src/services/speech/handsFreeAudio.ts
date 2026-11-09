import type { AthenaAPI } from '../../../shared/contracts'
import type { AIOwnership } from '../../../shared/aiOwnership'
import type { HandsFreeSpeechResult } from '../../../shared/handsFree'

/** One text segment may contain many actual CSM audio chunks. No provider fallback. */
export async function* handsFreeAudio(api: Pick<AthenaAPI, 'speakHandsFree' | 'nextHandsFreeSpeech'>, request: { id: string; text: string; ownership?: AIOwnership; cache?: boolean }, valid: () => boolean): AsyncGenerator<HandsFreeSpeechResult & { generationMs: number }> {
  let index = 0
  while (valid()) {
    const started = performance.now()
    const result = index === 0 ? await api.speakHandsFree(request) : request.ownership ? await api.nextHandsFreeSpeech({ id: request.id, index, ownership: request.ownership }) : { ok: false, message: 'Local voice ownership expired.' }
    if (!valid() || result.done) return
    if (result.id && result.id !== request.id) throw new Error('Mismatched speech response')
    if (result.streaming && (result.index !== index || index >= 999)) throw new Error('Invalid audio chunk sequence')
    yield { ...result, generationMs: performance.now() - started }
    if (!result.ok || !result.streaming) return
    index++
  }
}
