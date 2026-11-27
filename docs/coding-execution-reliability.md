> Historical audit: the subscription execution path below has since been replaced by [native Codex execution](native-codex-execution.md). Its timing evidence describes the earlier implementation.

# Coding-agent execution reliability

Verified on macOS arm64 on November 25, 2026. The archived Metrobank conversation was inspected read-only. All provisioning writes and grants used for testing belonged to disposable fixtures.

## What happened in the Metrobank run

The archived request contained 5,449 characters in the message itself and had no attachment. Changing the project mode from Ask to Full Access stopped the first attempt after 26 seconds. The next attempt ran for 5 minutes 46 seconds, recorded 136 completed activities and four errors, and ended on a connection deadline with zero recorded file changes. Two subsequent initialization failures had no activities.

The 25 minute 58 second turn used ChatGPT Subscription, requested `gpt-6-astra` with high reasoning, and recorded **53 tool rounds, 153 tool invocations, 158 activities, 146 completed activities and 12 errors**. Activity counts include child work. There was one transport recovery, zero output continuations and zero context compactions. The older trace has the routed model identifier and lacks an independent model identifier from the response.

| Observed evidence | Finding |
| --- | --- |
| Four `edit_file` failures required a fresh read after continuation. | Transport recovery activated the read guard. Successful edits then cleared the entire fresh-read map. A read for one path could become unusable after a successful edit to another path. |
| Three sandboxed provisioning or verification commands exited 2 and reported missing `E2E_BACKEND_ADMIN_TOKEN`. | Commands ran with a filtered environment and noninteractive stdin. The command interface supported exact file-read approval but had no private way to supply a named environment variable from a credential file. The trace establishes what those subprocesses saw. It cannot establish whether a valid credential existed elsewhere. |
| Three reviewer activities lasted 107.7, 105.8 and 112.7 seconds and ended blocked. | Reviewers consumed real elapsed time. Child work can overlap other activity. Their durations cannot be added to derive the controller's overhead. The trace alone does not establish duplicate assignments. |
| One credential-related read denial and one missing-file read. Initial and final Git observations showed the same project and `feature/sandbox-dev`. | Intermediate Git status listed four untracked paths which disappeared from the later observations. The missing paths were `scripts/local_e2e.py`, `scripts/local_e2e_workflow.py`, `scripts/test_local_e2e.py` and `docs/local-e2e.md`. The archive does not identify the process that removed or moved them. |
| The assistant paused writes in its response. | The quoted filesystem warning was assistant-generated text. The recorded edit refusals came from the separate read guard. There is no evidence of a branch switch or Athena automatically rolling back the four paths. |

The reported 19-minute standalone Codex run could not be matched to a local historical trace. The original timing difference cannot be attributed reliably to the model, the tool runner, or the network alone.

## Changes and execution path

A normal chat submission resolves its conversation, model and account, prepares the authorized workspace and attachments, and creates one host execution. Both the subscription Responses adapter and Codex app-server dispatch project operations through the host tool boundary. The latter starts an ephemeral read-only native thread and exposes Athena's registered tools under its own permission rules. Standalone Codex has its own environment and permissions.

- **Continuation and replay.** Typed continuation and question answers reconnect to the unfinished task. Handoffs retain the full objective, current task attachments, answered questions, known child IDs, verification results and pending work. Oversized or ephemeral protocol checkpoints invalidate an older saved snapshot. Completed or uncertain side-effecting operations require review before repetition. Duplicate native call identifiers are rejected. Interrupted streams suppress exact retransmission of already displayed progress.
- **File and Git state.** Successful edits retain verified file hashes. Subsequent writes compare the current target, workspace and Git reference. Changed paths require individual review, including previously recorded writes from older checkpoints without hashes. A declined conflict preserves that file and allows independent work on other files. Creating a file uses an exclusive install to protect a competing new file.
- **Command results and credentials.** The user can approve a specific credential-named project JSON file and specific environment variable names for one command. The macOS sandboxed child loads the values, and its stdout and stderr are suppressed. Only the reference survives continuation. Reuse requires new approval. Verbose commands drain to their actual exit. Tests, builds, lint, type checks and dependency installations have a longer command window. Shortened tool output retains its outcome and exit code.
- **Execution control.** Concurrent invocations have distinct receipts. Repeated identical failures are tracked across unrelated reads. Concurrent approval prompts are queued. Project inactivity deadlines refresh on execution progress and pause for approvals. Mutation receipts are saved before dispatch and after completion. Read bookkeeping is coalesced, reducing whole-library saves. The inspected conversation store was approximately 44 MB. No historical disk-time measurement was available.
- **Diagnostics.** Expand **Execution diagnostics** beneath an assistant response to inspect the run, model, reasoning setting, operation class, start time, elapsed time, exit code and outcome. New receipts identify their run. Older receipts have only the metadata recorded by their release. An unresolved operation remains visible even if the model finishes its response. A successful subprocess exit records process completion. The fixture independently verifies the external application state.

## Reproduction and verification

The fixture creates a new project and profile, a random test credential and a loopback HTTP service with distinct account creation, authentication and protected API endpoints. The authoritative counters belong to the service. It rejects a duplicate creation attempt. Both transports received the same prompt, model, high reasoning, project tool scope and equivalent credential grants. The Codex test verifies that the subscription and CLI identities match before sending the prompt, then asserts the execution's actual provider ID.

| Signed build / transport | Submit to terminal result | Create attempts / creations | Successful logins / protected reads |
| --- | ---: | ---: | ---: |
| Previous Athena, subscription adapter, verified baseline | 6.07 s | 0 / 0 | 0 / 0 |
| Updated Athena, subscription adapter | 17.35 s | 1 / 1 | 1 / 1 |
| Updated Athena, Codex app-server | 19.34 s | 1 / 1 | 1 / 1 |

Both updated transports reported `gpt-6-astra`. Both recorded two exit-zero commands. The previous build disclosed its limitation and made zero service requests. Its response ended normally even though the provisioning objective remained incomplete. An initial baseline test took 8.04 seconds and failed its overly specific expectation that the model would attempt unsupported arguments. The corrected test accepted an explicit blocker and verified the same zero-effect outcome against the previous binary. These measurements are individual runs of the small fixture. They do not predict production provisioning time.

A separate fault-injection test used real macOS sandboxed subprocesses, files, HTTP requests and persisted conversation data, with a scripted provider to force interruption after creation. A command without secure input produced exit 2. After a grant, creation succeeded. Following controller restart, the fixture received zero repeated creation requests, one login and one verified private read. The controller preserved an externally edited file, permitted edits to an independent file, and retained the complete long objective. The test checked that the random credential value was absent from persisted conversation data.

The complete Vitest run passed **2,285 tests**, with **56 skipped** and **zero failures**. The signed-app tests for both updated subscription transports passed. Type checking, the production build and local code-signature verification passed. Existing assertions for permission tooltips and the development launcher were updated to verify their current behavior. API and subscription Auto reasoning have separate wire-level expectations and tests.

## Files changed

| Area | Files |
| --- | --- |
| Task and recovery | `electron/main/ai/chatController.ts`, `continuationController.ts`, `contextManager.ts`, `chatContextService.ts`, `subagentCoordinator.ts`, `shared/generation.ts` |
| Provider and dispatch | `electron/main/ai/AIProvider.ts`, `OpenAIProvider.ts`, `CodexAppServerProvider.ts`, `toolCallSession.ts`, `applicationTools.ts`, `mlxProjectTools.ts` |
| Commands, files and results | `electron/main/ai/agentCommands.ts`, `agentEdits.ts`, `agentTools.ts`, `agentEfficiency.ts`, `projectGitService.ts`, `toolOutcome.ts`, `toolOutput.ts` |
| Interface | `src/features/chat/AgentActivity.tsx`, `src/features/settings/ContextSettings.tsx` |
| Tests | `tests/codingExecutionReliability.test.ts`, `tests/fixtures/provisioningWorkspace.ts`, `tests/desktop/codingExecution.spec.ts`, `tests/codexAppServerProvider.test.ts`, `tests/openAIProvider.test.ts`, `tests/outputRecovery.test.ts`, `tests/agentActivity.test.tsx`, `tests/attachments.test.ts`, `tests/athenaChatView.test.tsx`, `tests/contextSettingsLocation.test.tsx`, `tests/buildIsolation.test.ts` |

The HTTP service models the provisioning sequence. It is independent of Metrobank, Keycloak and the bank's APIs. Windows execution and the historical standalone Codex environment were not tested. Live tests used subscription authentication. No paid API fallback or production credential was used. A real provisioning run still requires a valid user-authorized credential source, appropriate network scope, and independent verification against its intended target.

The locally signed app was restarted at its original release path. macOS reported the replacement process ready (PID 35907, previously 73720).
