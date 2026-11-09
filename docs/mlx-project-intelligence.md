# Universal local project inspection

Select any compatible local model (including Ollama and **Athena Coder v2 · MLX**),
open an authorized project in the same Athena Chat conversation, and click
**Analyze project**. Natural requests such as
“Analyze this project architecture” use the same read-only workflow.

Local runtimes share one guarded project-tool adapter. If a model cannot issue a
structured action, Athena reports that limitation instead of treating prose as
execution. The bounded inspection workflow assembles findings from actual tool results:
dependency declarations, numbered source excerpts, imports, route declarations,
API implementations, configuration, and command/document references.

## Boundaries and evidence

- Uses existing `AgentTools`, `WorkspaceService`, `ProjectIntelligence`,
  `SlashCommandService`, and `ToolCallSession`; no second filesystem service.
- Current project authorization is checked before and after operations. Local
  providers accept only project-relative paths inside the selected workspace,
  even when Full Mac Access is enabled.
- Existing symlink, ignore, credential, approval and file-size checks still apply.
- The analysis workflow exposes only read/list/search/discovery/inspection tools.
  Explicit coding requests use the approved Step 3 tools described below.
- Project instructions and skills are inspected as data. Discovering a Markdown
  document never grants permission to execute it.
- Command inspection requires discovery in the selected project's catalog.
  Global command definitions are excluded from this workflow.
- Existing operation activity and source-evidence UI display real tool results.
  Errors and truncated coverage are reported, rather than filled in by guessing.

Each overview uses at most 48 calls (or the lower configured limit), 65,000
characters of file evidence, and 140 lines per file read. Searches and directory
traversal retain their existing deadlines, pagination and size bounds. These
limits deliberately leave some large-project files uninspected.

For incremental inspection, ask for an exact file and optional starting line,
for example `Read src/router.tsx` or `Read src/api/baseQuery.ts starting at line
200`. Each follow-up reads current content. It does not need to rescan the whole
repository or put all project files into the model context.

## Verification

Fixture tests cover real project files, source references, custom Claude and
Codex definitions, directory references with trailing slashes, visible activity,
targeted refreshed reads, invalid schemas, missing files, symlink rejection,
write/shell rejection, cancellation, revoked access, and unavailable project tools.
Native MLX tool-parser tests cover complete JSON, fenced JSON, native tool tags,
and rejection of unknown names, invalid arguments, and prose containing JSON.

The opt-in test uses the authorized `map-governance-ui` in read-only mode:

```sh
ATHENA_PROJECT_ROOT='/path/to/map-governance-ui' npm test -- --run tests/mlxProjectAnalysis.test.ts
```

It verifies inspected entry points, router and route configuration, the API base
query, `/platform-spec`, `/platform-dev`, their related skill documents, and an
unchanged Git diff/status and package manifest. It saves the evidence report to
`/private/tmp/athena-mlx-project-report.md`. Training records and model adapters
are not used or changed by the workflow. Online providers retain their existing
execution paths; the shared local adapter is selected by provider capability,
not by model name.

## Approved coding and commands (Step 3)

All local coding requests use the existing `AgentTools` execution loop. Native
tool calls and structured JSON are validated against the same schemas; unknown
tools, extra fields, duplicate keys and mixed prose/tool blocks are rejected.
Each tool's existing schema, project grant, version checks, and approvals remain
authoritative. A model response describing an action is not execution evidence.

Local chat has a slash-command picker backed by its own authorized project
registry. Typing `/` supports filtering, arrow navigation, Enter/Tab selection,
and Escape. It shows the provider/source, definition path, argument hint,
associated skill when declared, and compatibility. User-level discovery requires
the existing explicit directory grant. Native fork/hook/agent/shell-interpolation
semantics remain unavailable through Athena. Missing arguments and unresolved
references block dependent workflows. Instructions, configurations and scripts
are data until explicitly invoked and remain subject to tool permissions.

File operations use previews, approval in Ask mode, current SHA-256 versions,
atomic replacements, read-back checks, and recovery records. Targeted UTF-8 edits
support files up to 2 MiB and preserve BOM/line endings outside the replacement.
File moves preserve executable modes. Populated directory moves and explicitly
recursive deletion preview every included entry and require confirmation. Limits
are 2,000 entries, 8 MiB total and 2 MiB per ordinary UTF-8 file; protected,
ignored, binary, hardlinked or symlinked contents are rejected. Directory deletion
moves the tree to private recovery storage. Cross-volume directory operations
fail safely rather than copying/deleting recursively. Undo refuses newer edits.

Terminal checks use the existing isolated command runner, approval policy,
timeouts, cancellation, and output limits. Local providers restrict command
scope to the selected project even when other desktop features have Full Mac
Access. Source
writes belong to the file tools; Git mutation tools and development-server
controls are not advertised by this integration. Network and dependency installs
retain separate authorization. No automatic commits or history changes occur.

The implementation tests use disposable fixtures. The opt-in native test is
`ATHENA_MLX_CRUD_LIVE=1 npm test -- --run tests/mlxProjectExecution.test.ts -t
'native MLX adapter'`; it uses the installed MLX checkpoint/adapter without
altering either. The terminal test uses `ATHENA_SANDBOX_TEST=1` with the same file
and `-t 'runs approved terminal'`. Neither launches Athena or accesses the real
`map-governance-ui` project. Model reliability must be assessed separately from
executor tests; a valid parser and functioning tools do not guarantee the model
will select the right action for every task.

## Direct file requests

Explicit single-file requests use a bounded host workflow before local-model
project reasoning. The same workflow is used by Ollama and native MLX, so an
Ollama model cannot turn a simple CRUD request into a prose-only approval loop.
Examples: `Read src/sum.ts`, `Delete src/sum.ts`,
`Rename src/sum.ts to src/total.ts`, and
`Update src/sum.ts to replace \`a + b\` with \`a + b + 1\`.`
Quoted paths support spaces. Conditional, ambiguous, multi-file and broader
implementation tasks keep the existing agent workflow. Slash commands never
enter this route; command/retrieved document content cannot trigger it.

- Read: one current, bounded file read, with actual contents and displayed range.
- Delete: one target read for its version, then the existing confirmed deletion.
  The filesystem service reads back absence before returning success. No model
  request, root instructions, Academy retrieval, or repository scan is needed.
- Rename: target read, approved rename, destination read; both paths are verified.
- Create/update: inspect only applicable scoped instruction files and the target.
  Explicit fenced content and literal replacements need no generation. Otherwise
  the selected local model receives only a proposal tool, with at most one
  corrective retry. It cannot
  scan, run commands, or write while generating that proposal.

Creation checks existence before generation. Supported source syntax is checked
before approval: TypeScript/JavaScript/JSX/TSX use the bundled runtime TypeScript
parser; JSON uses JSON parsing. Self-imports/re-exports are rejected, and generated
usage-example sections are rejected when unrequested. These are syntax checks,
not project type checks or tests. Other formats explicitly report no built-in
syntax validator. Local-model writes through the general tool loop receive the
same validation before approval, including validation of the complete updated
file.

Existing versioned changes, atomic writes, confirmation and recovery remain in
effect. Saved bytes are compared against the approved change by the filesystem
service, then the direct workflow reads the exact target and checks its hash.
Final replies describe actual results and show saved contents/diffs when asked;
truncated reads are labelled. Direct requests allow at most ten tool calls and
120 seconds, subject to lower existing tool limits. Proposal generation uses
the selected model's existing context/output token settings, a 60-second request
limit and no output continuation. Invalid proposals stop before writing.

For larger local tasks, identical reads reuse request-local evidence; a third
identical request stops the loop. An identical mutation or command is never
replayed. Mutations invalidate read caches. The existing configurable
no-progress window stops varied failed actions; tool/iteration budgets still
apply. Stop aborts generation and pending approvals, preserves completed changes,
and records a concise cancellation or partial-completion summary in chat.

Optimization verification on 2026-10-23: 191 tests passed across 17 regression
files (8 opt-in tests skipped), plus the installed MLX adapter's live disposable
CRUD/command test passed in 46.30 seconds. Fixtures cover actual saved bytes,
invalid syntax, unsolicited examples, literal patches, approved deletion,
outside/symlink rejection, stale versions, cancellation during generation and
approval, stopping after a committed change, repeated-call termination, and
absence of unrelated reads. Existing provider tests use test transports.
Production build and TypeScript checks passed. No running application was
launched, restarted, or inspected, and `map-governance-ui` was not accessed.

### Step 3 verification — 2026-10-23

- Production build (including TypeScript checking): passed.
- Focused regression suite: 15 files passed, 122 tests passed, 8 opt-in tests
  skipped. Covers the project executor, recovery, command discovery, local chat
  component behavior, MLX parsing/inference, and Ollama/Claude/Codex integrations.
- Installed Athena Coder v2 MLX adapter: passed the opt-in disposable create,
  read, targeted edit, rename, confirmed delete, and mock command artifact test
  using actual inference. Approvals are supplied by the test harness; UI approval
  behavior is covered separately by component tests.
- Native macOS command sandbox: passed the opt-in terminal fixture; permitted
  verification executed, while direct source writes and outside-project reads
  were blocked.
- Other provider regression tests use test transports; live Claude/Codex/Ollama
  requests were not part of this verification. No application or development
  server was launched, no browser appearance checks were performed, and the
  real `map-governance-ui` project was not modified or used by these tests.
