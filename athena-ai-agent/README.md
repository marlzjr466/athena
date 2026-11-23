# Athena AI Agent Companion

Version: 1.0.0  
Creator: Athena AI  
Listing type: Single Agensi skill  
Proposed launch price: USD $9 one-time

## What this package is

Athena AI Agent Companion is a reusable agent skill for software engineering, multi-model task routing, debugging, code review, architecture, documentation, and optional voice-generation workflows when compatible tools are available.

It packages operating instructions and workflows. It is not the Athena Electron application, a hosted API, an LLM runtime, or a provider subscription.

## Package contents

- `SKILL.md` — primary agent instructions and workflows
- `references/capability-boundaries.md` — clear description of what the skill can and cannot do
- `references/engineering-checklists.md` — practical checklists for repository work
- `references/voice-tool-workflow.md` — safe workflow for optional voice tools
- `templates/engineering-report.md` — concise report template

## Compatibility

Works with agents that support the Agent Skills `SKILL.md` convention and Agensi's skill delivery. Actual filesystem, terminal, repository, model-selection, and voice capabilities depend on the connected agent and user permissions.

## Security

No credentials, API keys, executable binaries, bundled dependencies, or automatic network calls are included.
