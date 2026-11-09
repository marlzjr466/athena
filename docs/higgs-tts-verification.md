# Higgs TTS 3 continuation — 2026-10-22

## Result

**Not ready for speech playback.** The existing UI, download controller, engine
selector, and shared playback routing were retained. The Python worker's assumed
Transformers inference interface is not compatible with the official checkpoint.

The configured isolated environment did not exist before this continuation. It
was installed, with approval, at `~/.athena/models/higgs-tts-3/runtime`. No model
weights were downloaded. Only the official small `config.json` was fetched.
Chatterbox/Sesame runtime directories, references, weights, selected engine, and
saved user settings were not modified.

## Real Mac checks

- Python 3.11 isolated virtual environment installation: succeeded.
- PyTorch: 2.14.1; Transformers: 5.20.2; Hugging Face Hub: 2.2.0.
- `pip check`: no broken requirements.
- Native, unsandboxed PyTorch inspection: `mpsAvailable: true`.
  This is device detection, not proof of Higgs inference acceleration.
- Official metadata download: succeeded using the normal local authorization
  lookup. Credentials were not printed or copied into settings.
- `AutoConfig.from_pretrained` against official metadata: failed with ValueError:

  > The checkpoint you are trying to load has model type `higgs_multimodal_qwen3` but Transformers does not recognize this architecture.

- Official architecture: `HiggsMultimodalQwen3ForConditionalGeneration`.
- Official `config.json` provides no `auto_map`; the checkpoint repository has no
  Python remote implementation for `trust_remote_code=True` to load.
- No official checkpoint was loaded; no waveform was generated or played.
- First-audio latency, speech throughput, inference peak memory, audible emotion,
  prosody, laughter, reference conditioning, and floating/hands-free playback:
  **not measured / blocked**.

CPU selection cannot repair missing architecture/generation/decoder code. No
device or engine substitution was attempted. Official serving instructions point
to SGLang-Omni and vLLM-Omni; those were not installed on this Mac. This finding is
specific to Athena's existing Transformers adapter, not a claim that all possible
Apple Silicon implementations are impossible.

## Corrections

- Added the full official 43-control catalog shared by TypeScript and Python.
- Removed unsupported `style:conversational`; migrated saved Higgs preferences
  to natural speech with no style token while retaining all other settings.
- Style options now use only `singing`, `shouting`, and `whispering`, plus no tag.
- Unknown controls cannot be allowed by stale tokenizer metadata. Python also
  validates incoming controls. Sound-effect spacing follows the documented
  tag-immediately-followed-by-vocalization rule.
- Disabled implicit PyTorch MPS-to-CPU fallback.
- Preserved HF_HOME/HF_TOKEN_PATH so isolating the model cache does not hide an
  existing Hugging Face login.
- Added persisted compatibility status and an actionable Settings explanation.
  A known incompatible runtime cannot initiate weight downloads or generation.
- Downloader pins metadata and files to one revision, checks compatibility
  before fetching weights, and retains the existing native approval dialog.
- Checkpoint verification checks required tensor files and safetensors headers,
  invalidates stale verification markers, and returns JSON on stdout. Previously
  its successful result was redirected to stderr and ignored by Electron.
- Packaged worker resources include the same token catalog as the renderer.

The old generic method-name/reference-argument guessing remains unreachable behind
the compatibility guard. It is not a verified Higgs speech API. Connecting a
verified architecture, multi-codebook generation loop, and waveform decoder is
required before lifting that guard or downloading weights for inference.

## Regression checks

Files changed: `shared/higgsTTS.ts`, `shared/higgsSpeech.ts`,
`shared/localVoice.ts`, `voice-service/higgs_tokens.json`,
`voice-service/higgs_tts.py`, `electron/main/voice/higgsTTS.ts`,
`src/features/settings/HiggsTTSSettings.tsx`, `package.json`,
`tests/higgsSpeech.test.ts`, `tests/higgsTTS.test.ts`,
`tests/higgsTTSSettings.test.tsx`, `tests/selectedLocalSpeech.test.ts`,
`tests/test_higgs_worker.py`, and this report.

`npm run typecheck`: passed.

```sh
npm test -- --run tests/higgsSpeech.test.ts tests/higgsTTS.test.ts tests/higgsTTSSettings.test.tsx tests/selectedLocalSpeech.test.ts tests/officialCSM.test.ts tests/chatterboxSpeech.test.ts tests/speechController.test.ts tests/handsFreeController.test.ts
```

55 tests across 8 files passed. Covers token handling, settings migration,
compatibility/download gates, UI, selected-engine routing, no fallback, and the
existing Chatterbox/Sesame/speech/hands-free contracts. Routing tests use mocks;
they are not end-to-end audio evidence.

```sh
~/.athena/models/higgs-tts-3/runtime/bin/python3 -m unittest discover -s tests -p test_higgs_worker.py -v
```

8 tests passed. Covers all controls, auth-path preservation, disabled device
fallback, rejection before weight download, exact compatibility errors, missing
or corrupt tensor files, and the verification stdout protocol.

The initial Python test run exposed macOS `/var` versus `/private/var` path
canonicalization in the test assertion; it now compares canonical paths.

Native compatibility inspection (metadata only, no weights):

```sh
ATHENA_HIGGS_ROOT="$HOME/.athena/models/higgs-tts-3" \
  "$HOME/.athena/models/higgs-tts-3/runtime/bin/python3" voice-service/higgs_tts.py inspect
```

Diagnostic state is saved in `~/.athena/models/higgs-tts-3/compatibility.json`.
Weight download still requires explicit user approval. No paid service was used.
The installed Athena application was not rebuilt or restarted in this continuation.

## Sources

- [Official checkpoint and serving instructions](https://huggingface.co/bosonai/higgs-tts-3-4b)
- [Official 43-control catalog and placement rules](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/PROMPTING.md)
- [Official architecture configuration](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/config.json)
- [Official implementation guidance: v3 is standalone](https://github.com/boson-ai/higgs-audio)
- [Model license](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/LICENSE)
