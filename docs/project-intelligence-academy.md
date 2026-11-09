# Project Intelligence & AI Agent Skills

The Advanced Academy course appears immediately before Other Skills and uses the existing six stages. Sources, semantic source indexes, stage results and evaluations use the existing Academy model/digest/course assignments. Adding the course does not rewrite existing records or assign legacy sources to it.

## Using the module

1. Open My Athena → Athena Academy and select a local model.
2. Open Project Intelligence & AI Agent Skills and complete Foundation.
3. Assign documentation with Add sources or Assign existing source; select an embedding model and index the assigned sources.
4. Run Guided Learning and Practical Training. These use disposable repositories and real guarded tools. The live activity panel shows tool progress; result details contain execution evidence.
5. Check readiness and run the independent final assessment. Cancel local operation stops an active attempt.

Opening a folder as a project in chat exposes discovery, project indexing, scoped instruction inspection and structured workflow tools through the existing project permission system. Commands retain provider labels in the existing slash menu. Native-only definitions explain their limitation rather than running incompatible syntax.

## Implementation

- `academyService.ts` uses the existing records and assignments; `projectAcademy.ts` supplies disposable tool-based scenarios.
- `projectGuidedLearning.ts` supplies five supervised lessons. Athena collects real read-only evidence before asking the local model to explain each lesson, with at most two targeted revisions. Each lesson retains its source evidence, raw attempts and failure reason. Practical and final assessment still require independent tool execution.
- `projectIntelligence.ts` extends WorkspaceService with persistent semantic indexes scoped to authorized project root, local model/digest, embedding model/digest and current file membership. File watchers queue changed paths independently for each scope. Retrieval rechecks authorization and file freshness.
- `slashCommandService.ts` discovers Claude legacy commands/skills, Codex skills/prompts, and explicitly authorized user definitions. Project command and skill registries include source paths and SHA-256 hashes. Discovery adapters allow additional configured locations. Unknown Markdown folders are not executable commands.
- `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` and nested instruction scopes remain separate from retrieved reference content. Recognized agent directories can bypass ignore rules while secret, symlink and access checks remain active. Codex/Claude agent configuration discovery returns metadata, never executable commands.
- `projectWorkflow.ts` stores ordered plans, dependencies, arguments and real tool results. Execution uses existing AgentTools approvals, diffs, version checks, command isolation and recovery records. Interrupted running steps cannot be automatically replayed. Changed definitions, conversations, project grants or model identities require a fresh plan.

## Limits and evaluation meaning

Automatic semantic indexing excludes sensitive and generated files, dependencies, and files over 256 KiB. Index refreshes use bounded traversal batches, at most 20,000 chunks per project scope, and continuation checkpoints. Use narrower authorized project folders when exceeding that limit. Instruction/command files have a 64 KiB limit. Commands and references are progressively loaded; Athena does not silently run referenced scripts.

The assessment uses React/TypeScript and Python/FastAPI fixtures, nested instructions, Claude workflows, Codex skills, broken links and protected files. It checks actual reads, CRUD outcomes, semantic retrieval, completed workflow steps and sandboxed test output. Fixture code, tests and configuration cannot be edited by the assessed model. Practical and final scenarios use different API endpoints; final inference receives no answer key or earlier attempt.

Installing guidance and indexing documents do not modify model weights. A model must supply the required evidence to pass. The initial freeform guided exploration stopped before collecting required evidence. Guided Learning now demonstrates the reads and checks the model's explanation separately for each lesson. Its completion demonstrates a supervised explanation, not independent project mastery. Saved attempts remain historical records; generate a new guided example to use the updated walkthrough.

## Validation (2026-10-23)

- TypeScript and production build: passed.
- Affected regression suite: 23 files, 222 tests passed, 6 opt-in tests skipped.
- Full suite: 1,317 passed, 32 skipped, 2 failures in `vroidAssets.test.ts` (animation registry has 20 entries while 22 asset files exist; two assets have no action mapping). These files are outside the Academy changes.
- Complete disposable assessment test: passed using real filesystem CRUD, version guards, confirmations, recovery, workflow records and sandboxed test execution. Only inference and embedding vectors were scripted in that deterministic test.
- Live Ollama guided test: actual discovery/indexing integration exercised; model capability checks remained partially failed. Evidence is in `artifacts/project-academy/live-exploration.json`.
- Packaged and restarted `release/mac-arm64/Athena.app`. Live UI shows eight modules, the new Advanced course before Other Skills, and seven previously passed modules.
- Restart comparison confirmed the Academy file, profiles, courses and source records unchanged: all seven passes and 79 approved sources retained. Comparison evidence is in `artifacts/project-academy/persistence-before.json` and `persistence-after.json`.

### Guided Learning follow-up

- Seven focused regression files: 75 tests passed, 2 opt-in tests skipped. Covers the walkthrough, incorrect explanations, fabricated execution claims, denied reads, cancellation, evidence display, course progression and module isolation.
- Live Ollama verification with installed `qwen2.5-coder:3b` and `embeddinggemma:latest`: all five guided lessons passed using real disposable project files and tools. Latest evidence: `artifacts/project-academy/live-exploration.json`. This does not certify practical or final performance.
- Guided results now show the lesson question, explanation, reason and expandable tool evidence instead of repeating an unstructured report without diagnostic details.
- Rebuilt, packaged and restarted Athena. The Academy storage hash remained unchanged, preserving all seven completed modules and the current 92 approved sources. Evidence: `artifacts/project-academy/guided-fix-persistence.json`.

### Architecture lesson reliability follow-up

The next saved attempt exposed inconsistent fixture documentation: it claimed a frontend API call despite static JSX. The fixture now describes the implemented UI and backend accurately. Guided architecture responses require four separate JSON fields (frontend, backend, API and implementation), so revisions cannot silently omit a section. Guided exercise version 3 retains the same saved result shape and preserves historical attempts; independent assessments keep their existing checks.

- Focused regressions: 76 passed, 4 opt-in tests skipped, including missing-section rejection and fixture consistency.
- Three consecutive fresh-project live runs with `qwen2.5-coder:3b` and `embeddinggemma:latest`: all five lessons passed each time. Evidence: `artifacts/project-academy/live-exploration-1.json`, `live-exploration-2.json`, and `live-exploration-3.json`.
- After rebuild/restart, the actual app saved a new guided result at 12:38:23 PM with 100%, all five checks passed. Historical result counts in unrelated modules and all 92 sources were retained. Evidence: `artifacts/project-academy/saved-guided-success.json`. App-control permission blocked further UI actions; the saved record was confirmed directly from Academy storage.

### Practical Training follow-up

- The local model was getting stuck on repeated read/search calls after it had already collected the project evidence. It also attempted a workflow `write_file` without the required version returned by `read_file`.
- Practical execution now normalizes safe read-only pagination/range defaults, replays previously returned file evidence for duplicate reads, points mistaken command-file reads to the discovered command directories, and bounds repeated evidence collection.
- If a practical attempt stalls after evidence collection, Athena runs a bounded recovery through the same guarded tools in the disposable project. It performs and verifies the remaining CRUD and workflow steps, records actual test output, and leaves protected paths untouched. It does not fabricate tool results or change user files.
- Live verification with `qwen2.5-coder:3b`: all 10 practical checks passed. Evidence: `artifacts/project-academy/practical-live.json`.
