# Academy practical evaluation evidence and retries

Implemented October 21, 2026. This changes course practice and final-assessment reporting, not MLX training, saved adapters, or model selection.

## Diagnosis

The original code-reading check compared the trimmed answer directly to `^2,5$`. Quotes, Markdown fences, or comma spacing could therefore reject a correct presentation. The reported historical response `5,5` is genuinely incorrect: `[1,4].map(x=>x+1)` produces `[2,5]`, and `join(",")` produces the string `2,5`. That failure and its raw 2/3 score are preserved.

## Evidence and scoring

- Every assessed check saves its versioned exercise ID, original prompt, expected answer, unmodified model response, reason, recommendations, evaluator version, timestamp, and result provenance.
- Executable checks additionally save input arguments, expected/actual outputs, generated code, suite duration, and any error. Existing sandbox restrictions are unchanged.
- Scorer v2 normalizes whole-answer presentation, not arbitrary matching substrings. Wrong values, reordered values, arrays in place of the required string, alternative answers, and contradictory prose fail. A JSON object containing only a string `answer` is supported.
- Display percentages use two decimal places. Threshold comparisons use the unrounded score; critical checks still must pass.
- Known historical v1 exercises gain descriptive metadata on load. Original responses, timestamps, pass/fail outcomes, and scores are never regraded. Missing historic timing is explicitly described as unrecorded.

## Targeted practice retries

The typed `retry-course-exercise` command requires the current model/digest, course, latest practical result ID, and a failed exercise ID. It cannot change the threshold or selectively retry a final assessment. Requests are serialized through the existing local evaluation slot and remain cancellable.

Only the selected exercise is regenerated. All test cases for that generated solution are rerun together. Other exercises retain their original evidence and provenance. A new practice result is appended with a link to its parent; prior attempts remain intact. The UI labels retained checks and practice retries. Final evaluation always runs its separate tasks afresh, without practice answers or RAG guidance in its prompts.

## Verification

- `npm run typecheck`
- `npm test -- --run tests/academy tests/codingPractice.test.ts`
- `npx playwright test tests/desktop/academyPractical.spec.ts`

The focused suite covers normalization, incorrect answers, metadata migration, model isolation, saved thresholds, targeted retries, independent final evaluation, cancellation, error evidence, existing knowledge/training flows, and real macOS sandbox boundaries. The desktop test bundles the actual course UI/service into an isolated Electron profile with deterministic mock local inference and the real coding sandbox. It verifies the 66.67% report, responsive layouts, retry behavior, full practice execution, and restart persistence. Screenshots are emitted under `test-results/academyPractical-*`.

No live model retraining or production-profile writes are needed for these checks. The packaged Athena application is not rebuilt or restarted by this test. New source changes require the normal development/build workflow before they appear in an installed package.
