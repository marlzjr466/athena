# AI Phase 1 — OpenAI configuration and activation

Scope: configuration only. No provider streaming interface, text generation, voice, OS permission service, tools, application detection, screen capture, or personal file access has been added. Wait for “Proceed to next phase” before implementing Phase 2.

## Implementation

- Settings → AI: OpenAI provider, active/not-configured status, masked password input, test, save/activate, replacement, confirmed removal and available model selection.
- Typed, named IPC; only the owned top-level control window may configure AI. Floating/panel frames and unknown/child senders are rejected.
- Main process validates every key/model input. A serialized service prevents concurrent activation/removal races. Activation verifies the exact key and saves only after success; failed replacement leaves the old key intact.
- Direct macOS Keychain credential via the native asynchronous `@napi-rs/keyring` binding. No secrets in settings.json, localStorage, logs, command-line arguments or saved renderer state. The main process retains the credential in memory; JavaScript strings do not offer guaranteed secure erasure. The key and non-sensitive model metadata are one Keychain record, so saving/removing them stays atomic.
- The renderer sees only a fixed mask, status, timestamp and model IDs. It holds a new password only while editing; successful save and cancellation clear the input. Unmount discards component-local draft state.
- OpenAI connection testing uses the authenticated [List models endpoint](https://developers.openai.com/api/reference/resources/models/methods/list) and [Bearer authentication](https://developers.openai.com/api/reference/overview). No generation is performed. A successful model-list test does not guarantee generation permissions, model compatibility, billing or quota. Those belong to the next phase.
- Requests use a fixed HTTPS origin, prohibit redirects, have a 15-second timeout, validate model responses, and return fixed sanitized errors for 401/403/429/network/timeout/server failures. No response/error bodies are exposed or logged.
- Successful activation/model choice survives restart. Testing a revoked stored key deactivates it. Temporary network failures preserve the last verified configuration, clearly labeled with its timestamp.
- No character/model, motion, landing, idle action, display, tray, timer, pinning or dragging implementation was modified.

## Verification

- `npm test`: 148 passing behavior/component tests, including activation ordering, test-only nonactivation, invalid keys, replacement failure, atomic removal, restart persistence, input validation, secret-free output, Keychain errors, concurrent activation/removal, HTTP failures, timeout cleanup, UI masking and IPC authority.
- `npm run test:desktop`: native scenario uses real macOS Keychain in a unique development-profile service. It saves a synthetic key, restarts, verifies model persistence, replaces/removes it and checks IPC, disk settings, localStorage and logs. OpenAI responses are mocked only in the external test harness; production code has no bypass. Existing companion, development renderer, idle actions and flight scenarios are included.
- No real OpenAI account key was supplied, so live successful authentication/billing has not been verified. The user can enter their own key directly in Settings → AI; never paste it into a development log or chat.
- Browser preview intentionally refuses credential configuration. Non-macOS storage fails closed; no insecure fallback is implemented.

## Files created

- `shared/ai.ts`
- `electron/main/ai/credentialStore.ts`
- `electron/main/ai/openAIConnection.ts`
- `electron/main/ai/aiConfiguration.ts`
- `src/features/settings/AISettings.tsx`
- `src/styles/ai.css`
- `tests/aiConfiguration.test.ts`
- `tests/openAIConnection.test.ts`
- `tests/aiSettings.test.tsx`
- `tests/aiIPC.test.ts`
- `tests/desktop/aiConfiguration.spec.ts`
- `docs/AI_PHASE_1.md`

## Files modified

- `package.json`, `package-lock.json`
- `shared/contracts.ts`, `shared/ipcChannels.ts`
- `electron/main/main.ts`, `electron/main/ipcHandlers.ts`
- `electron/preload/preload.ts`
- `src/services/desktop.ts`
- `src/app/ControlCenter.tsx`
- `src/features/settings/SettingsPage.tsx`
- `src/features/athena/CompanionPage.tsx` (privacy copy only)
- `tests/desktop/companion.spec.ts` (explicit preload API allowlist)
- `README.md`, `docs/IMPLEMENTATION_PLAN.md`

Generated build artifacts under `out/` and the local macOS app under `release/` are regenerated for the restart, not hand edited.
