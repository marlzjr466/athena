# Local voice fallback

GPT-Live is the default voice engine. Chatterbox Turbo is the local fallback and uses the existing authorized voice reference. Whisper and its downloaded models remain independent from speech output.

Legacy provider settings are migrated to Chatterbox without changing cloud consent, the selected custom GPT-Live voice, or other saved preferences. Preview and wake acknowledgments use the same serialized local speech service.

Run `npm test -- --run tests/systemVoiceRollback.test.ts` for fixture regression checks. Set `ATHENA_CHATTERBOX_LIVE_TEST=1` for opt-in installed-model verification.
