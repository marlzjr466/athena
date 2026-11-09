# Native MLX adapter activation

Academy → Advanced Model Fine-Tuning → Step 7 registers the selected completed
run's adapter as **Athena Coder v2 · MLX**. Activation selects it for the local
companion. Existing chat sessions retain their model; select the MLX model in
the chat model menu to switch. **Restore previous model** restores the saved
local companion selection. Ollama models and training records are preserved.

## Identity and inference

- The saved training checkpoint ID must match the current checkpoint metadata.
- Source weights, model configuration, tokenizer files, adapter configuration,
  and adapter weights receive SHA-256 fingerprints. Every inference request
  checks these and the separately stored inference copy of the adapter.
- The current implementation supports the requested Qwen2 architecture and
  rank-8 LoRA configuration. Unsupported configurations fail explicitly.
- Native `mlx_lm` loads the exact local checkpoint and its chat template. The
  loaded LoRA tensor names and values must match the exported adapter exactly.
- Activation generates with the base and adapted model, requiring nonzero
  learned weights and different logits. Equal generated text is possible and
  does not mean that the adapter was skipped. This check does not measure quality.
- Inference runs offline in the existing dedicated training Python environment.
  There is no model conversion, download, or automatic Ollama fallback.

The worker loads per request and is terminated on cancellation, releasing Metal
memory. This favors predictable resource recovery over low first-token latency.
Source hashing and checkpoint loading add startup time. Text streams immediately
when tools are absent. Tool-enabled responses are buffered until complete so
partial requests cannot execute. Images and simultaneous MLX requests fail with
explicit errors. Conversation history, compaction, tool permission checks,
activity reporting, and execution budgets reuse the existing local provider.

## Tools and diagnostics

A successful harmless structured-call probe enables the existing tool interface.
Only advertised tool names and object arguments are accepted; the existing tool
session then validates schemas, permissions, and execution limits. A tool-format
probe establishes format support, not reliable project-task performance.

Local AI setup and Step 7 show checkpoint paths, provider, loading state, peak
memory when measured, and generation errors. A changed or missing checkpoint,
tokenizer, adapter, or runtime produces an error without selecting another model.
Registry data lives separately under `athena-local/mlx-inference`.

## Verification on the user's adapter

On 2026-10-23, `0000100_adapters.safetensors` from the completed selected training
run loaded 112 adapter tensors. Base and adapted generation completed; maximum
last-token logit difference was approximately 10.8348. Peak verification memory
was approximately 6.08 GiB. Native streaming and cancellation completed.

The harmless tool-format probe passed. Two real project-read requests through
the full chat prompt returned prose without invoking the tool. No file operation
was reported as successful. Tool execution plumbing has automated coverage, but
reliable project tool use by this particular adapter remains unverified. Further
training or evaluation should address that model behavior.

`tests/mlxInference.test.ts` covers persistence, identity changes, no HTTP fallback,
authorized tool dispatch and history, cancellation, exact errors, and rejecting
incompatible activation while preserving a verified registration. The opt-in
scripts `verify-mlx-activation.ts` and `verify-mlx-chat.ts` exercise actual native
generation and report tool-use outcomes separately from activation success.
