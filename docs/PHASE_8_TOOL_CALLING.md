# Phase 8 — OpenAI tool calling

The existing Responses API loop already registered Athena tools and returned their results to the model. This phase reuses that loop and hardens its request-scoped dispatch rather than adding another autonomous agent architecture.

## Behavior

- Completed function calls are routed to the registered main-process executors. Those executors retain their strict argument validation, permission checks and approval UI.
- Unknown tool names, malformed/non-object JSON and oversized UTF-8 arguments return structured error results without invoking an executor.
- Incomplete calls and missing/duplicate call IDs stop a batch before execution. IDs remain tracked across rounds and automatic context/output recovery within the request.
- Access and cancellation are checked immediately before dispatch and after execution. Unexpected executor errors produce sanitized failures; explicit access/session errors stop execution.
- Each result is returned using the corresponding `call_id`. Reasoning items are preserved through the existing SDK conversion. The same model, conversation, activity history and working timer continue across steps.
- Requests containing any non-parallel-safe tools disable model-side parallel calling. Existing read-only parallel execution remains supported. Desktop effects and dependent actions execute sequentially.
- Existing call, round, timeout, output, continuation and spending limits remain in force. The final allowed round requests a truthful summary with tools disabled.
- Personality instructions distinguish confirmed results from OS submission, denial, cancellation and failure. They prohibit bypassing a denied action with another tool.

The implementation follows the [official OpenAI function-calling lifecycle](https://developers.openai.com/api/docs/guides/function-calling): retain response items, execute validated calls locally, return matching function outputs, and request the final response.

## Files

Created:

- `electron/main/ai/toolCallSession.ts`
- `tests/toolCallSession.test.ts`
- `tests/openAIToolLoop.test.ts`
- `docs/PHASE_8_TOOL_CALLING.md`

Modified:

- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/AIProvider.ts`

## Validation

- TypeScript: passed.
- Full Vitest suite: 431 passed, one skipped, across 46 files.
- New coverage: sequential multi-step flow, matching results and reasoning preservation, malformed/unknown calls, denied/failed results, interrupted streams, duplicate IDs, UTF-8 argument limits, pre-execution access checks, cumulative call budgets, cancellation, and final-round tool disabling.
- Existing conversation/approval, desktop, repository, recovery, voice, and animation tests remained passing.

Provider responses and native desktop actions are mocked in these tests. A paid live OpenAI request and native action flow have not been verified in this phase. Actual natural-language action selection depends on the selected tool-capable model; executor permissions are enforced regardless of the model response.

No new dependencies, environment variables, credentials, database migrations, renderer privileges, screen awareness or future-phase functionality are added.
