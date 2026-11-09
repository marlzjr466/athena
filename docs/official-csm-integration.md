# Official Sesame CSM integration — 2026-10-22

## Voice consistency and wake latency correction — 2026-10-22

The official CSM README explicitly says a context-free `speaker=0` produces a random voice; the installed profile had no Sesame reference. Athena now makes a separate private CSM copy of the existing locally generated synthetic Athena voice WAV and its verified transcript when no custom Sesame reference is selected. This reference is the first `Segment` on every generated phrase. Explicit custom references still take precedence, and a mismatch between their enrolled speaker and the selected speaker fails clearly instead of drifting. Chatterbox's own files and settings are unchanged.

Ending a hands-free turn no longer unloads CSM or discards its voice context. A single short Sesame wake acknowledgment is pre-generated in the background when Sesame is selected, validated as WAV, and cached privately across app restarts. Wake-only speech still runs local Whisper and never invokes the conversational LLM. If the installed synthetic anchor is unavailable, Athena asks for an authorized reference instead of generating a random voice.

Real CPU verification with that anchor generated two official watermarked WAVs: first model load 14.94 s plus 4.60 s generation (0.72 s audio); warm follow-up generation 7.91 s (2.64 s audio). Their median voiced fundamental frequencies were 194.7 Hz and 210.7 Hz. This is evidence of comparable pitch, not a guarantee of identical perceived voice. A 0.72-second local sample took 1.85 s to transcribe with the configured Whisper small model on CPU; an already cached wake acknowledgment avoids the additional CSM generation. Real microphone-to-playback latency and subjective identity consistency still require a user hands-free check.

## Status

The official Sesame CSM-1B model and required tokenizer assets are downloaded and authenticated locally. Real CSM inference, Preview Voice, floating local speech, and audible WAV playback have been verified. Chatterbox remains unchanged and remains the default engine.

The saved Hugging Face token was used only by the isolated download/runtime environment. Authenticated metadata requests for `sesame/csm-1b/model.safetensors` and `meta-llama/Llama-3.2-1B/tokenizer.json` succeeded; no tokens, token fingerprints, account identity or raw authorization responses were logged. No gates were bypassed and no terms were accepted on the user's behalf.

## Provenance and environment

- Official repository: https://github.com/SesameAILabs/csm
- Clone: `vendor/sesame-csm-official`, revision `daed31e6d42cf71873999075de204fa37d2acec3`.
- Official `generator.py`, `models.py`, `watermarking.py`, requirements and Apache-2.0 license remain unmodified. Regression tests verify core source hashes. Packaging includes only the explicit runtime source/license files, not `.git` or Python caches.
- Separate Python 3.11 environment: `~/.athena/models/csm-official/runtime`.
- Installed the official `requirements.txt` successfully, including PyTorch/torchaudio 2.4.0, torchtune 0.4.0, torchao 0.9.0, Moshi 0.2.2 and official Sesame SilentCipher revision `d46d7d0893a583d8968ab3a6626e2289faec9152` resolved by upstream's requirement.
- `pip check`: no broken requirements. Imports succeed. Runtime inspection reports MPS available and the official model has now been exercised. There is no MLX package in this environment.
- Upstream optional diagnostics mention missing Triton and ffmpeg. Neither prevented module imports. WAV-only reference support does not require compressed-audio decoding. No dependency was installed into Chatterbox's environment.
- Upstream `run_csm.py` explicitly skips MPS for float64 limitations even though the README shows MPS selection. CPU is the conservative default; MPS is opt-in experimental. No automatic device fallback.
- Moshi 0.2.2 imports `bitsandbytes` even for the unquantized Mimi checkpoint. Because no supported macOS arm64 bitsandbytes wheel exists, the adapter installs a narrow import-only shim on Apple Silicon; any genuinely quantized layer fails explicitly. This does not replace or modify Sesame, Moshi, Mimi, or the watermark implementation.
- The official SilentCipher watermark path uses `torch.istft`, whose `aten::unfold_backward` operator is not implemented on MPS. The worker uses PyTorch's documented MPS CPU fallback for that unsupported operator (configurable off with `PYTORCH_ENABLE_MPS_FALLBACK=0` for strict diagnostics). CSM inference remains on MPS; watermarking remains enabled.

## Implementation

- `shared/officialCSM.ts`: validated persisted device/speaker/reference/context settings and management commands.
- `shared/localVoice.ts`: new `sesame-csm-official` identity. The legacy `sesame-csm`/MLX identity remains inert and cannot silently select the new engine. Chatterbox remains the default.
- `electron/main/voice/officialCSM.ts`: isolated Python process, lifecycle/cancellation/timeout, offline inference, installation/download management, authorized WAV validation and independent reference copies, real metrics transport. Single concurrent operation, bounded output, warm reuse and two-minute idle unload.
- `electron/main/voice/selectedLocalSpeech.ts`: explicit routing through the existing speech interface. Never substitutes engines after an error; unloads the previously selected engine to avoid keeping two TTS models resident.
- `voice-service/official_csm.py`: calls the official `load_csm_1b` and `generator.generate`; uses official `Segment` objects for references plus prior generated speech. It retains the original watermarking call. No private Sesame APIs, community ports or replacement models.
- Context: at most two recent generated segments / 20 seconds per key, at most three keys, memory only. Local conversation/session/model keys are supplied by the existing ownership-protected controller. Preview does not inherit live conversation history. Cancellation, configuration changes and unload clear worker context.
- Long text is split into sequential complete official generations and reassembled; no sentence is deliberately discarded. This is not native streaming. Requests/output/duration are bounded and duration-cap failures are surfaced rather than returning knowingly truncated speech.
- Worker runs with four CPU threads, no Torch compile, offline Hugging Face access during inference. Only explicit download/setup commands enable network access. Model downloads use approval dialogs and existing local HF authorization; no token UI or credential persistence was introduced.
- `VoiceSettings.tsx` / `OfficialCSMSettings.tsx`: existing layout, two-engine selector, separate device/speaker/reference/transcript configuration, explicit authorized-reference import/remove, download/cancel/unload, preview, last-two-preview comparison in memory, actual metrics when generated. CSM disables the unsupported Chatterbox expressiveness slider. No invented laughter/personality controls or Maya preset.
- Main/preload/IPC/contracts/desktop adapter/package config wire the service without replacing microphone, Whisper, Ollama, playback, animation or local/online ownership systems. Hands-free and local speech now supply session keys. Development runtime source paths account for the `out-dev` entry directory.
- `voice-service/official_csm.py`: the Apple Silicon compatibility path is limited to the unquantized official checkpoint and preserves the official watermark. It never falls back to Chatterbox, MLX or a cloud voice.

Chatterbox's `chatterboxSpeech.ts`, `chatterbox.py`, installed model and original Amy reference were not modified. Its expressiveness/settings remain independent.

## Verification

- TypeScript: passed.
- Final focused 23-file regression suite: 240 passed, 2 opt-in tests skipped; rerun after the diagnostic refinements on 2026-10-22 at 13:08 local time. TypeScript also passed in the same verification run.
- Separate opt-in real Chatterbox verification: 2 passed, 1 unrelated opt-in test skipped; generation, cancellation and reload exercised without altering its model or reference.
- Python adapter unit tests: 2 passed. Context tests explicitly use mocked waveforms and **do not count as real CSM inference**.
- Core official-source hash tests: passed; upstream clone remains clean.
- Development main/preload/renderer compilation: passed. One dev session started, with the packaged Athena app left running and its production preferences untouched.
- Actual MPS generation: the official `load_csm_1b` loaded the 6.2 GB checkpoint and generated two non-empty, watermarked 24 kHz mono PCM WAVs. The explicit report in `artifacts/official-csm/mps/report.json` is `ok: true`: generation 1 loaded in `13050.72 ms`, generated `21.84 s` in `66366.20 ms`, and generation 2 reused the warm model (`9864.57 ms`) with `2.88 s` of audio. Peak process RSS was `11314397184` bytes (~10.5 GiB). The shorter standalone file `artifacts/official-csm/mps/real-sample.wav` was also played successfully with `afplay`.
- Strict MPS diagnostics reproduce the exact upstream limitation: `NotImplementedError: The operator 'aten::unfold_backward' is not currently implemented for the MPS device`, raised by official SilentCipher's `torch.istft` watermark path. With the documented CPU fallback enabled, the same official generation completed successfully; no audio was returned without watermarking.
- Actual development UI: switched from the default Chatterbox engine to official Sesame, observed its separate device/speaker/reference controls and disabled unsupported Chatterbox expressiveness, ran Preview Voice, and received an actual generated sample in the page's comparison list. A live Electron regression test then called the floating companion's hands-free speech IPC with Sesame selected, generated a real WAV, and played it through an `Audio` element; the test passed. The test used a local Whisper model and a mocked granted microphone status only to exercise the speech route without recording.
- Authenticated download verification: CSM config/weights, Llama tokenizer/config, Mimi tokenizer and official SilentCipher assets are present in `~/.athena/models/csm-official/hub`. No Llama language-model weights or MLX artifacts were downloaded.
- Focused regression checks after the compatibility change: Python adapter unit tests `2 passed`; official CSM TypeScript/settings/hands-free suites `11 passed`; `tsc --noEmit` passed.

## Remaining verification limits

- The two-sample explicit live report and live Preview/Floating paths are verified. The report intentionally leaves `subjectiveQualityVerified` and `microphoneLipSyncVerified` false; audio quality and visual lip sync still require human review.
- MPS is a hybrid path because SilentCipher watermarking falls back to CPU for one unsupported operator. This is not a claim of fully native MPS acceleration. CPU-only inference and long-form latency were not benchmarked in this continuation.
- Natural laughter/chuckle quality, reference-voice consistency and lip-sync visual quality require human review of generated audio/video and are not claimed from the automated checks. The released base model is not Sesame's production Maya voice.
- Chatterbox remains the selectable default and was not modified. `npm run package` completed, the packaged resource was checked byte-for-byte against the updated adapter, and the packaged Athena app was restarted.
