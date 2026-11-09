# Isolated sub-agents

Athena delegates through its existing provider adapter and project tool dispatcher. A child is a new provider conversation with fresh tool state, its own ID, transcript, abort signal, budgets and result. No provider thread, parent checkpoint, attachment, repository retrieval or conversation history is copied implicitly. No nested delegation is exposed.

## Using a reviewer

Persist review artifacts, then use `spawn_subagent` with a stable `taskKey`, role, task, criteria and explicit project-relative `files`. `cold_read` is the default. It exposes only file reads and metadata for those exact paths. Review completion requires successful coverage of every file, not just a directory listing or first page.

`scoped` accepts a selected summary and file/subdirectory scope. `shared` also accepts explicit message IDs (at most four, 12,000 characters combined). Neither mode automatically imports parent history. Repository content is untrusted evidence. Credentials and Claude/Codex configuration are excluded from delegated scope.

Spawn independent read-only assignments, then `wait_subagents` with their IDs. Wait returns statuses; `get_subagent` returns the summary and result counts. Page through findings, blockers, evidence, reviewed files, checks, limitations and next actions with `section` and `offset`. This keeps structured JSON intact within normal tool-output limits. Complete results remain in Activity and conversation storage.

The parent compares evidence and conflicting findings, then calls `reconcile_subagent` with its decision and explanation. A completed child is **not** automatically an accepted review. Error findings or blockers prevent acceptance. Reviewed artifact versions are rechecked on acceptance and at parent completion. Keep the reviewed artifacts available and unchanged until the parent execution ends; changed artifacts require a new independent review.

## Workflow declarations

All existing custom commands, including `/platform-spec`, `/platform-review` and `/platform-build`, can declare required child steps. Add an `athena-subagents` JSON fence in the command Markdown, or a single-line JSON array in the existing `subagents` frontmatter field:

```athena-subagents
[
  {
    "id": "spec-review",
    "required": true,
    "mode": "cold_read",
    "role": "Independent specification reviewer",
    "task": "Review the saved draft against the exit criteria.",
    "criteria": "Identify ambiguous, contradictory or unsupported requirements.",
    "files": [".tmp/define.md", ".tmp/tds.md"],
    "toolScopes": ["filesystem-read"],
    "maxIterations": 24,
    "maxToolCalls": 40,
    "timeoutMinutes": 10,
    "expectedResultSchema": "athena-review-v1"
  }
]
```

Call `spawn_subagent` with `gateId: "spec-review"`. The declaration constrains the request; it does not grant permissions. Optional `model`, `effort` and `parallelGroup` metadata is supported. Invalid metadata stops the workflow. Existing prose explicitly calling for a cold-read sub-agent creates a required `cold-read-review` gate; the parent must select its artifacts and criteria. Athena refuses to mark the execution complete until every required gate has been independently executed and reconciled. External command files and project status files are not rewritten automatically by this feature.

## Permissions, providers and budgets

Settings → AI → Agent execution · Sub-agents controls enablement, models, effort, concurrency, iteration/tool/time/context/token limits and delegation approval. Defaults: two concurrent read-only workers, 24 iterations, 40 tools, ten minutes, and approval for write-capable workers. Writes run exclusively; parent mutation tools wait for running children. Existing per-tool approvals, version checks, Git review and browser permissions still apply. Child commands retain a project-only sandbox even if the parent has Full Mac Access. Child-owned development servers are cleaned up independently.

Models stay with the selected provider/account. Overrides are validated; there is no silent fallback. OpenAI API and subscription adapters use existing supported tool calling. Ollama requires verified tool capability; models without graded reasoning require Auto, and unsupported Extra High is rejected rather than downgraded. Claude currently requires Auto effort and rejects dollar-capped children because its adapter cannot account for that cap. Cursor’s native execution adapter cannot enforce child scopes, so delegation is unavailable. Computer-use tools are not delegated. Cloud workers remain blocked in Strict Offline Mode.

Iterations and tool calls are child-local. Omit `tokenBudget` and `contextTokens` to inherit Settings; explicit values are lower caps, not suggestions or per-response output allowances. Total tokens sum input plus output across requests; the context cap applies to one request and cannot exceed the provider's reported model window. A request reserves input and output capacity, then replaces that reservation with reported usage when available. Reasoning is already included in output; tool results are counted within input on each request that sends them, not charged again as a separate counter. Unreported/interrupted requests and unreconstructable legacy counters remain labelled conservative estimates. Activity shows configured, allocated and effective limits, consumption, active reservation, remaining capacity, model constraints and the exact termination/preflight arithmetic. See [the token-budget investigation](subagent-budget-fix.md).

Also omit `maxIterations` and `maxToolCalls` to inherit current Settings. Explicit task/workflow values are lower lifetime ceilings and are visible in Activity. New children read current preferences; saved children retain their original ceiling and consumed counters. Each attempted tool (including invalid or failed attempts) counts once; deferred calls do not. A final tools-disabled assessment uses one reserved iteration inside the existing cap. Oversized independent read batches admit only the calls that fit; dependent/writing batches defer in full. Four consecutive results without new usable evidence stop further exploration. Missing artifact coverage always blocks a cold-read approval. See [the tool-call budget investigation and tests](subagent-tool-budget-fix.md).

Child API cost reservations count against the existing parent dollar cap; subscription quotas and output length remain provider-managed. Children disable automatic compaction: a context-limit failure is distinct from lifetime token exhaustion, and there are no hidden paid summarizer requests in a child. OpenAI and Ollama adapters report per-response usage when supplied; Claude currently retains conservative estimates because its adapter does not report usage. Concurrency cannot exceed four; one parent can create at most twelve child tasks. Budget exhaustion does not grant additional permission.

## Recovery

Cancel one child from its expanded Activity row or with `cancel_subagent`. Cancel all with the existing parent Stop action. Completed operations, findings and file changes remain saved. Restart marks active children interrupted; nothing is replayed automatically.

`resume_subagent` restores the same logical child ID, selected context, observations, file hashes and cumulative budgets, including its dollar cap. It validates project/account, current review requirements and unchanged artifacts first. Write-capable continuations recheck delegation approval. Completed saved results are restored without repeating work and must be reconciled by the new parent execution. Failed runs can make up to three explicit attempts within their cumulative budget. A changed artifact or review criterion requires a deliberately new reviewer to preserve independence.

## Implementation verification — 14 October 2026

- `npm test`: 862 passed, 9 skipped; 99 test files passed, 2 skipped.
- `npm run build`: passed, including TypeScript checking. Existing large-bundle and dependency annotation warnings remain.
- `npx playwright test tests/desktop/subagents.spec.ts`: passed (1 native Electron test). An isolated profile exercised the real secure IPC, slash-command loader, provider adapter, child coordinator, filesystem reads, workflow gate, persistence and Activity/Settings rendering. Provider transport was simulated; this does **not** certify live paid-provider availability or review quality.
- `npx electron-builder --mac --dir`: passed. The arm64 app was locally ad-hoc signed and passed strict deep signature verification; it is not Developer-ID signed/notarized for distribution. The previous Athena process was gracefully closed, the new package restarted, and its live UI showed Companion ready and the new Sub-agents settings with saved project context intact.
- Thirty coordinator tests cover independent contexts, concurrent readers, permission rejection, write exclusivity, cancellation, timeout, independent budgets, malformed and partial reviews, contradictory findings, persistence, continuation and stale evidence/criteria. Additional UI, provider, settings, command-loader and managed-process tests cover the integration boundaries.

No new dependencies, database, authentication endpoint or duplicate provider stack was introduced. External workflow definitions are not rewritten: declarations are interpreted by the existing loader, and legacy cold-read requirements are recognized. Cursor delegation and delegated computer use remain unsupported; provider-specific reasoning and cost-accounting limitations are described above. Subscription output length remains provider-managed; Athena bounds its requests, time, tools and locally collected output rather than claiming an exact provider-side token cap.

### Files created

- `shared/subagents.ts`
- `electron/main/ai/subagentCoordinator.ts`
- `electron/main/ai/subagentWorkflow.ts`
- `src/features/settings/SubagentSettings.tsx`
- `tests/subagentCoordinator.test.ts`
- `tests/subagentSettings.test.tsx`
- `tests/desktop/subagents.spec.ts`
- `docs/subagents.md`

### Files modified

- `shared/settings.ts`
- `shared/agent.ts`
- `shared/conversations.ts`
- `electron/main/main.ts`
- `electron/main/ai/AIProvider.ts`
- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/OllamaProvider.ts`
- `electron/main/ai/claudeAPI.ts`
- `electron/main/ai/applicationTools.ts`
- `electron/main/ai/contextManager.ts`
- `electron/main/ai/agentTools.ts`
- `electron/main/ai/developmentServer.ts`
- `electron/main/ai/chatController.ts`
- `electron/main/ai/chatContextService.ts`
- `electron/main/ai/conversationRepository.ts`
- `electron/main/ai/slashCommandService.ts`
- `src/features/settings/AISettings.tsx`
- `src/features/chat/AgentActivity.tsx`
- `src/features/chat/agentTimelinePresentation.ts`
- `tests/agentActivity.test.tsx`
- `tests/settings.test.ts`
- `tests/slashCommands.test.ts`
- `tests/chatContextOpenAISearch.test.ts`
- `tests/developmentServer.test.ts`
- `tests/localAI.test.ts`
