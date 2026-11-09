# Sub-agent token-budget exhaustion investigation — 14 October 2026

## Root cause confirmed from saved execution metadata

The saved Settings value is 250,000 tokens per child. However, the recorded parent tool requests explicitly allocated smaller lifetime budgets:

| Failed reviewer | Requested/effective child cap | Old Activity counter | Remaining before next request |
| --- | ---: | ---: | ---: |
| GPT-5.6 Luna, High | 60,000 | 54,803 | 5,197 |
| GPT-6 Sol, Medium | 12,000 | 8,018 | 3,982 |

These were not provider quota errors. The local preflight rejected the next request when `accumulated input estimate + accumulated output reservation + next input estimate + next output reservation > min(Settings total, requested total)`.

The previous implementation charged every request its estimated input plus the full 4,096-token output allowance immediately. Its cumulative-usage callback took the maximum of that value and reported usage, never releasing an unused allowance. Luna's counter was 38,419 + 4 × 4,096 = 54,803; Sol's was 3,922 + 4,096 = 8,018. Sol's remaining 3,982 could not even cover the next 4,096 output reservation before any input. Activity's “budgeted tokens” therefore represented conservative accumulated reservations, **not actual provider consumption**. The rejected next request was not included in the displayed counter.

The old records do not retain enough response usage to reconstruct historical actual consumption. The controlled test receipts below are fixture values, not recovered billing data.

## Budget path and corrected accounting

1. Settings are validated/persisted by the existing settings service. `main.ts` supplies them to the existing context/coordinator integration.
2. A child snapshots the current sub-agent settings. Its effective lifetime budget is the minimum of Settings and an explicit request cap. On continuation the previous effective cap and cumulative consumption are also preserved; settings changes do not silently grant a saved child extra tokens.
3. The tool schema and parent policy now instruct the parent to **omit** optional token/context caps to inherit Settings, rather than invent a small allocation. Explicit lower caps remain enforceable and visible in the spawn/get result and Activity.
4. The new ledger separates outstanding request reservations from consumed tokens. OpenAI and Ollama adapters emit a once-per-response receipt. Completed requests replace their reservation with reported input/output; repeated cumulative context updates do not charge again.
5. Reasoning is a subset of output, not an additional charge. Tool arguments belong to output; returned tool evidence belongs to subsequent request input. Repeated input on separate model requests legitimately counts again. Cached input is not charged twice as an additional token quantity.
6. Missing/malformed usage, interrupted requests and legacy counters retain explicitly labelled conservative estimates. Pending reservations are retained once across interruption/resume. No unsupported exact usage is invented.
7. Per-request context is checked separately against the child cap and the adapter's model window. Existing verified model/output limits and conservative unknown-model fallbacks are unchanged. Children still disable automatic compaction, so there are no hidden summarizer calls to evade their budget.
8. Genuine exhaustion stops before the next request/tool and saves a typed reason plus the actual preflight arithmetic. Successful operations, file versions, read coverage and observations remain persisted. Required review gates remain incomplete until a real independent review completes and the parent reconciles it.

Activity now shows configured, child-allocated and effective budgets; measured and estimated consumption; outstanding reservations; remaining/available capacity; model context/output constraints; last request input/output needs; and the termination reason. The existing collapsed Activity presentation is preserved.

The OpenAI-docs skill's official usage guidance informed the separation of input, output and included reasoning: [reasoning usage](https://developers.openai.com/api/docs/guides/reasoning) and [token counting](https://developers.openai.com/api/docs/guides/token-counting). Existing model entries were checked against the official [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) pages; neither model nor its limits was changed.

## Verification

- `npm test`: **876 passed, 9 skipped**; 100 test files passed, 2 skipped.
- `npm run typecheck`: passed.
- `npm run build`: passed. Existing dependency annotation and large-bundle warnings remain.
- `npx playwright test tests/desktop/subagents.spec.ts`: **1 native Electron integration test passed**. Real secure IPC, slash-command loading, coordinator, scoped filesystem reads, review gate, persistence and Activity UI were exercised with simulated provider transport and an isolated temporary profile.
- Focused production OpenAI adapter cold-read fixtures completed using unchanged Sol/Medium 12,000 and Luna/High 60,000 child caps. Their controlled provider receipts totalled 6,800 and 45,600 respectively. They performed 3 and 7 real fixture filesystem tools, retained evidence, and passed reconciliation only after full artifact coverage. No parent chat history was supplied to either child.
- Native Activity displayed Settings 250,000, explicit cap 12,000, consumed 2,400 and remaining 9,600 from two controlled receipts, with zero lingering output reservation.
- A genuine later-request exhaustion test preserved the completed read, file version and budget diagnostics through disk reload and refused the mandatory review gate. Other regressions cover unchanged caps on resume, legacy estimates, context limits, unknown models, duplicated receipts, reasoning inclusion, missing/malformed usage, cancellation, timeout and provider-managed output exceeding a reservation.
- `npx electron-builder --mac --dir`: passed. The arm64 app is at `release/mac-arm64/Athena.app`. Local ad-hoc signing and strict deep signature verification passed. No Developer-ID/notarized distribution signature is available.

No live paid-provider review was run; these tests establish engine/accounting correctness, not current provider availability or the quality of a real review. MBM-11400 artifacts, its independent-review requirement, live conversations, account credentials, selected models and saved limits were not modified. The user's running Athena process was not restarted or interrupted; relaunch the rebuilt bundle to load the fix.

### Deployment follow-up — 14:38 local time

The subsequently reported identical screenshot came from the old running process (started 13:59:54), predating the fixed `app.asar` (built 14:27:49). Saved metadata confirmed attempt 3 of the same 12,000-token child, still at one iteration / three tools / 8,018 old budgeted tokens, with no version-2 budget receipt. The latest parent message was stopped, not executing.

On the user's continuation request, Athena was gracefully quit and the rebuilt bundle relaunched. The new main process started at 14:38:10. The restored conversation visibly displayed the new “Legacy budgeted estimate: 8,018” and “Child-requested total cap: 12,000” diagnostics. No review request, specification edit, quota change or automatic replay was performed. The historical failure remains history; its exhausted three-attempt child should not be resumed again. A deliberately new independent cold-read child may inherit the configured Settings budget while the parent continues the existing workflow and preserves all mandatory gates.

## Limitations and existing interrupted reviews

- Subscription output length remains provider-managed: Athena's reservation is an estimate, not a provider-side output ceiling. If actual output exceeds the effective lifetime budget, the receipt is saved and no further request/tool is started. Provider quotas and authentication failures remain separately enforced.
- Claude's current adapter does not supply per-response usage, so its child accounting remains conservative and labelled estimated. Existing unsupported dollar-cap restrictions remain in place.
- Historical inflated counters cannot safely be reconstructed or reset. A truly exhausted legacy child may still require a deliberately new bounded independent review using the saved artifacts. This does not restart the parent workflow, alter the specification, or mark the review passed. No replacement review was launched automatically.

## Files changed for this fix

New:

- `electron/main/ai/subagentBudget.ts`
- `tests/subagentBudget.test.ts`
- `docs/subagent-budget-fix.md`

Modified:

- `shared/subagents.ts`
- `electron/main/ai/AIProvider.ts`
- `electron/main/ai/subagentCoordinator.ts`
- `electron/main/ai/contextManager.ts`
- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/OllamaProvider.ts`
- `src/features/chat/AgentActivity.tsx`
- `src/features/settings/SubagentSettings.tsx`
- `tests/subagentCoordinator.test.ts`
- `tests/contextManager.test.ts`
- `tests/agentActivity.test.tsx`
- `tests/localAI.test.ts`
- `tests/desktop/subagents.spec.ts`
- `docs/subagents.md`

Generated build/package outputs were refreshed. No new dependency, database, provider endpoint, permission bypass or model change was introduced.
