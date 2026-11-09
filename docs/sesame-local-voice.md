# Sesame local voice integration — 2026-10-21

> Historical implementation report. Removed from the active application on 2026-10-22 at the user's request. See `voice-rollback.md`. The following describes the earlier integration, not current functionality.

## Implementation

Uses the installed MLX Audio 0.4.5 CSM-1B implementation and existing Python 3.11 environment rather than installing a second csm-mlx runtime. No private APIs or paid TTS. Existing Chatterbox and microphone/Whisper/Ollama infrastructure remain intact.

Fixed the old adapter's discarded output segments and ineffective expressiveness parameter. The verified backend accepts a sampler, not `temperature` as a standalone argument. Explicit `voice_match=False` preserves transcript/audio context instead of collapsing it to the first reference. Uses speaker 0 with the chosen authorized reference, optional enabled example, and at most one short prior generated segment. Context is scoped to local session/model/profile; previews do not inherit conversations. Laughter defaults off, uses no spoken tags, and requires explicit authorized example conditioning.

The Python worker communicates through private stdio, not a network service. Offline flags are set for inference. One synthesis request is allowed at a time. Incremental PCM WAV chunks feed the existing playback path for both companion speech and floating hands-free voice. The main-issued voice lease, request ID and sequential chunk index protect floating audio. Stop cancels the worker; the next request can reload. Idle unloading defaults to 120 seconds. CSM uses a 12 GiB MLX allocation ceiling and a 256 MiB cache limit; these are not a system-wide memory reservation or a promise against macOS memory pressure.

Settings live in **My Athena → Local Voice** (Athena AI's local settings area); Settings → Voice retains microphone/interaction controls and links to it. No new conversation-composer controls. Existing engine selections are retained. After a successful preview, users can explicitly make Sesame primary. The currently running packaged application was not rebuilt/restarted for this task.

Management includes approved dependency/model installation, byte progress where available, indeterminate dependency preparation, cancellation, content-hash verification, unload, and native-confirmed model removal to Trash. Shared tokenizer dependencies, custom profiles and samples are retained on model removal. Integrity checking handles HF's extra Xet symlink layer using the actual content-addressed blob hash. Cached corrupt files are redownloaded only through the approved install action.

Voice Training is explicitly **customization/evaluation**, not weight training: personality/listening notes, authorized transcript/audio examples, conversation or laughter categories, opt-in examples, preview text, up to 30 saved samples, ratings, listening feedback, measured metrics, replay and deletion. Live laughter conditioning requires a saved preview of that exact example/profile rated at least 4/5 with natural laughter explicitly reported by the listener; previews can test an unverified example. Store writes are serialized and atomic. The personality description is a review objective, not an unsupported CSM system prompt. Gentle pacing adds a 150 ms segment pause without pitch shifting. Actual fine-tuning is disabled because no compatible 24 GB training workflow was verified for this selected backend. Original weights are untouched.

## Actual verification

- Existing runtime: Python 3.11, MLX 0.32.3, MLX Audio 0.4.5; Apple M5 Pro, 24 GiB unified memory. No new model download was needed.
- All seven installed model/tokenizer/config files passed content-hash verification. A manifest was saved; original weight contents were not changed.
- Three actual offline samples: initial load 2.73 s; warm first audio 0.89–0.91 s; RTF 1.06–1.37. Peak Metal allocation approximately 7.37 GiB. `artifacts/sesame-verification/metrics.json` and WAV files retain evidence.
- Latest isolated Electron incremental stream: first chunk 0.87 s, 3.52 s audio generated in 3.68 s (RTF 1.05), five chunks. These are short-sample measurements, not performance guarantees.
- Local Qwen2.5 3B generated a short answer while Sesame remained loaded; CSM then synthesized it. First audio 1.17 s, 2.4 s audio generated in 2.86 s. Peak worker RSS in this run approximately 6.05 GiB; peak Metal approximately 7.37 GiB. RSS and Metal allocations overlap and must not be added.
- Actual HTMLAudio playback, measured playback startup, incremental floating playback adapter, and playback-amplitude meter tested in an isolated Electron window. Four floating audio chunks played; peak lip-sync input 0.898, final input 0. Cancellation, reload and subsequent generation passed.
- Local Whisper transcribed sample 1 exactly (“Hey, I'm Athena. I'm ready when you are.”). Sample 2 matched the spoken wording with punctuation differences. This supports intelligibility but does not establish subjective voice quality or stable identity across arbitrary prompts.
- Desktop and 430 px UI screenshots inspected; no horizontal overflow. Installed packaged Athena remained running. Temporary test profiles/samples were removed after test completion; benchmark WAVs remain in workspace artifacts.
- TypeScript passed. Final focused voice/UI/IPC/local-isolation/Ollama/playback suite: **205 tests passed across 20 files**. **Eight Python tests passed**. The real-model Electron integration test passed, including actual audio playback, incremental generation, interruption/reload, Qwen coexistence, floating playback-amplitude input and responsive layout.

Commands:

```sh
npm run typecheck
npm test -- --run tests/handsFreeAudio.test.ts tests/handsFreeAssistantLifecycle.test.tsx tests/handsFreeController.test.ts tests/handsFree.test.ts tests/aiIPC.test.ts tests/localVoice.test.ts tests/voiceStudio.test.ts tests/speechController.test.ts tests/speechPlayer.test.ts tests/speechOutputHook.test.tsx tests/actionVoiceIntegration.test.ts tests/voiceController.test.ts tests/athenaVoiceAnimations.test.ts tests/voiceResponse.test.ts tests/actionNarrator.test.ts tests/voiceChat.test.tsx tests/myAthenaNavigation.test.tsx tests/localIsolation.test.ts tests/localAI.test.ts tests/playbackAmplitude.test.ts
~/.athena/models/tts/runtime/bin/python3 -m unittest discover -s voice-service/tests -v
ATHENA_SESAME_LIVE_TEST=1 npx playwright test tests/desktop/localVoice.spec.ts
```

The live test uses existing installed weights, a temporary Electron profile and local Ollama; it never downloads models or alters application settings. It generates a short local model response. It does not capture microphone audio.

## Remaining verification/limitations

- No authorized natural-laughter recording was available; spontaneous chuckling and consistent feminine/youthful identity have not received human listening validation. No Maya-quality claim. Normal speech is the fallback; laughter is experimental and off by default.
- Full microphone → wake word → Whisper → local LLM → live VRM mouth rendering was not visually exercised in the user's packaged app. Existing animation/voice tests pass; real audio amplitude inputs were verified, not a live character's appearance.
- New-install network download/cancel/remove dialogs are implemented but destructive removal and a redundant multi-GB download were not exercised against the user's installed models. Inference and existing-file integrity were exercised locally.
- Actual weight fine-tuning is unsupported in this integration. [csm-mlx](https://github.com/senstella/csm-mlx) offers a separate trainer, but its documented high-memory setup was not substituted or represented as supported here.
- Short benchmark samples are slightly slower than real time; chunk playback may have gaps under load. This is not a claim of seamless real-time audio on all text or concurrent workloads.
- User should listen to a preview before making Sesame their preferred engine. No current settings, weights, Academy data, or model-selection defaults were silently replaced.

## Files

- Worker: `voice-service/providers/sesame.py`, `voice-service/app.py`, `voice-service/install.py`, `voice-service/benchmark.py`, `voice-service/SESAME_NOTICES.md`.
- Electron: `electron/main/voice/localVoiceManager.ts`, `voiceStudio.ts`, `localVoiceAudioSession.ts`, `localVoiceServices.ts`, `speechService.ts`, `speechController.ts`, `electron/main/ipcHandlers.ts`, `electron/preload/preload.ts`.
- Shared contracts/settings: `shared/localVoice.ts`, `shared/speech.ts`, `shared/handsFree.ts`, `shared/contracts.ts`, `shared/ipcChannels.ts`.
- UI/playback: `src/features/settings/VoiceSettings.tsx`, `SesameVoiceStudio.tsx`, `src/features/athena-ai/MyAthenaPage.tsx`, `src/app/ControlCenter.tsx`, `src/styles/localVoice.css`, `src/services/desktop.ts`, `src/services/speech/handsFreeAudio.ts`, `src/features/voice/HandsFreeAssistant.tsx`, `useSpeechOutput.ts`.
- Tests: local voice, studio, speech controller, hands-free audio and IPC tests; Python service/integrity tests; isolated Electron voice fixture and desktop spec.
