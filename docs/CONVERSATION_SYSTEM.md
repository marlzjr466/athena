# Persistent conversation workbench

This is the explicitly requested chat upgrade between AI Phases 3 and 4, not an automatic advance into voice input. Character rendering, movement, idle actions, pinning and floating windows are unchanged.

Project exploration has since been extended with dynamic read-only function calling. See [Project tools](PROJECT_TOOLS.md) for the current access model, tool limits and validation. The excerpt-only retrieval described below is now the fallback for models without verified tool support.

## Implemented

- Independent conversations with automatic first-message titles, New Chat, rename, native delete confirmation, content/title search, recent sorting and collapsible history sidebar.
- Main-owned, versioned, validated local history; atomic user-only writes; restoration, per-session drafts, model/effort, attachments and project references. Partial streams checkpoint every 500 ms and recover as stopped after an interrupted restart. Corrupt history is not overwritten.
- Streaming, cancellation, regeneration, timestamps, edit/resend, Markdown/GFM, highlighted code copying, autoscroll/jump-to-latest, 60-message history pages and Enter/Shift+Enter. Cmd/Ctrl+Shift+O creates a conversation. User-message copy remains absent as previously requested; assistant and code copy remain available.
- Edit/resend truncates subsequent turns. Switch/new/delete cancels the current generation; late responses cannot update another session. Request IDs prevent duplicate sends.
- OpenAI account model list reused in the conversation header, refreshable via the existing authenticated model-list request. Model/effort preferences are session-specific and changing models retains history. Auto omits reasoning parameters; only documented family capabilities expose explicit levels. Unknown models default to Auto without verified vision support. The model catalog is not hardcoded.
- Native multi-file selection and drag/drop import with visible progress/errors; removable draft cards, safe extracted-text previews, image thumbnails and history previews.
- UTF-8 text, Markdown, CSV/TSV and common source formats, PDF text extraction, DOCX raw text extraction; PNG/JPEG/WebP/GIF decoding. Parsing/decoding runs in a bounded worker, not a renderer. Images normalize to PNG at up to 2048 px on the longest edge; GIF input uses a still frame. Files are local until an explicit chat send/retry.
- Read-only project/folder selection including existing Git working trees. Connected-project switcher, path/code search, file list, attach-source action, refresh-on-search and refresh-before-request. Relevant lexical matches, common authentication/architecture terms and directly imported neighbors support multi-file answers. Supplied snippets have actual line numbers and a source-context disclosure under the response.
- Personal Files opt-in plus explicit selection is required. No filesystem path API is exposed to React. Project grants are in-memory and must be reauthorized after restart; saved names are not grants. Every access is gated; permission disable aborts the response and revokes folder grants. Symlinks, traversal, changed root identity, secret/credential files, common generated/dependency directories and gitignored files are excluded. Common embedded credential patterns are skipped. No secret detector can guarantee detection of all secrets: review source before connecting sensitive repositories.
- No shell commands, code execution, file modifications, background uploads or executable AI tools. Attachment/project text is marked untrusted data, with explicit instructions not to obey embedded prompts.

## Storage / configuration

No Supabase, authentication backend or cloud database existed in this desktop app. No SQL migrations, RLS policies or cloud buckets were necessary or added. No new environment variables are needed. OpenAI configuration remains in macOS Keychain and never enters conversation records.

Local application profile (`~/Library/Application Support/Athena` on macOS):

- `conversations.json`: version 1 library, active session, ordered messages and per-session preferences.
- `chat-attachments/<session UUID>/<attachment UUID>.bin` and `.txt`: originals/normalized images and extracted text.
- `conversation-archive/<session UUID>-<timestamp>.json`: recovery copy when deleting a conversation. Original attachment files are retained so archived conversations can be recovered manually. Deletion is not a secure purge.

Directories are created with mode 0700 and files with mode 0600. Local files are private to the OS account, not separately encrypted. A damaged library causes a visible recovery warning and disables overwriting that file. Restore a valid backup before restarting.

## Deliberate limits

- OpenAI is the only configured provider in the existing app; the provider field reflects that, without offering nonfunctional providers. Supported reasoning values depend on the model/account; unknown or rejected settings fall back to Auto via the selector, never silent paid retries.
- 8 attachments per message, 20 MB per file, 120,000 extracted text characters, PDF limit 100 pages, 24 MB DOCX ZIP expansion, 20-second parser timeout. Image request budget approximately 24 MB. PDF/DOCX context is extracted text, not embedded diagrams; scanned PDF pages should be attached as images.
- Up to 500 conversations and 10,000 messages each. Only recent completed turns and the most recent 8 in-context attachments go to the model. Conservative byte budgets bound history and document/repository excerpts; omitted older turns remain saved and the UI reports truncation. Large-document follow-ups retrieve question-related excerpts rather than silently sending an entire file.
- Project indexing is bounded to 2,000 source files, 256 KB per file, 16 MB source text, 10,000 directory entries and depth 20. Up to 8 relevant excerpts (70 lines each, total at most 16 KB) are sent. This is lexical/import-aware retrieval, not whole-program analysis, an LSP or vector database. An answer may need more specifically attached files. Nested gitignore files are honored conservatively; ignored directories are not re-included via negation.
- There is no already-working voice subsystem in the current repository. Existing controls and thinking/responding/idle integration are preserved. Phase 4 microphone/transcription and Phase 5 speech are not implemented by this task. Future transcripts should call the same session-bound send API.
- Live paid generation was not used to validate this upgrade. The prior real account response was `credit_balance_exhausted`; authenticated model listing alone does not establish available credits. Provider transport, vision payloads, errors, reasoning options and streaming were exercised using controlled responses in isolated profiles.
- App signing/notarization is still a separate release requirement.

## Verification

- Final results: 248 unit/component tests passed; all 8 native Electron integration tests passed. Native chat/session tests were rerun after the final draft fixes (2/2 passed). TypeScript checking and macOS packaging succeeded. The packaged ASAR image worker was smoke-tested with a synthetic GIF. Dependency audit returned zero known vulnerabilities.
- Unit/component tests: conversation lifecycle, persistence/recovery, pagination/context budgeting, duplicate/stale requests, editing/regeneration/cancellation, capability selection, attachment formats/validation, permission checks, session isolation, traversal/symlinks/gitignore/secret filtering, source line references and refreshed content; existing character tests remain in the suite.
- Native Electron integration: session/model/effort controls, DOCX/PDF worker extraction, PNG image input, source browsing/retrieval, edit/resend, project reauthorization after restart, draft/attachment restoration, confirmation on delete and real Keychain isolation. Existing native chat/companion/permission/wandering/action tests remain.
- Additional decoder checks cover JPEG, WebP and GIF.
- Dependency audit: a narrowly scoped Mammoth `argparse` override removes the unused CLI's vulnerable legacy `sprintf-js` dependency. Athena calls only Mammoth's raw-text library. No forced package downgrade. Document extraction is regression-tested.

## Created files

- `shared/conversations.ts`
- `electron/main/ai/conversationRepository.ts`
- `electron/main/ai/contextBudget.ts`
- `electron/main/ai/workspaceService.ts`
- `electron/main/ai/attachmentService.ts`
- `electron/main/ai/documentWorker.ts`
- `electron/main/ai/chatContextService.ts`
- `src/features/chat/ConversationSidebar.tsx`
- `src/features/chat/ConversationControls.tsx`
- `src/features/chat/AttachmentCards.tsx`
- `src/features/chat/WorkspacePanel.tsx`
- `src/styles/conversations.css`
- `tests/conversations.test.ts`
- `tests/attachments.test.ts`
- `tests/workspaceService.test.ts`
- `tests/desktop/conversations.spec.ts`
- `docs/CONVERSATION_SYSTEM.md`

## Modified files

- `shared/chat.ts`, `shared/contracts.ts`, `shared/ipcChannels.ts`, `shared/permissions.ts`
- `electron/main/ai/chatController.ts`, `electron/main/ai/AIProvider.ts`, `electron/main/ai/OpenAIProvider.ts`, `electron/main/ai/aiConfiguration.ts`
- `electron/main/main.ts`, `electron/main/ipcHandlers.ts`, `electron/main/permissions/macOSPermissionAdapter.ts`, `electron/preload/preload.ts`
- `src/store/chatStore.ts`, `src/services/desktop.ts`, `src/features/chat/ChatView.tsx`, `src/features/chat/ChatMessage.tsx`
- `tests/aiIPC.test.ts`, `tests/openAIProvider.test.ts`, `tests/desktop/companion.spec.ts`
- `package.json`, `package-lock.json`, `electron.vite.config.ts`, `README.md`, `docs/IMPLEMENTATION_PLAN.md`

## API references checked

- [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [File inputs](https://developers.openai.com/api/docs/guides/file-inputs)
- [GPT-5.2 capabilities](https://developers.openai.com/api/docs/models/gpt-5.2), [GPT-5.4 capabilities](https://developers.openai.com/api/docs/models/gpt-5.4), [GPT-6 Astra capabilities](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GPT-5.6 Luna capabilities](https://developers.openai.com/api/docs/models/gpt-5.6-luna): the user's currently selected model retains Auto and exposes Low, Medium, High and Extra High.
