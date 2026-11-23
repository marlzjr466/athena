# Athena workspace write fix — 2026-11-13

## Root cause

Athena approved execution but compiled a source-read-only macOS Seatbelt profile. The profile allowed scratch/build/cache output; it did not allow `src/api/generated`. Cursor uses its own `run_command` MCP bridge, so the earlier optional `write_paths` change to the shared project tool did not reach that bridge. This was an Athena authorization-to-child-process-policy mismatch, not a demonstrated macOS owner/TCC issue. The real generator succeeds under the corrected sandbox.

## Implementation

- `electron/main/permissions/sandboxCommandPermission.ts`: shared write intent; read-only check grants cannot authorize writable commands.
- `electron/main/ai/agentCommands.ts`: canonical workspace grant propagated into the existing Seatbelt profile and inherited by subprocesses; fresh authorization/root-identity checks after queueing; selected deletion policy enforced.
- `electron/main/ai/agentTools.ts`: normal approval path grants project writes to development commands, with optional `workspace_write` and narrower `write_paths` scope. Read-only validation remains the default for existing check commands; explicit writable validation gets a separate approval.
- `electron/main/ai/cursorTerminal.ts`, `cursorCommandServer.ts`, `cursorACP.ts`: same write intent and effective sandbox permissions through Cursor MCP/ACP; deletion follows project settings.
- `electron/main/ai/commandFileAccess.ts`: narrow output grants support missing descendant directories and reject traversal/symlinks.
- `electron/main/ai/mlxProjectTools.ts`: local-tool instructions describe the shared contract.
- `electron/main/ai/chatController.ts`: project permission changes stop the correct background conversation task.
- Regression changes: `tests/projectCommandWrites.test.ts`, `projectCodegen.live.test.ts`, `sandboxCommandPermission.test.ts`, `cursorCommandServer.test.ts`, `fullAccess.test.ts`.

These paths already contained other user changes; those were preserved. No staging, commits, pushes, permission chmod, or sandbox bypass were used for project generation.

## Security verification

Real sandbox tests reproduced EPERM without the grant and succeeded after normal authorization. They covered creation/update, nested directories, npm scripts and Node subprocesses, Ask/Advanced/Full Access approvals, denied approval, read-only grants, stale queued authorization, fresh runner instances, deletion disabled/enabled, traversal, outside writes, symlink escapes, and protected `.git`, `.claude`, `.env`, key material, package metadata and dependency files. Network and dependency permissions remain separately controlled. The outer test harness required elevation to launch nested Seatbelt; actual development commands still ran through `/usr/bin/sandbox-exec`.

## Provider coverage

| Provider/path | Verification |
| --- | --- |
| Cursor subscription | Command bridge sandbox tests, MCP transport tests and real workspace codegen through the same bridge and central approval service |
| ChatGPT subscription | Codex adapter regression tests; project commands route through the corrected shared tool service |
| OpenAI API | Tool loop regression tests; shared service |
| Claude API | Adapter regression tests; shared service |
| GitHub Copilot | Adapter regression tests; shared service |
| Local Ollama / MLX | Text/tool loop and execution regression tests; shared service |
| Google Antigravity | Official ACP adapter regression tests, including catalog model fixtures; uses its own `--sandbox` terminal runtime, not Athena AgentCommands. Native sandbox was not bypassed or loosened |

The final affected-suite run passed **211 tests across 14 suites**, with **11 skipped** optional/live cases. These are adapter/fixture tests, not live paid-provider/model runs. Antigravity live model filesystem behavior remains unverified. GraphQL, Webpack/Rspack and other individual toolchain installations were not each run; the shared nested-write mechanism was tested independently of tool names. Existing Full Access conversation restoration tests passed.

## Real map-governance-ui verification

Executed `npm run generate:api` through the real CursorTerminalBridge, AgentCommands sandbox, ChatController approval and WorkspaceService path using a controlled test driver (no live AI request): **exit 0**. All nine generated clients were written, including `src/api/generated/health-api.ts`. Health's content was unchanged; its write timestamp advanced. The only generated Git diff is `src/api/generated/governance-api.ts` (+13/-38).

- Generated TypeScript syntax: **10 files passed**, including the generated index.
- API tests: **3 suites, 92 tests passed** (`openapiCodegen`, `openapiContract`, `governanceCertificationReviewApi`).
- Project typecheck: **failed** on application/test type errors. Errors include missing generated `CertificationReview` / `ApprovalHistoryEntry`, unknown API response types, unrelated component/test typing issues and missing `istanbul-lib-coverage` declarations.
- Inspection found the current, pre-modified `contracts/openapi.yaml` response for certification-review uses a direct response `schema` property; generation emits an unknown response and omits unused schema types. The contract was not changed to work around the filesystem issue.
- Original user modifications to `contracts/openapi.yaml` and `src/api/endpoints/endpoints.ts` were preserved byte-for-byte. Package/config hashes and the Git index were unchanged. No next project implementation stage was started.

Full machine-readable results: `real-project.json` and `verification.json` in this directory. Athena typecheck, production build, packaging, and local signing passed. The old app process (42617) exited and the rebuilt app restarted as process 70366. The sandbox failure is resolved, but the requested end-to-end project verification is not entirely green because project typecheck fails.
