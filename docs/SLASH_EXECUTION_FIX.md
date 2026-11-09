# Slash command execution fix — 2026-10-11

## Verified causes

Live requests through Athena's existing ChatGPT Subscription account reproduced both response shapes using the current `/platform-init` definition. The server delivered complete reasoning, function calls, and summary text in SSE events, then `response.completed` with `output: []`. Athena previously discarded the completed items and treated that empty terminal snapshot as the entire response. This produced false empty-answer and failed-summary errors despite valid generated output. These were not reported token-exhaustion or usage-limit failures.

An additional configuration defect affected earlier runs with `gpt-6-sol`: its missing limits entry used the unknown-model fallback (16,384 context / 4,096 output), causing premature compaction. The exact model now uses verified limits, and explicit effort is validated rather than silently changed. See the [official model documentation](https://developers.openai.com/api/docs/models/gpt-6-sol).

The actual command definition is short and references `skills/platform-init/`. It was not too large. Existing project tools already retrieve files incrementally instead of appending an entire repository. Command expansion is not native Claude execution: it remains guidance for Athena's existing guarded agent.

## Changes

- A shared response accumulator retains completed output items, encrypted reasoning and function arguments across sparse terminal snapshots. It deduplicates visible text from delta/done events and never exposes reasoning as an answer.
- Tool execution still requires response completion, valid arguments, the existing permission checks and bounded tool rounds. Interrupted streams cannot execute pending calls.
- Subscription summaries use the same accumulator. Failed, empty or incomplete summaries do not replace history. Identical failed summary calls are not retried blindly. API output-exhaustion recovery requires an actual larger permitted budget; subscription calls never send unsupported API output-limit fields.
- Compaction retains the active user command verbatim, including when later repository excerpts are present. Summary effort is separate bookkeeping; the task's selected effort remains intact.
- Completed tool batches generate continuation checkpoints. Existing retry history preserves operation receipts and applied change IDs. No automatic whole-command rerun was added.
- Large definitions remain complete: the existing 64 KiB source-file limit is retained, while expanded instructions allow up to 128 KiB. Excessive argument expansion is explicitly rejected, not truncated.
- Removed the tool-context character cap that incorrectly counted encrypted reasoning as tool arguments. Individual argument limits and context budgets still apply.
- Diagnostics record model, effort, command name, instruction size, usage estimates/measurements, compaction attempts, response status, tool counts, stage and elapsed time—not tokens or repository contents.
- No UI redesign, database migration, dependency addition, provider fallback, credential change or permission expansion.

The implementation follows [documented subscription inference restrictions](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).

## Files

Created:

- `electron/main/ai/responseAccumulator.ts`
- `tests/slashResponseRecovery.test.ts`
- `tests/liveSlashProvider.test.ts` (opt-in; skipped in ordinary test runs)
- `docs/SLASH_EXECUTION_FIX.md`

Modified:

- `electron/main/ai/AIProvider.ts`
- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/contextManager.ts`
- `electron/main/ai/chatController.ts`
- `electron/main/ai/slashCommandService.ts`
- `shared/modelLimits.ts`
- `shared/conversations.ts`
- `tests/openAIProvider.test.ts`
- `tests/slashCommands.test.ts`
- `tests/slashCommandChat.test.ts`

Build output under `out/` and the existing packaged application under `release/mac-arm64/` are regenerated for deployment.

## Validation

- `npm test`: **637 passed, 3 skipped**, across 77 passing and 2 skipped files. Live tests are opt-in.
- `npm run typecheck`: passed.
- `npm run build`: passed; existing large-bundle and dependency annotation warnings remain.
- `npx electron-builder --mac --dir`: passed. The existing packaged Athena was gracefully closed, rebuilt and reopened; one application process was verified. Developer ID signing is unavailable in this local environment.
- Live raw command and summary probes reproduced sparse terminal snapshots; summary probe completed in approximately 5.4 seconds.
- Live repaired provider, selected `gpt-5.6-luna`, High effort, actual command expansion and existing read-only project tools: **passed**, 5 tool calls, 3 successful file reads, no tool errors, visible final answer, approximately **27.6 seconds**. No project/machine setup writes were exposed.
- Regression coverage includes sparse function/summary outputs, encrypted reasoning, duplicate text, stream interruption, summary failure/exhaustion, model limits/effort, full command expansion, no eager reference injection, oversized argument expansion, retry preserving completed changes, and existing provider/context/tool/composer behavior.

An initial diagnostic with a simplified read-only executor stopped at an excluded path. Validation was corrected to use Athena's actual project-tool adapter, which returns permission errors safely; no permission was broadened.

## Remaining limitations

`/platform-init` includes interactive Git preferences and optional credentials stored outside the project. The read-only live test verified workflow inspection and a final response, not those setup mutations. They still require the appropriate existing tools, user choices and permissions. Athena must not claim the machine setup completed without confirmed tool results.

Provider outages, account limits and genuine output/context exhaustion can still occur. They now remain distinct from an empty terminal snapshot, and failed compaction retains history. Subscription output limits remain provider-managed; Athena does not silently fall back to paid API billing.
