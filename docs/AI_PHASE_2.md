# AI Phase 2 — OpenAI provider and text conversation

Scope: text conversation only. No Phase 3 permission service, voice, tools, application detection, screen capture or personal file access.

## Implementation

- Main-only `AIProvider` interface (`testConnection`, `streamMessage`) with `OpenAIProvider`, using the selected model and Keychain credential. No secret-returning IPC exists.
- Official SDK consumes [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events). `store:false`, no tools, fixed API origin, redirect rejection, no automatic retry. Generation is bounded by 4,096 output tokens, 48,000 displayed characters and an overall 120-second timeout.
- Main-process `ChatController` owns bounded in-memory history, one active generation, cancellation and lifecycle. Stop keeps a labeled partial response. Retry replaces the last assistant answer without duplicating its user message. Clear aborts first and rejects stale events. Quit disposes timers; renderer crashes cancel active generation. Navigation/closing the control window retains the session; app restart clears it.
- Conversation history sent to OpenAI includes completed user/assistant messages. Failed/stopped assistant fragments are not treated as complete context. No conversation is written to disk or application logs. `store:false` is not a promise of zero provider-side retention.
- Named typed IPC accepts chat operations only from the trusted top-level control window. Snapshot revisions prevent stale initial reads from overwriting streamed state. Text-only clipboard writes are validated; no clipboard-read API is exposed.
- Zustand chat store, streaming transcript, stop/retry/confirmed-clear, setup and offline guidance, Markdown/GFM/code blocks and copy controls. Raw HTML, remote images and navigable model-generated links are disabled. Code is inert text.
- Athena personality is calm, warm, concise and honest about lacking desktop capabilities. No model output is parsed as a local command.
- Thinking, speaking (text-response animation), idle lifecycle pauses wandering/actions and safely cancels an in-flight automatic journey. Manual dragging remains available and restores conversation pose afterward. Completion/error/cancellation restarts the existing countdown. Flying geometry, roll, landing and position/speed settings are untouched. Only subtle thinking/speaking head animation is added.
- Full control center provides AI chat; mini-panel local actions remain intact and point users to Conversation for AI.

## Verification

- Unit/component tests cover provider SSE deltas/refusals/completion/truncation/errors/abort, safe request options, history, overlapping sends, stop/clear stale-event isolation, retries, bounded inputs/output, not-configured guidance, timeout/disposal, Markdown safety and restricted IPC.
- Native chat scenario uses real isolated Keychain and Electron, with network mocked only by the test harness. Verifies incremental text, thinking/speaking/idle, full context, no tools, stop/abort/retry, error recovery, clear and resumed native movement.
- Companion, development renderer, idle actions, wandering/landing and credential lifecycle remain in the native regression suite. The first chat run exposed a too-fast test navigation; waiting for the intermediate page fixed the harness, and the rerun passed.
- `npm test`: 190 tests passed across 14 files after the streaming-error fix. TypeScript and packaged macOS build passed. All six native scenarios passed across the earlier full run and corrected chat rerun.
- Updated packaged Athena was restarted and its new Conversation screen verified. Saved model configuration survived restart; no real credential was retrieved by the development tools.
- **Live verification remains blocked by exhausted API credit.** On 2026-10-08 the running packaged app received `credit_balance_exhausted` inside the authenticated response stream. Connection testing succeeds because it checks authentication/model listing, not generation credit. The SDK throws an APIError without HTTP status for SSE errors; Athena incorrectly classified those as network failures. Provider error handling now distinguishes stream API errors, quota/credit exhaustion, model/parameter rejection, and actual transport failures without displaying raw server messages or credentials. Regression tests cover named SSE errors and sanitized diagnostic identifiers. No model or key was changed. A successful real answer must still be verified after the account has available API credit; Phase 2 is not yet complete.
- The packaged companion preview displayed its existing “WebGL unavailable” fallback during inspection. Native motion regression tests pass, but live 3D appearance could not be confirmed in that runtime; no flight or model geometry was changed.

## Created files

- `shared/chat.ts`
- `electron/main/ai/AIProvider.ts`
- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/chatController.ts`
- `src/store/chatStore.ts`
- `src/features/chat/ChatView.tsx`
- `src/features/chat/MessageMarkdown.tsx`
- `src/styles/chat.css`
- `tests/chatController.test.ts`
- `tests/openAIProvider.test.ts`
- `tests/messageMarkdown.test.tsx`
- `tests/desktop/chat.spec.ts`
- `docs/AI_PHASE_2.md`

## Modified files

- `package.json`, `package-lock.json`
- `shared/contracts.ts`, `shared/ipcChannels.ts`
- `electron/main/main.ts`, `electron/main/ipcHandlers.ts`
- `electron/main/ai/aiConfiguration.ts`
- `electron/main/athenaController.ts`, `electron/main/motionController.ts`
- `electron/preload/preload.ts`
- `src/services/desktop.ts`, `src/app/ControlCenter.tsx`
- `src/features/chat/LocalChat.tsx` (guidance text only)
- `src/features/settings/AISettings.tsx`, `src/features/settings/SettingsPage.tsx`
- `src/three/AthenaAnimations.ts`
- `tests/aiIPC.test.ts`, `tests/desktop/aiConfiguration.spec.ts`, `tests/desktop/companion.spec.ts`
- `README.md`, `docs/IMPLEMENTATION_PLAN.md`

Generated `out/` and `release/` artifacts are rebuilt for the requested restart.
