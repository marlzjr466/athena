# Cursor model configuration

Athena previously passed `--model` and rejected an ACP session when its reported
variant differed. That detected the mismatch but could not fix it. In the
installed Cursor CLI (2026.10.01-e373342), the variant picker advertises only
one Grok 4.6 variant: `grok-4.6[effort=high,fast=true]`. The parameterized picker
advertises Low, Medium, High, Extra High, and independent Fast values. Grok 4.7
also advertises 256K and 500K context.

Athena now negotiates `_meta.parameterizedModelPicker`, discovers the installed
CLI's `cursor/list_available_models` extension, and uses ACP
`session/set_config_option`. It sets the base model first, then every selected
parameter, and verifies all returned current values before `session/prompt`.
The installed CLI's handler updates its model manager through
`setCurrentModelWithParameters`, synchronizes its session models, and builds
the inference request from that model manager.

Selections are stored per conversation as complete parameter strings, for
example `grok-4.7[context=500k,reasoning_effort=medium,fast=false]`.
Existing CLI slugs remain accepted; their explicit effort and speed are mapped
to advertised parameters. Unsupported values fail before sending a prompt.
Athena creates a separate ACP process/session for each turn and supplies its
persisted conversation history, so settings are reapplied on reopening.
Cursor may persist settings itself when using its supported configuration API.
Athena does not edit Cursor configuration files directly.

The conversation menu groups each model into one row, with an Edit panel for
its actual parameter controls. New model choices start with Fast off when
supported. Context choices are never copied from IDE screenshots or guessed.
Older CLIs without parameter discovery retain the existing selector and exact,
verified variant path.

## Verification

- TypeScript checking and model configuration, UI, persistence, and IPC tests.
- `ATHENA_CURSOR_MODEL_LIVE_TEST=1 npm test -- --run tests/cursorACP.live.test.ts --disableConsoleIntercept`
  verifies all four Grok 4.6 Medium/High × Standard/Fast configurations, switches
  to Grok 4.7 500K, and restores the original requested model in a new session.
  This test sends no inference prompts.
- `ATHENA_CURSOR_CHAT_LIVE_TEST=1 npm test -- --run tests/cursorACP.live.test.ts --disableConsoleIntercept`
  sends one short read-only message through the actual provider with Medium and
  Fast off and checks the streamed answer. This consumes normal Cursor usage.

These checks establish the ACP configuration and successful chat execution.
They do not independently attest Cursor's billing attribution or sub-agent
model routing in its usage dashboard.

Verified on 2026-10-20: TypeScript checking and 82 targeted tests passed. All four
live Grok 4.6 effort/speed combinations passed, as did the short Medium/Fast-off
streaming smoke test. The development window's searchable menu and Edit flyout
were observed, and selecting Medium saved
`grok-4.6[effort=medium,fast=false]` and enabled the composer.
The packaged application was not rebuilt or restarted for this change.

References:
- https://cursor.com/docs/cli/acp
- https://agentclientprotocol.com/protocol/v1/session-config-options
- Installed CLI `3351.index.js`, `cursor-acp-agent.ts` model configuration handler.
