# Phase 10 — Controlled personal file access

## Audit and enhancements

File/folder selection, attachment previews, local persistence, permission-gated project browsing, and live project `read_file` were already implemented. Existing main-process workspace authorization revalidates canonical roots and file identity after restart, checks project membership, rejects traversal and symlinks, and excludes sensitive/generated files. These systems were retained rather than replaced.

This update adds `list_approved_files` and `open_file` to the existing conversation tool registry. They let a tool-capable model discover and read additional line ranges from text/document attachments explicitly sent in that conversation, including older attachments omitted from initial excerpts or compacted provider messages. `open_file` opens a **read-only saved attachment snapshot**, not an OS application. The existing project `read_file` continues reading live authorized source files. Neither tool grants general filesystem access.

- Pending uploads and other conversations’ attachments are not tool capabilities.
- Every operation rechecks conversation identity, Personal File Access, and cancellation; results are discarded if access changes during reading.
- Disabling file access also blocks reuse of prior attachment context through compaction checkpoints.
- Lists are paginated and size-bounded. Reads respect the context output limit and return up to 400 numbered lines with accurate source evidence.
- Uploaded images retain the existing vision path. PDF/DOCX tools read locally extracted text; line numbers describe the extraction, not PDF page numbers. No new permission to send images is implied.
- Saved attachment reads reject symlinks, redirected storage directories, non-regular files, oversize data, and detected concurrent changes. Reads allocate a bounded buffer and check permission between chunks.
- Native file selection rechecks consent after the picker closes, handles short reads, rejects non-regular/symlink files, and detects changed files before importing.
- The composer clarifies that sending approves use of saved copies, not access to original paths or other folders.

## Use

Enable Personal File Access under Privacy. Choose files with the existing paperclip, review/remove their previews, then send a question. Athena can request more sections of those approved snapshots on follow-ups. For live files and project-wide exploration, use the existing folder picker and project conversation. Revoking file access blocks future reads; content already sent to the provider cannot be recalled.

Individual attachments persist as local copies and do not automatically refresh when their originals change; reattach an updated copy or use an authorized project. Native selection alone does not upload files. No unrestricted filesystem paths or Node APIs are exposed to React or the model.

## Files

Created:

- `electron/main/ai/approvedFileTools.ts`
- `tests/approvedFileTools.test.ts`
- `docs/PHASE_10_PERSONAL_FILES.md`

Modified:

- `electron/main/ai/attachmentService.ts`
- `electron/main/ai/chatContextService.ts`
- `src/features/chat/ChatView.tsx`

No dependencies, environment variables, database migrations, or Supabase storage were added. Files remain in existing local persistence. Existing permissions, projects, model settings, voice, desktop tools and character animations are retained. Phase 11 is not included.

## Verification

Full Vitest suite: **459 passed, one skipped across 50 files**. TypeScript passed. The targeted attachment/context/project regression run also passed (24 tests across four files).

`npm run package` completed successfully and the rebuilt `release/mac-arm64/Athena.app` was restarted. Its control window reopened. The existing “WebGL unavailable” preview warning and hidden-floating preference remain unchanged; no character or movement code was edited.

Automated tests cover saved-file restoration, attachment isolation, permission revocation before/after reads, cancellation, invalid ranges and arbitrary path rejection, compaction-aware attachment discovery, source references, escaped/multibyte output limits, symlinked files/directories, oversized saved files, native-picker revocation, and coexistence with project tools. Existing project tests cover live reads, boundary checks, ignored files, and restored grants.

No personal files or real API credentials are used by these fixture tests. Live provider interpretation and native picker UX remain manual checks; unknown models keep the existing retrieval-only fallback. The macOS development build remains unsigned without a Developer ID certificate.
