import type { Settings } from '../../../shared/settings'

export function wakeAcknowledgementCacheKey(settings: Settings, text: string): string {
  return `wake-ack:v4:${JSON.stringify({
    engine: settings.localVoice.engine,
    profileId: settings.localVoice.profileId,
    style: settings.localVoice.style,
    expressiveness: settings.localVoice.expressiveness,
    speed: settings.voiceSpeed,
    text,
  })}`
}
