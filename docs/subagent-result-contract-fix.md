# Independent sub-agent result contract fix

The cold-read worker was reaching its final response, but the coordinator still parsed that response with a strict whole-string `JSON.parse`/`subagentResultSchema.parse` path. Provider wrappers could add fenced output, a short preamble, equivalent field names, or harmless metadata. Those responses were reported as a generic malformed result even when the child had completed useful reads. Conversely, accepting arbitrary nested JSON would risk treating an unrelated object as a PASS.

The coordinator now preserves the bounded raw child response, extracts complete JSON candidates, normalizes documented equivalent fields, validates the canonical `athena-review-v1` contract, and records validation errors, missing fields, candidate count, and termination reason. An explicit PASS/FAIL/INCOMPLETE status is required before a candidate can be selected. A cold-read PASS or FAIL must contain at least one completed check and concrete file/line evidence; otherwise it becomes a structured INCOMPLETE result. Reviewed-file coverage is still derived from successful tool reads, so concise legacy children that supply auditable evidence remain safe. Ambiguous prose never becomes PASS.

The child prompt and policy now include the exact canonical schema and a minimal JSON example. Activity exposes the parsed result, raw response, and diagnostics in collapsed details without exposing hidden reasoning.

Verification: typecheck passed; the full Vitest suite passed (900 tests, 9 skipped); the native Electron cold-read scenario passed with raw-response and parser-diagnostic assertions; and a focused coordinator run read the existing MBM-11400 artifacts read-only. No MBM-11400 files were changed.
