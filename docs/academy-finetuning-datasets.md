# Fine-tuning dataset modes

Step 3 supports Automatic Split (the existing single import and deterministic 80/10/10 split) and Manual Split. Each local model digest retains its selections for both modes independently.

Manual Split imports `train.jsonl`, `valid.jsonl`, and `test.jsonl` as separate files; arbitrary `.jsonl` filenames are accepted and displayed. All three must be nonempty before training. Each file uses one consistent MLX-LM format: conversation `messages` or legacy `text`. Conversations must alternate user/assistant after an optional initial system message and end with a nonempty assistant response. Unknown roles, mixed row formats, invalid JSON, exact duplicate examples, and cross-split repeated prompts are rejected. Similar-wording warnings use a bounded local heuristic; they cannot detect all semantic paraphrases.

Imports are private copies under versioned dataset directories. Replacing a file creates a new dataset version and preserves previous files. `training.json` stores mode, names, validated counts, canonical SHA-256 hashes, original file hashes, import timestamps, warnings, and each job's pinned provenance. Failed imports retain the previous selection. Old jobs and adapters are retained. Old automatic datasets acquire provenance when selected for a new run; historical results are not rewritten.

## MLX-LM boundaries

The installed MLX-LM 0.32 runtime accepts `messages` directly through `ChatDataset`; no conversion to prompt/completion text is needed.

- Manual training receives a private directory with only `train.jsonl` and `valid.jsonl`. Only the training set reaches gradient updates. `--val-batches -1` measures the full validation set.
- Manual checkpoint comparison receives only `valid.jsonl`, recommends using validation loss, and does not compute test loss or run optional labeled task benchmarks.
- Final evaluation of the selected adapter receives only the job's original `test.jsonl` with `--test-batches -1` and batch size 1. It does not select checkpoints or change training settings.
- Dataset hashes are checked before use and after execution. A changed pinned dataset blocks evaluation/resume and records a visible integrity error. Changing the current selection does not change older jobs' data.

The legacy labeled task benchmark importer remains available in Automatic Split under “Optional labeled task benchmarks.” It requires its own `track`/`prompt`/reference schema. Import success and parser/file errors appear at the relevant importer rather than below the entire wizard.

## Verification

`npm test -- --run tests/academyTraining.test.ts tests/academyView.test.tsx tests/academyBenchmarks.test.ts` covers 52/6/7 routing, count display, import confirmation/errors, file replacement, duplicate rejection, similarity warnings, mode switching, persisted restoration, changed dataset detection, validation-only recommendations, and preserved jobs/adapters.

`tests/fixtures/academyManualMlxSmoke.py` is an opt-in smoke test for Athena's installed MLX Python. It builds a tiny random Qwen2 model and tokenizer in a temporary directory, performs ten real adapter-training iterations, checks weight updates and validation loss, and evaluates the seven independent examples. It uses no downloads or user training records; temporary artifacts are removed at exit. Metal access is required.
