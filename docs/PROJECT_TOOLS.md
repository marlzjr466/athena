# Read-only project exploration

Selecting a project grants the Electron main process access for the current app session. Its stable reference remains attached to its conversations; the actual grant stays in memory. After restart, select the same folder to reauthorize it. A stored project name or fingerprint alone grants no access. Personal File Access must remain enabled.

When an authorized project is active and the selected OpenAI model supports Responses function calling, Athena receives six tools: `list_directory`, `read_file`, `search_files`, `search_code`, `get_project_structure`, and `get_file_metadata`. Tools are scoped to the conversation's active project; the model cannot supply another workspace ID or root. Each operation checks authorization, current session association, project identity, relative paths, symlinks, exclusions and applicable nested `.gitignore` rules.

The provider streams the model's response, executes structured validated tool calls in the main process, and returns each result using its call ID. Completed model outputs and encrypted reasoning are replayed in order for the current turn with `store:false`. There are no shell, write, delete or execution tools. File names, source text and search results are untrusted input. Answers are instructed to cite actual returned paths and lines; the response's Source evidence disclosure records successful read/search ranges. Listing and metadata alone are not recorded as inspected code.

Project selection itself does not preload source files. Directory/structure tools inspect metadata and ignore rules only. Reads and content searches access fresh disk contents on demand. Repeated identical tool requests in one turn reuse already-returned evidence rather than retransmitting it. A follow-up starts a fresh tool scope, so modified files are read again. Relevant tool results are transmitted only as part of a user-initiated conversation; no entire-repository upload or background upload occurs.

## Bounds

- Up to 8 tool-bearing model rounds, 24 tool calls, then one forced final answer; 120-second conversation deadline.
- Each tool has a 10-second cooperative deadline and rechecks cancellation throughout filesystem traversal. Regular expressions run in a fixed VM program with a 50 ms deadline per file; glob matching uses bounded dynamic programming. Repository text is never executed.
- Readable source files up to 2 MiB; up to 400 numbered lines and 20,000 characters per read before the tool-result budget is applied. Large files require ranges; files above 2 MiB are explicitly refused. Binary files and recognized embedded credentials are blocked.
- Directory listings paginate at 100 allowed entries; structure output is limited to 1,000 entries and depth 8. Recursive searches inspect at most 10,000 entries, depth 30 and 16 MiB of source per call, returning up to 100 matches. Narrow the subtree or glob if limits are reached. `*`, `**`, `**/`, and `?` globs are supported; other glob metacharacters are literal.
- At most 24 KiB per tool result and 48 KiB of returned project context per turn (less for smaller model budgets). Tool-loop input also has a hard serialized context ceiling. Truncation and exclusions are explicit.
- `.git`, dependency/build/generated directories, hidden files, credentials, environment files and private-key names are excluded. Nested ignore rules are enforced conservatively. These controls cannot recognize every possible secret embedded in otherwise ordinary source code.
- Models outside known function-calling families retain the existing bounded lexical/import-aware retrieval path, with a visible retrieval-only notice. An API refusal is surfaced; Athena does not silently switch models or execute tools through a different provider.

No new environment variables, dependencies, Supabase storage or migrations are required. Credentials remain in macOS Keychain; tools and their executors never enter the renderer or IPC payloads. Existing text chat, attachments, session models/effort, character behavior and movement remain on the same paths.

## Validation

The complete unit/component suite passes: 274 tests across 25 files. TypeScript checking also passes. This includes the existing conversation, permission, character and movement regressions.

`tests/projectTools.test.ts` covers fresh unseen-file reads, updated contents, exact line ranges, recursive search/globs/regex, structure/metadata, exclusions, traversal, nested ignore rules, symlinks, revocation, cancellation, duplicate suppression and bounds.

`tests/projectConversation.test.ts` runs the actual chat controller, context service, filesystem tools, OpenAI SDK and SSE parsing against a controlled API transport. It proves that a file created after authorization is dynamically requested by the model, read from disk, returned as a function-call result, and recorded as source evidence. It also checks multi-call/multi-round context, encrypted reasoning replay, selected model/effort, session isolation, retrieval fallback, call limits and cancellation. It does not spend API credits or assert live account access.

API references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [reasoning and stateless replay](https://developers.openai.com/api/docs/guides/reasoning).
