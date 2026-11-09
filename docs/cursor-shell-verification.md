# Cursor command integration — 2026-10-20

## Reproduced failure

Cursor's installed ACP implementation (`2026.10.01-e373342`) uses its native
terminal executor, not the advertised ACP client terminal capability. Advertising
`terminal: true` alone did not make Athena's sandbox bridge available as a model
tool. Athena correctly rejected native execution, leaving the model unable to
run even `echo`.

The actual MCP permission envelope also differs from a simple server/tool pair:
its title is `<server>-<tool>: <tool>`. A live disposable-repository test
reproduced false “user-rejected” responses before this exact routing was fixed.
No macOS permission or repository ownership change was needed.

## Fix

- Each write-capable Cursor execution receives a temporary Athena command MCP
  server on loopback, protected by a random bearer secret and exact Host check.
- Only this execution's tools can pass the ACP dispatch gate. External MCP
  services and native Shell remain denied.
- `run_command` uses the existing terminal bridge: current project authorization,
  user approval, direct executable/argument validation and OS command sandbox.
- Long commands return an owned terminal ID; `command_status` reports completion
  without resubmitting the command.
- Repeated transport request IDs reuse the prior result rather than repeating
  side effects. Closing the execution aborts commands and pending approvals.
- Git staging requires explicit files. Commits verify the index belongs to this
  execution, review the staged diff, use the configured author and ask approval.
  Existing unrelated staged work blocks automatic slice staging.
- Cursor file-operation paths in ACP diff content are recognized, not just
  `locations` and `rawInput`.

## Verification

The gated real-CLI test in `tests/cursorACP.live.test.ts` passed with the signed-in
Cursor CLI and an available Grok model:

- `echo hello`, `git status --short`, `git log -1`, `npm --version`.
- Two Node validation commands, each followed by explicit staging and a reviewed
  commit in a disposable repository.
- Git history confirmed each commit contained only its designated slice file.
- An unrelated file remained untracked.

The test-only approval callback is limited to the disposable repository.
Production commands continue through Athena's normal approval UI. The test does
not run a real platform ticket, alter its files, or prove every platform-build
command is supported.

Intentional restrictions remain: no arbitrary native shell/interpreters,
unauthorized external services, project escape, automatic approval of commands,
destructive Git operations, or inclusion of unrelated staged work.
