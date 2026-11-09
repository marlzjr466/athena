# Sub-agent tool-call budget fix — 14 October 2026

## Confirmed cause

The user's saved Settings were **60 tool calls / 20 iterations / 250,000 tokens**. The failing child request explicitly supplied **maxToolCalls: 20 / maxIterations: 12**. The coordinator used the minimum of request and Settings, so its effective limits were **20 / 12**, not 60 / 20. The failed child had consumed 19 calls. Its second attempt had 202,051 tokens remaining; tokens were not the blocker.

`ToolCallSession.validateBatch` rejected the whole three-call batch because only one call remained. No tool ran, but the preceding model request still consumed an iteration and tokens. Resuming the same child preserved 19/20 calls and requested another oversized batch, repeating the failure. OpenAI, Ollama and Claude also stopped immediately at the tool/round limit rather than allowing an evidence-based final assessment. This made budget exhaustion an exception instead of a useful bounded review outcome.

Recorded read ranges revealed missing portions of two artifacts. Child reads are capped at 4,000 characters, so a requested line range can end earlier than requested. Later requests skipped some truncated lines. This must remain an incomplete review; neither the old error nor this fix authorizes PASS.

The parent and child already had separate tool sessions. No parent-call inheritance or provider-imposed 20-call limit was found. A separate inconsistency did exist: malformed and unknown tool attempts counted in the provider session but not in the child's persisted counter. Admission of an oversized batch counted zero calls; model retries correctly consume inference requests, not tool calls.

## Settings path and allocation

`SubagentSettings` validates form values and calls the existing `updateSettings` IPC. Shared settings validation and `SettingsRepository` persist/restore `settings.subagents`. `main.ts` supplies the current settings callback to `ChatContextService`, which creates `SubagentCoordinator`. The coordinator previously snapshotted settings at parent creation. New children now resolve current saved model/effort/budget preferences at launch. A persisted effective ceiling prevents a continued or queued child from silently gaining a larger allowance.

Effective calls/iterations are `min(current Settings, optional task/workflow cap, previously allocated ceiling for the same child)`. Workflow declarations remain authoritative lower constraints. Automatic legacy cold-read gate detection supplies no numeric cap. Optional request schema descriptions and parent delegation policy now explicitly require **omitting** call/iteration overrides to inherit Settings, as already done for tokens. Legitimate explicit lower caps are preserved, never silently ignored. No settings, limits or models were increased.

## Implementation

- `SubagentExecutionBudget` owns child-local allocation diagnostics, lifetime counters, evidence coverage, no-progress detection and final-assessment policy. One existing model-request slot is reserved for the final assessment; there is no hidden extra inference allowance.
- All supported provider loops consult that policy. When tools are consumed, a batch is limited, four consecutive calls add no usable evidence, or the last iteration is reached, the next request must return a structured assessment without tools. Subscription request retries recheck this boundary too. Token, context, time, cost, cancellation and permissions still apply; if final inference is impossible, saved observations and a structured incomplete result remain available.
- Only an entirely known, independently safe read-only batch can be partially admitted. Each admitted call is permission-checked normally. Dependent/mutating batches are deferred in full. Every provider call ID receives a result in original order, including explicit `tool_budget_deferred` results for unexecuted calls. Deferred calls consume no tool allowance; malformed, unknown and failed attempted calls each consume one. No edits or commands are replayed.
- Read outputs now advertise `nextStartLine` calculated from the **actual returned end**, including output-size truncation. Each child request receives current missing ranges and a directive to use retained evidence rather than restart exploration. Repeated results/errors cause a bounded final assessment, not an infinite retry loop. Existing version-aware read deduplication remains in place.
- Coverage is recorded from bounded, serialized results actually returned by the dispatcher. Required cold reads cannot complete with missing artifact ranges. On resume, coverage is reconstructed only from retained observations, so evicted raw evidence is not falsely treated as current context. Changed versions reset coverage; reconciliation still revalidates file versions.
- A finalized incomplete child cannot be repeatedly resumed into the same tool-budget dead end. The parent can inspect its structured findings/missing evidence and explicitly assign a new focused independent review. No new reviewer is started automatically, and required gates cannot be bypassed.
- Activity and spawn/get results display configured/requested/effective calls and iterations, consumed/remaining counts, limited-batch admission/defer counts, repeated-result diagnostics and the final-assessment reason. Token termination reasons remain separate. Old records show their recorded task caps rather than inventing historical settings.

The OpenAI Docs skill informed the supported final-assessment control: OpenAI [function calling](https://developers.openai.com/api/docs/guides/function-calling) supports `tool_choice: "none"`; Anthropic [tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) support `tool_choice: {"type":"none"}`. Ollama final requests omit tool definitions. No endpoint or authentication mechanism was added.

## Verification

- TypeScript checking and production build passed. Existing large-chunk/Zod annotation warnings remain.
- Full regression suite: **894 passed, 9 skipped** across 102 passing test files and 2 skipped files. Final typecheck also passed.
- The exact boundary reproduction uses real scoped fixture reads through the production subscription adapter: 19 completed calls, then a request for three with one remaining. One read runs, two are deferred, and a third model request returns the assessment. Effective limits stay 20/12 under Settings 60/20. All 22 tool call IDs receive results; only 20 tools execute. The fixture has 246,700 tokens left, demonstrating that this is independent of token exhaustion.
- With 20 required evidence lines, the reviewer completes and can be explicitly reconciled. With 22 lines, the same returned PASS claim is overridden to blocked/incomplete, missing lines 21–22 are shown, acceptance fails, and automatic repetition is prevented. Serialized budgets and observations survive repository reload.
- Adapter fixtures cover OpenAI API, subscription, Ollama and Claude finalization. Additional tests cover current-settings propagation during the same parent, explicit workflow caps, 60/20 settings persistence, independent counters, invalid/failed calls, mixed-write batch deferral, iteration reservation, request retry, no-progress loops, missing/changed/evicted evidence and Activity diagnostics.
- Native Electron test passed: actual Settings form → secure IPC → persisted 60/20 preferences → slash command → isolated child → authorized filesystem → required gate → Activity UI. A screenshot is saved at `test-results/subagents-native.png`. Electron launch was blocked by the tool sandbox, then the same test passed with authorized native-app execution. Provider transport is simulated, not a live paid model review.

MBM-11400 files, external command definitions, credentials, live user settings, conversation history and mandatory independent review requirements were not modified. No live MBM-11400 review or automatic continuation was performed. This fix cannot guarantee enough evidence for every bounded task; insufficient evidence remains an explicit incomplete result, not success.

## Files changed

New:

- `electron/main/ai/subagentExecutionBudget.ts`
- `tests/subagentExecutionBudget.test.ts`
- `tests/subagentProviderBudget.test.ts`
- `docs/subagent-tool-budget-fix.md`

Modified:

- `shared/subagents.ts`
- `electron/main/ai/AIProvider.ts`
- `electron/main/ai/toolCallSession.ts`
- `electron/main/ai/subagentCoordinator.ts`
- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/OllamaProvider.ts`
- `electron/main/ai/claudeAPI.ts`
- `electron/main/ai/projectTools.ts`
- `src/features/chat/AgentActivity.tsx`
- `src/features/settings/SubagentSettings.tsx`
- `tests/subagentCoordinator.test.ts`
- `tests/toolCallSession.test.ts`
- `tests/subagentSettings.test.tsx`
- `tests/agentActivity.test.tsx`
- `tests/settings.test.ts`
- `tests/desktop/subagents.spec.ts`
- `docs/subagents.md`

Generated application build/package artifacts are separate from these source changes.

## Deployment

`npx electron-builder --mac --dir` passed. The rebuilt `release/mac-arm64/Athena.app` was locally ad-hoc signed and passed `codesign --verify --deep --strict`; no Developer-ID/notarized distribution signature is available. There was no running Athena task or process at relaunch. The rebuilt application opened successfully, showed the companion, and its live Settings UI displayed the new allocation guidance alongside the user's unchanged **60 tool calls / 20 iterations / 250,000 tokens**. No review was launched or approved, and no user settings were saved by this verification.
