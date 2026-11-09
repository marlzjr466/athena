# Output budgets and task continuation

## Diagnosis

The OpenAI Responses adapter previously applied `max_output_tokens: 4096` to every request and threw immediately on `response.incomplete`. This allowance includes reasoning, final text, and generated tool arguments; it is not a context window or billing limit. The inspected active conversation selected `gpt-5.6-luna` with explicit Medium effort. Its documented output maximum is 128,000 tokens. Historical diagnostics did not contain per-response reasoning usage, so they cannot establish how much reasoning caused the original exhaustion. A later recorded request independently failed with API credit exhaustion.

## Behavior

- Settings → AI → Output & automatic continuation configures global generation preferences. Existing conversation model/effort choices are unchanged.
- Automatic output starts at 32,768 for reasoning-capable models (above OpenAI's initial 25K reasoning/output recommendation), or 8,192 for nonreasoning models. Recovery may double the allowance, bounded by the selected model's output/context limits. Explicit output caps are never raised. Unknown models use conservative documented-as-unverified application limits.
- Auto effort uses Medium where supported and Low during output recovery where supported. Explicit Low/Medium/High/Extra High is retained; unsupported explicit choices fail before a request.
- Three output continuations are permitted by default, configurable from zero to eight. This allowance is separate from the existing context-compaction and tool-iteration bounds. Existing task deadlines and the optional per-conversation API spending cap still apply to every call.
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
- Only the existing OpenAI Responses adapter is implemented; no Chat Completions or other-provider adapter was invented. Other adapters must independently map output parameters and incomplete reasons before supporting recovery.
- Budgets are upper bounds, not guarantees that a model will finish. Explicit small caps or high reasoning, provider failures, spending caps, context limits or task deadlines can still cause a truthful unfinished result.
- No database migrations, new environment variables, dependencies or credential changes. Persistence remains local; this app has no Supabase persistence requirement for these settings.
- Existing character, flight, idle action, voice and workspace permission behavior is untouched.

## Official references

- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning): shared output/reasoning allowance, incomplete reasons, initial 25K reserve, and retained reasoning across tool calls.
- [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events): incomplete responses and completed output items.
- [GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna): model context and output capacities.
