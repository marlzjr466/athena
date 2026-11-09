import type { Settings } from '../../../shared/settings'
import { SESAME_WAKE_ACKNOWLEDGEMENT } from '../../../shared/handsFree'
import { ATHENA_CSM_REFERENCE_ID } from '../../../shared/officialCSM'
import { HIGGS_WAKE_ACKNOWLEDGEMENTS } from '../../../shared/higgsTTS'
import { isHiggsEngine, isSesameEngine } from '../../../shared/localVoice'

export function sesameWakeSelected(settings: Settings): boolean {
  return isSesameEngine(settings.localVoice.engine)
}

export function higgsWakeSelected(settings: Settings): boolean {
  return isHiggsEngine(settings.localVoice.engine)
}

export function wakeAcknowledgementCacheKey(settings: Settings, text: string): string {
  // Include the selected CSM/Higgs identity in the cache. A wake clip made
  // with an older reference must never be replayed after the profile changes.
  return `wake-ack:v3:${JSON.stringify({
    engine: settings.localVoice.engine,
    profileId: settings.localVoice.profileId,
    style: settings.localVoice.style,
    expressiveness: settings.localVoice.expressiveness,
    officialCSM: settings.localVoice.officialCSM,
    higgs: settings.localVoice.higgs,
    csmReference: ATHENA_CSM_REFERENCE_ID,
    speed: settings.voiceSpeed,
    text,
  })}`
}

export function shouldWarmSesameWake(settings: Settings): boolean {
  // Generate the one-time clip in the background even before the microphone is
  // enabled. Otherwise the first wake after enabling hands-free pays the full
  // 15+ second CPU model load. Later launches restore the verified WAV cache.
  return sesameWakeSelected(settings) && settings.voiceEnabled
    && !settings.voiceMuted && !settings.doNotDisturb
}

export function shouldWarmLocalWake(settings: Settings): boolean {
  return (sesameWakeSelected(settings) || higgsWakeSelected(settings)) && settings.voiceEnabled
    && !settings.voiceMuted && !settings.doNotDisturb
}

export function warmWakeAcknowledgements(settings: Settings): readonly string[] {
  if (higgsWakeSelected(settings)) return HIGGS_WAKE_ACKNOWLEDGEMENTS
  if (sesameWakeSelected(settings)) return [SESAME_WAKE_ACKNOWLEDGEMENT]
  return []
}

export { SESAME_WAKE_ACKNOWLEDGEMENT, HIGGS_WAKE_ACKNOWLEDGEMENTS }
