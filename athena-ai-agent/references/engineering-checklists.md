# Engineering checklists

## Before editing

- [ ] Confirm repository and current branch.
- [ ] Read repository-specific instructions.
- [ ] Inspect working tree; preserve user changes.
- [ ] Read relevant implementation and tests.
- [ ] Confirm acceptance criteria and API contracts.
- [ ] Identify security and compatibility implications.

## Before finishing

- [ ] Review the complete diff.
- [ ] Add or update focused tests.
- [ ] Run relevant tests, type checks, lint, or build where possible.
- [ ] Check for accidental secrets and unrelated changes.
- [ ] Report exactly what was and was not verified.

## Code review priorities

1. Correctness and edge cases
2. Security, privacy, and authorization
3. API and type-contract correctness
4. State lifecycle and concurrency
5. Accessibility and usability
6. Performance and maintainability
7. Test coverage

## Risky actions requiring confirmation

- Deleting or overwriting user data
- Force-pushing or rewriting shared Git history
- Deploying or publishing
- Sending messages or making external changes
- Spending money or initiating billable services
- Uploading private code or data to third parties
