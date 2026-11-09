# Voice rollback — 2026-10-22

## Follow-up: restore natural Chatterbox voice

The user reported that switching to macOS speech removed the natural voice they wanted. The original `chatterbox-turbo` model and `profiles/athena-youthful-us-v3.mp3` US-English Amy reference are now used again. The existing cache was preserved, so no model download or installation was needed. The original sampler settings were recovered from the pre-Sesame build and cached provider bytecode. All generated sentence segments are consumed (rather than discarding everything after the first).

`ChatterboxSpeech` uses one private, offline stdio worker with cancellation, bounded WAV output, a 120-second idle unload and no system-voice fallback. Settings → Voice shows Chatterbox/Athena's original reference and expressiveness. Sesame, voice training and model installation interfaces remain removed. The spoken-versus-chat choice-prompt correction below remains intact. Whisper, Ollama, voice ownership, playback and animations are unchanged.

Real installed-model verification passed for speech generation, interruption and reload; a separate output was generated for a second phrase. This verifies the backend/reference path, not subjective accent quality or a complete microphone-to-avatar conversation. Original downloaded files were not changed.

Follow-up verification: TypeScript passed; 189 regression tests passed across 19 files (two opt-in cases skipped). The separate `ATHENA_CHATTERBOX_LIVE_TEST=1` suite passed actual installed-model generation, cancellation and reload. Production packaging completed; the packaged worker matches the source and the main bundle instantiates Chatterbox, not macOS speech or the removed Sesame manager. Athena was quit and relaunched. Settings → Voice displayed Chatterbox Turbo and the original Amy US-English reference; Preview Voice progressed from preparation back to ready without an error. Local Whisper reported ready. This UI check does not establish subjective voice quality or a live microphone conversation.

The sections below record the preceding macOS rollback and are superseded where they describe the active speech engine.

Removed the downloadable neural voice engines from active Athena. No Git snapshot exists for an exact historical checkout, so the established macOS `LocalMacSpeech` implementation was restored explicitly.

- Electron now uses `LocalMacSpeech` for both companion output and hands-free replies. No Python TTS worker is started, installed, or packaged.
- Removed neural voice management, reference-profile/customization UI, and My Athena → Local Voice. Voice settings now expose installed macOS voices, preview/stop, volume, speed, acknowledgments and the existing microphone/wake-word controls.
- Legacy neural management IPC returns a removal explanation; saved neural settings cannot activate a worker. Legacy preference schemas remain readable so existing settings/history are not discarded.
- Deleted neural worker implementations and obsolete neural integration fixtures. Retained source license/reference notices and downloaded model/profile files, untouched and inactive. No Academy, Ollama, Whisper, conversation or user training files were removed.
- The saved engine at inspection was Chatterbox, not CSM. An exact audio reproduction of the reported repetitive phrase was unavailable. Inspection found a separate prompt issue: voice-only Ollama turns inherited text-chat instructions to say “Choose one” and create selection controls. Voice-only turns now exclude that UI instruction; text chat retains it. No answer is fabricated or replaced with a canned reply.

Verification: 186 regression tests passed across 18 files (one opt-in live test skipped in that run). Separate opt-in live suite: two tests passed, including distinct France/Japan questions through ChatController and the installed qwen2.5-coder:3b model, with Paris/Tokyo answers and actual macOS WAV synthesis. TypeScript checked separately. This does not establish a full live microphone/wake-word/visual lip-sync test.

Reproduce live check (local inference only): `ATHENA_SYSTEM_VOICE_LIVE_TEST=1 npm test -- --run tests/systemVoiceRollback.test.ts`.
