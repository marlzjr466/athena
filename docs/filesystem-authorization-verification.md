# Filesystem authorization verification — 2026-10-19

## Findings and evidence

The reported fixture denial is reproducible in the current filesystem service.
`skills/platform-init/fixtures/edge-existing-credentials.json` matches the
case-insensitive credential filename rule in `workspaceService.ts`. Full Mac
scope does not override this rule. In Full Mac mode its diagnostic is
`filesystem_policy_denied`, rule `credential_filename`.

The inspected target was
`/Users/mariojrlangomez/Desktop/projects/mbtc/web/map-governance-ui/skills/platform-init/fixtures/edge-existing-credentials.json`.
Independent metadata inspection established that its canonical path is identical,
it is a regular file rather than a symlink, and its mode is 0644. No fixture
contents, ownership, ACLs, or external project files were modified. The policy
reproduction rejects the target before opening it; its `macOSAccessAttempted`
field is false. This is not evidence of a missing file or an OS ownership problem.
There is no fixture-specific allowlist: the filename triggers the protection.

The saved Athena preferences have Personal File Access enabled and
Full Mac — Read & Write saved for a subscription account. The active grant is
also checked against the currently selected provider/account at runtime. Saved
preferences alone do not establish the active grant for a historical execution.

The existing dependency-directory fix was already present. An actual test of
`map-governance-ui/node_modules/undici/lib/web/cookies` successfully listed the
directory and read `index.js` through Athena's project filesystem service.
There was no dependency installation, replacement, or external project edit.

## Execution path and permission precedence

Conversation context construction (`chatContextService`) selects the authorized
project or Full Mac workspace. `AgentTools` supplies operation rules and approval
prompts. `createProjectTools` preflights explicit reads and invokes
`WorkspaceService`, which consults the main-process `PermissionService` callback,
validates paths, then performs filesystem operations. Commands use the same
authorized working directory but run in the separate macOS command sandbox.

Personal File Access, provider/account binding, conversation authorization,
delegated/tool restrictions, protected resources, and macOS enforcement all apply.
Full Mac expands ordinary file scope; it does not confer every tool capability.
Full Mac Read Only does not authorize mutations. Sub-agents remain limited to
their explicitly delegated project paths; reviewers retain their read-only tools.

Credential-named files have an existing per-operation approval workflow:

- Parent `read_file`/metadata requests prompt before granting a read for that
  exact operation. The grant is async-local and expires after the operation.
- A command needs its own exact `read_paths` approval. A prior file-tool approval
  does not authorize commands, other files, or writes.
- Declined credential reads no longer repeatedly prompt within the same tool
  execution. New user direction is required to continue.
- Protected parents, environment files, key material, and unsafe symlinks remain
  outside this exception. Use a redacted copy when access is not permitted.

No automatic approval of the real fixture was performed. Approval and content
read behavior were verified using synthetic fixtures, not real credentials.

## Defects corrected

1. **False symlink denials:** Full Mac validation rejected macOS's standard
   `/var`, `/tmp`, and `/etc` aliases. It now accepts only their verified exact
   `/private/...` mappings and continues validation on canonical paths. Arbitrary
   symlink escapes remain denied. A failing-before/passing-after test covers this.
2. **Lost project grants and errno:** a temporary root `lstat` failure deleted
   the saved authorization and replaced the OS error with a generic reconnect
   message. Transient errors now preserve both grant and errno. Changed directory
   identity still invalidates authorization. A regression reproduced the defect.
3. **Incomplete diagnostics:** mutations could discard structured OS/policy
   details; content and ignore-rule denials appeared as generic I/O errors.
   Results now retain rule, requested/normalized path, current scope, operation,
   tool authorization, OS code, access-attempt flag, and recovery guidance where
   available. A normalized lexical path is not claimed to prove a canonical path
   when policy denied access before resolution.
4. **Terminal protection mismatch:** a real sandbox test demonstrated that
   `.azure/profile.json` was readable despite file-tool protection. Commands now
   also protect `.azure`, `.kube`, and `.docker`; credential matching handles all
   case variants. Exact approved reads remain narrow and source writes stay blocked.
5. **Settings interruption:** an unchanged mode or failed settings save no longer
   aborts a task. A successful scope change stops the old execution; explicit
   continuation builds tools using current authorization and preserved progress.
   Pending approvals remain invalid after a scope change. No restart is required
   merely to change the permission setting.
6. **Misleading guidance:** delegated tools now describe their narrower scope;
   policy text distinguishes actual HOME behavior from isolated Git/npm settings.
   Settings now explains eligible credential-file approvals instead of claiming
   every such file is unconditionally inaccessible.

## Files modified

- `electron/main/ai/workspaceService.ts`
- `electron/main/ai/filesystemErrors.ts`
- `electron/main/ai/agentTools.ts`
- `electron/main/ai/projectTools.ts`
- `electron/main/ai/agentCommands.ts`
- `electron/main/ai/commandFileAccess.ts`
- `electron/main/ipcHandlers.ts`
- `src/features/settings/PermissionSettings.tsx`
- `tests/workspaceService.test.ts`
- `tests/projectTools.test.ts`
- `tests/agentTools.test.ts`
- `tests/agentCommands.test.ts`
- `tests/desktop/permissions.spec.ts`
- This report.

## Verification

- Before changes: 108 relevant tests passed, 3 skipped. New tests then reproduced
  the alias rejection, lost root errno, and terminal cloud-configuration gap.
- After changes: full `npm test` passed **1,000 tests**; 17 environment-dependent
  tests skipped. 118 test files passed, 3 skipped.
- Real macOS command sandbox suite: **9 passed, 2 skipped**, including exact-file
  approvals, neighboring secrets, writes, future reads, outside scope, and cancellation.
- External-project focused checks: **2 passed** — real undici directory/read and
  exact fixture policy denial without opening its contents.
- Electron desktop permission tests: **2 passed**, using isolated temporary
  profiles. Covers IPC restrictions, opt-ins, three filesystem modes,
  provider-bound grants, cancelled Full Mac approval, and restart persistence.
- `npm run typecheck`: passed.
- `npm run build`: passed. Existing dependency annotation/chunk-size warnings remain.
- No separate lint script exists in `package.json`.

## Relaunch and limitations

No Athena process was running at initial process inspection. The external
project's development server was left running on port 5173. Updated Athena was
launched in development mode on port 5174. After the first tool-owned launch was
no longer running, one detached development session was started to keep Athena
open independently of the tool session. No external project server was stopped.

This updates the source development application; the separate packaged
`release/mac-arm64/Athena.app` was not repackaged.

The original historical conversation was not replayed against a live AI provider.
No real credential-file read was automatically approved, and no real fixture
ownership/ACL repair was attempted. The fixture remains intentionally protected
pending its appropriate per-read approval. Original runtime mode/account details
cannot be reconstructed from the quoted error alone. macOS privacy restrictions,
tool-specific write limits, and delegated scopes remain in force. These results
do not assert that all possible filesystem or provider errors are eliminated.
