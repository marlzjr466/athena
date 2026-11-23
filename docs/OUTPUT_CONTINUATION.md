# Output budgets and task continuation

## Global continuation update — 2026-11-23

The historical implementation notes below describe the earlier OpenAI-only work. This update replaces its continuation accounting with a shared request controller.

### Confirmed failure

The saved `/platform-dev MBM-11825` failure contained zero tool activities, three compactions, and three requests that were all summaries. Its estimated input was 23,815 tokens, but Athena selected the unverified 16,384-token fallback for `gpt-5.6-terra`. Fixed instructions and tool definitions could not fit. ContextManager charged every compaction attempt against the same three-round continuation allowance, including fallback attempts, so repeated futile summaries exhausted it before project work began.

The shared fix separates model continuations, compactions, transport recoveries, tool batches, and individual operations. It also rejects an impossible fixed request before paying for summaries. The model catalog now includes the [official Terra capacity](https://developers.openai.com/api/docs/models/gpt-5.6-terra); unknown models still use conservative fallbacks and can receive an explicit documented context-window override scoped to account and model. There is no model-name branch in the continuation controller.

### Execution and context behavior

- Defaults remain three model continuations, configurable from zero to 32. Productive tool rounds and compactions do not consume them. Existing tool, iteration, time, and spending bounds still apply.
- OpenAI Responses, Chat Completions gateways, Anthropic Messages, Gemini, Bedrock Converse, Ollama (including its MLX subclass), and the existing text-only llama.cpp adapter map explicit incomplete-response signals into the same controller. Partial tool calls are never executed. Valid complete tool batches retain call IDs and results. llama.cpp keeps its existing chat-only restriction and now requires a terminal completion reason instead of treating disconnection as success.
- Native Codex app-server, Copilot SDK, Cursor ACP, and Antigravity ACP preserve native loops; Athena does not re-submit their prompts after a normal native completion. Available native session IDs are recorded. Unexpected ACP stop reasons are reported instead of falsely marking success.
- Supported OpenAI native compaction remains capability-gated. Other protocols locally condense old tool evidence without dropping IDs, signed thinking, original instructions, attachments, or recent batches. The existing host history summarizer remains in use. If indispensable input still exceeds capacity, Athena reports the actual sizing problem rather than looping or discarding it.
- Context sizing includes fixed instructions and tool definitions, protocol transcript, attachments, output reserve, and a configurable safety margin. Estimates remain estimates; they are not exact provider tokenization.
- API transport setup can retry bounded transient failures before consuming a response. Authentication, permission, invalid-request, rate-limit and quota responses are not automatically retried. Partial streams outside the existing verified OpenAI recovery path require explicit resume. A possible billed request is retained as unresolved usage.
- Duplicate incomplete responses, repeated unsuccessful/unchanged operations, and compaction without progress stop with distinct reasons. A test rerun producing new evidence counts as progress.

### Checkpoints and recovery

The existing conversation repository stores task objective, provider/account route, model, reasoning, workspace IDs and canonical roots, permission mode, operation references, modified files, verification references, pending work, control counters, native session ID when exposed, and recovery lineage. Operation fingerprints and a `started` record are saved before execution. A failed durable save stops the next operation.

Restart restores unfinished tasks as resumable without running them. Resume Task revalidates account, provider, model and workspace authorization, restores available context and activity evidence, and preserves prior messages. Repeating a recorded non-read-only operation requires explicit approval even in Full Access because its effect may already exist. Existing file-version checks and mutation receipts still apply. These guards do not promise general exactly-once execution for arbitrary shell programs or native runtimes; ambiguous state requires inspection and confirmation.

Replay classification is independent of parallel execution. The previous fallback treated serial Git inspections and project-instruction inspection as mutations, causing unnecessary repeat prompts. Executors now validate the actual tool arguments and classify operations as read-only, idempotent, non-idempotent, destructive, or unknown. Git branch listing is read-only; branch creation is not. Command classification uses a conservative argument allowlist, never just an executable name or a model-provided label. Scripts, shell operators and unrecognized options remain unverified.

On resume, current executor classifications take precedence over legacy checkpoint flags. Verified reads run again against current project state without a replay prompt, while ordinary Ask-mode approvals, workspace checks, sensitive-file protections and sandbox restrictions still apply. Idempotent writes also retain replay confirmation because their preconditions may have changed. Native terminal approvals carry trusted classification only from Athena's argument-array executor; opaque native operations remain protected. No provider-specific replay exemptions or UI changes are used.

Replay regression coverage: `tests/operationReplay.test.ts` restores legacy checkpoints, reads changed fixture contents, exercises Ask/Full Access, and verifies that a denied file-creation replay preserves newer contents. `ATHENA_REPLAY_SANDBOX_TEST=1` runs the same Git fixtures through the actual macOS sandbox. `tests/cursorTerminal.test.ts` verifies native approval metadata and actual sandboxed Git execution. Providers are mocked in these tests; no live development workflow is automatically resumed.

An adapter completing its response is recorded as `responded`, not an independent proof that the user's entire objective is complete. Known unresolved tools or user interactions remain pending. Athena does not infer arbitrary unfinished work and automatically launch more native runs.

Native session IDs are diagnostic checkpoints, not a claim of durable native-session resumption. Current adapters retain their own lifecycle, and host recovery reconstructs context when native resume is unavailable. Claude Subscription and Kiro are not separate registered adapters in this checkout; no integration or authentication flow was invented for them.

### Settings and files

AI Settings now exposes Automatic Continuation & Context Management: enable continuation, maximum rounds, automatic compaction, safety margin, repeat/no-progress guards, checkpoints, and safe recovery. Existing per-conversation preferences remain authoritative; “Also save as global defaults” affects conversations without overrides. Legacy global output-continuation settings synchronize with the shared global default. Permission-mode changes preserve those preferences.

New implementation files: `electron/main/ai/continuationController.ts`, `protocolContext.ts`, `requestRecovery.ts`.

Updated orchestration/persistence: `electron/main/ai/chatController.ts`, `contextManager.ts`, `contextBudget.ts`, `conversationRepository.ts`, `toolCallSession.ts`, `AIProvider.ts`, and `electron/main/main.ts`.

Updated adapters: `OpenAIProvider.ts`, `OllamaProvider.ts`, `LlamaCppProvider.ts`, `claudeAPI.ts`, `thirdPartyInference.ts`, `CodexAppServerProvider.ts`, `CopilotProvider.ts`, `cursorACP.ts`, `AntigravityProvider.ts`.

Updated schemas/UI: `shared/context.ts`, `generation.ts`, `settings.ts`, `modelLimits.ts`; `ContextSettings.tsx`, `GenerationSettings.tsx`, `ChatMessage.tsx`.

### Validation

- TypeScript and `git diff --check` pass.
- Full suite: 1,877 passed, 46 skipped, five failures outside the continuation tests. The remaining failures are two account-settings UI assertions, one existing development build-script assertion, one installed-local-model context probe, and one voice-runtime configuration assertion. The entire suite is therefore not green.
- Controller/protocol tests use mocked providers and real temporary filesystem fixtures. Tests cover many productive rounds with a small continuation allowance, six successive compactions, original platform-dev request sizing, malformed/incomplete tools, protocol-specific context preservation, transient transport failures, cancellation, permission checks, persisted restart recovery, replay protection, and settings persistence. No user project files were changed by fixtures.
- Native adapter regression tests cover Codex, Copilot, Cursor and Antigravity; these are mocked integration tests, not live account tests.
- Live packaged-app check: the existing ChatGPT account, GPT-5.6 Terra, High reasoning, Full Access, and authorized map-governance-ui project completed one `list_directory` call for `src/api/generated`, then returned 12 entries. Persisted receipts confirm one completed tool, zero continuations, zero compactions, and the 1,050,000-token window. Git status was clean before and after. The original conversation was restored with Resume Task visible.
- The original live `/platform-dev` development workflow has not been automatically rerun. The read-only check and passing fixtures do not establish that every provider account can complete that workflow or bypass provider quotas.

`npm run package` succeeded for macOS arm64, including TypeScript, production bundles and persistent local certificate signing. The current app exited gracefully and was relaunched; restored history, new context controls, Resume Task and the live operation were verified. Distribution notarization was skipped because its credentials were unavailable. No Windows build or live test of every provider is implied.

## Diagnosis

The OpenAI Responses adapter previously applied `max_output_tokens: 4096` to every request and threw immediately on `response.incomplete`. This allowance includes reasoning, final text, and generated tool arguments; it is not a context window or billing limit. The inspected active conversation selected `gpt-5.6-luna` with explicit Medium effort. Its documented output maximum is 128,000 tokens. Historical diagnostics did not contain per-response reasoning usage, so they cannot establish how much reasoning caused the original exhaustion. A later recorded request independently failed with API credit exhaustion.

## Behavior

- Settings → AI → Output & automatic continuation configures global generation preferences. Existing conversation model/effort choices are unchanged.
- Automatic output starts at 32,768 for reasoning-capable models (above OpenAI's initial 25K reasoning/output recommendation), or 8,192 for nonreasoning models. Recovery may double the allowance, bounded by the selected model's output/context limits. Explicit output caps are never raised. Unknown models use conservative documented-as-unverified application limits.
- Auto effort uses Medium where supported and Low during output recovery where supported. Explicit Low/Medium/High/Extra High is retained; unsupported explicit choices fail before a request.
- Three output continuations are permitted by default, now configurable from zero to 32 through the shared controller described above. Existing task deadlines and the optional per-conversation API spending cap still apply to every call.
- Only the actual `max_output_tokens` incomplete reason initiates recovery. Context, billing, rate limiting, content filtering, broken streams, tool limits, and output-setting errors remain distinct. Exhausted iteration/continuation allowances cannot mark the task successful.
- The existing stateless Responses integration uses `store: false`, canonical completed output/input items and encrypted reasoning where reusable. It reconstructs valid input rather than referencing an unstored `previous_response_id`.
- All function calls in an interrupted response are discarded, including seemingly valid JSON. No partial arguments execute. Completed operations from earlier rounds and corresponding tool results remain in context. Unfinished text is explicitly labeled a draft, not evidence of completion.
- The same executor, authorization checks, approvals and mutation receipts survive recovery. Existing target files must be freshly read after continuation before another edit; version checks still prevent overwriting external changes. Creation never overwrites an existing file.
- Task ID/start time/activity history are retained. The UI shows “Continuing task…” without restarting its timer, followed by the normal final elapsed duration/status.
- Checkpoints persist task objectives, instruction-message IDs, workspace/model, successful operation/change/verification references, pending requests, approval ID and attempt count. Original UI messages are not replaced. Canonical provider context is stored privately through the existing local repository, with existing size limits and filesystem permissions. Closing Athena cancels work; reopening does not automatically re-execute mutations or approvals.
- Diagnostics record numeric input/output/reasoning usage, configured allowance, tool-argument length and sanitized incomplete reasons. No keys, raw tool arguments or response text are logged. Missing usage is explicitly estimated in the UI.

## Files created

- `shared/generation.ts` — persisted preferences and recovery/checkpoint schemas.
- `shared/outputPolicy.ts` — model-aware output and reasoning policy.
- `shared/modelLimits.ts` — existing documented catalog moved to a shared module.
- `electron/main/ai/outputRecovery.ts` — safe reconstruction of incomplete responses.
- `src/features/settings/GenerationSettings.tsx` — budget/continuation controls.
- `tests/outputRecovery.test.ts`, `tests/generationSettings.test.tsx`.
- `docs/OUTPUT_CONTINUATION.md`.

## Files modified

- `shared/settings.ts`, `shared/agent.ts`, `shared/context.ts`.
- `electron/main/main.ts`.
- `electron/main/ai/AIProvider.ts`, `OpenAIProvider.ts`, `contextManager.ts`, `modelLimits.ts`, `chatController.ts`, `conversationRepository.ts`, `agentTools.ts`.
- `src/features/settings/AISettings.tsx`, `src/features/chat/AgentActivity.tsx`, `src/styles/ai.css`.
- `tests/settings.test.ts`, `tests/contextManager.test.ts`, `tests/contextPersistence.test.ts`, `tests/projectConversation.test.ts`, `tests/agentTools.test.ts`, `tests/agentActivity.test.tsx`.

## Validation and limitations

- TypeScript check passed.
- `npm run package` passed; the rebuilt `release/mac-arm64/Athena.app` was restarted and its new generation controls were confirmed in the running UI. Packaging emitted existing dependency/bundle-size notices and skipped distribution signing because no Developer ID certificate is installed.
- Full Vitest suite: 323 passed, one opt-in macOS sandbox integration test skipped; 33 test files passed.
- Recovery tests use mock OpenAI SSE transport; repository integration operates on actual temporary files. Covered reasoning-heavy exhaustion, explicit/automatic budgets and effort, truncated tool calls, repeated exhaustion limits, spending cap enforcement, cancellation, same-task identity/timer, persisted checkpoints, completed edits, fresh-read enforcement, UI settings and error distinctions.
- No paid live generation was performed. Mock transport validates Athena's recovery logic, not live account/model availability. Existing API credit exhaustion must be resolved separately by the account owner.
- After restart the existing project displayed “select again.” Reauthorize its folder before invoking project tools; this update does not bypass the existing filesystem authorization lifecycle. Conversation history and model/effort settings remain preserved.
- Historical scope: this first implementation covered OpenAI Responses only. The global update above extends continuation through the existing protocol adapters.
- Budgets are upper bounds, not guarantees that a model will finish. Explicit small caps or high reasoning, provider failures, spending caps, context limits or task deadlines can still cause a truthful unfinished result.
- No database migrations, new environment variables, dependencies or credential changes. Persistence remains local; this app has no Supabase persistence requirement for these settings.
- Existing character, flight, idle action, voice and workspace permission behavior is untouched.

## Official references

- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning): shared output/reasoning allowance, incomplete reasons, initial 25K reserve, and retained reasoning across tool calls.
- [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events): incomplete responses and completed output items.
- [GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna): model context and output capacities.


## Model migration and response clocks — 2026-11-23

Resume no longer requires the original model. The currently selected account/model is resolved by its existing authenticated adapter; coding recovery requires registered project tools or a native agent. Workspace IDs and canonical roots remain checked. Changes of account or provider require explicit transfer approval, including in Full Access, before inference receives conversation/project context. Existing native sessions and encrypted Responses context are not reused across changed identities. The portable handoff retains the objective, activity summaries, modified paths, verification results, blockers, original messages and replay ledger. Prior checkpoints remain in history; the new checkpoint records migration provenance. An early failed resume no longer masks the latest checkpoint containing verified execution evidence.

Confirmed timeout defects: raw DOM TimeoutError was always labeled task_deadline, the Responses stream watchdog was subscription-only, and there was no separate first-event clock. The installed OpenAI SDK's 60-second fetch timeout ends when headers arrive; it is not a total stream timeout. The historical 2m9s error alone does not identify its originating timer. New response clocks distinguish headers (60s default), first event (180s), and subsequent event inactivity (existing 120s default), configurable in Context Settings. Both API and subscription Responses and summary streams use these clocks. Only actual events reset inactivity. Timers are cleared before local tools. Existing task deadlines, command timeouts, cancellation, finite recovery budgets and replay checks remain active. No new provider event types or session APIs were introduced.

Validation: 172 focused tests passed, including fake-clock delayed/active/stalled streams, real SDK mocked HTTP responses, compaction, saved checkpoint restoration, two same-account model transitions, and four cross-provider handoffs with approval. Cross-provider adapters in migration tests are mocked; no live account or full platform-dev task was rerun. Native adapters retain their own authentication/capability/session validation. A silent reasoning interval cannot be distinguished from a stalled connection without actual provider activity; adjust the bounded inactivity setting if necessary.
