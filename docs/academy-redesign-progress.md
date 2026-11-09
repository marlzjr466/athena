# Academy reference redesign

Scope: the Academy dashboard and dedicated Advanced Model Fine-Tuning page follow
the supplied October 21 reference designs. Keep saved Academy metadata, sources,
datasets, adapters, comparisons and model selection separate from online chat and
the floating model. Use the development app only; no production build or restart.

Implementation checkpoints:
- [x] Inspect existing Academy, RAG, MLX training, comparison and persistence APIs.
- [x] Full-width dashboard, seven module rows, real derived status and metadata.
- [x] Persistent module workflow with local practice and independent evaluation.
- [x] Seven visible fine-tuning stages, existing comparisons and help sidebar.
- [x] Relevant regression checks and development-window visual verification.

Reference values are not application data. Unsupported deployment stays disabled.
The prior standalone instructions, interviews, meetings and correction panels are
not part of the dashboard; retain their implementations and stored records.

## Implementation — October 21, 2026

### Dashboard and courses

- `src/features/athena-ai/AthenaAcademy.tsx`: reference-layout dashboard, six live
  summaries, seven full-width rows, status/category filters, independent model
  selection, course navigation, and separate full-page fine-tuning view.
- `AcademyDesign.tsx`: shared header, model metadata panel, progress/status and
  numbered section components.
- `AcademyCourseView.tsx`: six-stage timeline, versioned skill guidance, approved
  knowledge sources and embedding selection, local practice, independent final
  checks, result evidence, threshold and history.
- `MyAthenaPage.tsx`, `src/styles/academy.css`: Academy page sizing and scoped
  reference styling. The existing application navigation and theme remain.
- `shared/academyCourses.ts`, `shared/academy.ts`: extensible seven-course
  registry, stage/result schemas and per-model/digest persistent records.
- `electron/main/ai/academyCourseChecks.ts`, `academyService.ts`: real local
  course operations, indexed-source/digest checks, cancellation, independent
  reference assessments, and executable JavaScript coding cases. Critical
  checks must pass as well as the configurable score threshold (default 80%).

The seven courses are AI Coding, Git Intelligence, Jira & Agile, Programming
Languages, Frameworks, DevOps, and Other Skills. Installing guidance alone does
not mark a course passed. Existing stored modules are preserved; the new course
progress requires evidence rather than inventing lesson completion from them.

### Fine-tuning

- `AcademyFineTuningView.tsx`: seven visible workflow sections, step navigation,
  checkpoint controls, separate training/evaluation JSONL inputs, presets and
  advanced settings, real monitoring/history, comparisons and adapter export.
- `AcademyTrainingPanel.tsx`: retained comparison charts, generated answers,
  manual review, score intervals and previous evaluation records.
- `shared/academyTraining.ts`, `electron/main/ai/academyTraining.ts`: validated
  configurable iterations, learning rate, batch size, rank and save interval;
  actual MLX arguments/config; training/validation loss and memory parsing;
  checkpoint discovery; digest-guarded adapter export. Runtime inspection is
  cached for 60 seconds and during jobs instead of repeated Python/Metal probes.
- `electron/main/ipcHandlers.ts`: course/settings/export commands through the
  existing authenticated desktop bridge and native export dialog.

No production datasets, adapters or checkpoint files were changed or deleted.
No new dependencies, cloud training calls, model deployment, or retraining were
introduced by verification. Existing history is read through existing services.

## Verification

- `npm run typecheck`: passed.
- Targeted Vitest run: **13 test files, 87 tests passed**. Coverage includes
  dashboard state/filtering, model isolation, course prerequisites, knowledge
  evidence, critical failures, cancellation, old metadata migration, JSONL
  validation, real preset commands, progress restoration, saved comparisons,
  manual answer review, export, local-only context, and existing integrations.
- Suites: `academyView`, `academyCourses`, `academyTraining`, `academyService`,
  `academyKnowledge`, `academyContextIsolation`, `academyBenchmarks`,
  `myAthenaNavigation`, `localIsolation`, `academyPhase6`, `academyPhase7`,
  `academyIntegrations`, `academyStudio`.
- Observed the actual Electron development window at 1240×860 and 990×700
  logical pixels. Confirmed full-width module rows; six summary cards wrapping
  at narrower widths; fine-tuning sidebar moving below the main content; seven
  sections; step navigation; no clipped monitor values after responsive fixes.
- Observed installed model metadata from Ollama and a ready dedicated MLX runtime.
- Executed AI Coding Foundation in the isolated development profile: versioned
  guidance installation persisted as 1/6 stages (17%). Navigating away and back
  retained it. Switching to Qwen2.5 showed 0%, and switching back restored 17%.
  That dev-only progress is retained, not represented as completed training.
- Frontend HMR worked during visual fixes. Athena dev serves port 5174; the
  unrelated development service on 5173 was not touched. No production build,
  packaging, or restart of the running packaged Athena app was performed.

## Honest limitations and visual differences

- Reference screenshot numbers/losses/lesson counts are never seeded into state.
  Courses show six verifiable **stages**, not invented lesson counts. Final
  assessments are small competency checks, not proof of general mastery.
- Guided output is a saved learning artifact, not correctness evidence; final
  Pass/Fail depends on independent checks. Reference phrase checks still need
  human semantic review in ambiguous cases. Executable coding checks currently
  support JavaScript `solve(...args)` in the existing isolated runner, not every
  language or arbitrary repository test harness.
- End-to-end training, source downloads, and new MLX inference evaluations were
  not run against the user's saved adapters during this redesign. Subprocess
  integration tests use disposable fixtures; do not confuse them with a newly
  trained or evaluated real checkpoint.
- MLX-to-Ollama activation remains disabled: no verified deployment path exists.
  Export preserves source files; rollback changes Academy adapter selection only.
  Continuing from an adapter is a warm start, not full optimizer-state resume.
- Memory/duration estimates display unavailable when unmeasured. Actual peak
  memory is shown when MLX reports it. No new performance benchmark was run.
- Spacing adapts to Athena's existing sidebar and window dimensions; help cards
  move below the form on narrower screens. This follows the references without
  claiming pixel-identical rendering at every resolution.
