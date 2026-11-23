# Sub-agent preferences and model-aware context repair

## Confirmed causes

The existing `SubagentSettings` fieldset and submit handler required `useChat.snapshot.phase === 'idle'`. Preferences were therefore locked by unrelated chat activity or an uninitialized chat snapshot. The component also looked up string-only model IDs through the legacy global `aiMode`, instead of the selected conversation's account route and Unified Models catalog. Cursor hid model controls entirely. Only the initial Git commit (`0c0fbdb`) exists locally, and that commit already contains the phase gate; a separate Unified Models regression commit cannot be identified.

The 64,000 maximum existed in the input and both settings/request schemas. Child execution explicitly disabled compaction, did not give provider context management the child's smaller allocation, and could rebuild its context ceiling from changed Settings on resume. Context managers could accept a request against the much larger model window, followed by rejection in the child's smaller budget ledger. Several gateway budget callbacks also measured messages without tool definitions, and gateway output settings could override the child output allocation.

Opening AI Settings before Conversation also left the inherited parent model unset in the renderer. The repaired component uses the existing revision-aware `connectChat` subscription, which loads the saved conversation without starting inference.

## Changes

- Existing controls remain editable while chat is active or accounts are disconnected. Only an in-flight save temporarily disables submission. Controlled inputs provide validation and save/error feedback.
- The existing Unified Models catalog supplies account-qualified model choices. Stable provider/account/model identities, independent default and cold-read choices, inheritance, legacy selections and unavailable saved models persist. Catalog refreshes do not reset drafts. Efforts come from advertised or existing trusted capability metadata, including none/minimal/max where supported.
- Explicit child choices are passed into the existing provider factory. Parent authorization, file scopes, write approvals, cancellation and provider launch checks remain in force. Local-only conversations reject online routes rather than silently interpreting them as local models. Routed ChatGPT API children are no longer blocked by the unrelated legacy Codex CLI preference. Claude's existing supported effort mapping is used instead of its obsolete Auto-only child gate.
- Removed the universal 64,000 ceiling. Context values must be positive safe integers, with an effective allocation calculated from the selected integration's documented/reported/configured capacity, runtime restrictions, known request-size ceilings, safety margin, task-specific lower cap and saved allocation. Unknown capacity is explicitly labelled and uses a conservative fallback; gateway capacity is never inferred from a GPT name.
- The context setting includes input and reserved output. Total child tokens remain a separate cumulative input/output allowance. Settings and Activity display configured/effective context and limiting reasons; the UI warns about increased usage consumption.
- Each new child records a settings snapshot and account route. Running/resumed children retain original allocations and consumption. Legacy ledgers retain the previous effective cap. Increasing Settings does not silently replenish a saved child; an explicitly new bounded review is required to obtain a larger allocation.
- Child context managers receive the effective per-request allocation before inference. Existing protocol-preserving local compaction condenses older tool evidence, retains IDs, instructions, recent results and original saved records, and fails explicitly if essential pinned content still cannot fit. Child OpenAI requests use this local compaction rather than an unreserved extra summary/native compaction call. It respects the existing automatic-compaction preference.
- All applicable adapters count complete serialized request context and use the child output allowance where their declared protocol capabilities support it. Cumulative receipts and unknown interrupted-request reservations survive compaction and restart.

## Budget calculation

Effective allocation is the minimum of the configured budget, explicit task lower allocation, saved child ceiling, and the most restrictive model/runtime/payload capacity after the safety margin. Output is reserved inside that allocation, not added above it. Actual instructions, tools, history, attachments and results are estimated before every request, and provider usage settles the cumulative ledger when available.

Examples with the existing 15% default margin:

- Configured 512,000 and reported 1,050,000 context: effective 512,000.
- Configured 512,000 and runtime context 128,000: effective 108,800.
- Configured 512,000 with a 500,000-byte request ceiling: conservative effective 106,250 before exact serialized-size validation.
- Unknown capacity: effective at most 13,926; shown as unverified, not a guaranteed model window.

A configured gateway context is labelled configured, not provider-verified. Exact request-size checks remain authoritative. Original conversation messages and saved tool observations are not deleted by request compaction.

## Files changed for this task

Shared contracts/capacity: `shared/subagents.ts`, `shared/subagentContext.ts`, `shared/unifiedAccounts.ts`.

Settings and Activity: `src/features/settings/SubagentSettings.tsx`, `src/features/settings/AISettings.tsx`, `src/features/chat/AgentActivity.tsx`.

Runtime: `electron/main/ai/subagentCoordinator.ts`, `subagentBudget.ts`, `chatController.ts`, `unifiedAccounts.ts`, `AIProvider.ts`, `contextManager.ts`, `protocolContext.ts`, `OpenAIProvider.ts`, `claudeAPI.ts`, `OllamaProvider.ts`, `thirdPartyInference.ts`, and `electron/main/main.ts`.

Tests: `tests/subagentSettings.test.tsx`, `subagentContext.test.ts`, `subagentBudget.test.ts`, `subagentCoordinator.test.ts`, `subagentProviderBudget.test.ts`, `unifiedAccounts.test.ts`, `thirdPartyInference.test.ts`, and `tests/desktop/subagentPreferences.spec.ts`.

The workspace already contained substantial changes from earlier tasks. This list identifies files edited for this repair, not ownership of all existing differences from HEAD.

## Validation

- Final combined sub-agent/settings/registry/adapter suite: 274 passed, 1 skipped.
- Adapter/regression suite: 163 passed; one existing live Ollama benchmark could not run because its expected installed model was not being served.
- Final settings/inherited-model/context regression subset: 39 passed.
- Real Electron renderer, IPC, disk persistence, navigation and process restart in an isolated profile: passed. No provider inference or real credentials used in that test.
- Full host suite: 2,078 passed, 48 skipped, 11 existing failures. These are the same known baseline failures in buildIsolation (development-script expectation), contextEngine (Ollama live model unavailable), outputRecovery (legacy effort/error wording expectations), systemVoiceRollback (resource-array index expectation), and voiceToolIntegration (legacy model fixture).
- TypeScript check and macOS ARM64 production package/signing passed. macOS signature verification passes outside the execution sandbox, where the existing local certificate trust is available.
- Protocol/tool payload tests use mocks. They cover OpenAI Responses/subscription transport, Anthropic, Ollama, OpenAI-compatible gateways, Gemini and Bedrock adapters; local compaction tests exercise all six protocol formats. They are not live claims about every provider.

## Limits retained

Native Cursor, Copilot, Antigravity and legacy Codex app-server child execution remains unavailable where Athena cannot enforce isolated tools or per-request budgets. Preferences are editable and saved for those selections; launch reports the actual restriction. This change does not invent new native child interfaces or add providers absent from the registry.

Ollama's existing local child path uses its reported/configured runtime allocation; online account routes cannot be executed through that local-only factory. Model metadata absent from the existing registry remains unverified. Subscription output length can remain provider-managed; reservations are labelled estimates, not hard provider quotas. Settings changes cannot retroactively enlarge a running/resumed child's allocation. No live provider task, paid inference or project modification was performed to validate this repair, and no Windows production build was tested on this Mac.

## Deployed verification

The final signed macOS ARM64 app was restarted and inspected in the real desktop UI. Sub-agent controls are editable; opening AI Settings directly resolves the saved parent model and displays its configured/effective allocation immediately. The user’s existing 64,000 configured context preference and 500,000 cumulative token preference were retained rather than silently increasing consumption. All 32 saved conversations and 1,565 saved message IDs, the active conversation and sub-agent preferences survived restart. Only the packaged Athena process was restarted; the existing development process retained its PID. The isolated Electron persistence/restart test passed again against the final compiled build.
