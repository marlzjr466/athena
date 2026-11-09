# Conversation UI refinement

Scope: presentation improvements to the existing Phase 2 text chat. No Phase 3 permission work, AI-provider changes, new automation or companion animation changes.

## Updated experience

- Right-aligned user bubbles with a 75% maximum width; full-column assistant replies without a surrounding card.
- No visible “You” or “Athena” message headers. Article accessibility labels still distinguish speakers.
- Centered reading column, independently scrolling transcript, stationary auto-growing composer, jump-to-latest control, compact copy/retry/send/stop controls.
- New empty state and suggestion buttons that fill a draft without sending it.
- Markdown headings, emphasis, nested lists, task lists, tables, blockquotes, inline code and fenced code. Code blocks include syntax highlighting, language labels and copy controls; unknown/unlabeled code remains readable plain text.
- Existing streaming, session history, stop, retry, clear confirmation, connection guidance and keyboard shortcuts are retained. Raw HTML, executable code, remote images and automatic link navigation remain disabled.
- Syntax highlighting uses [rehype-highlight](https://github.com/rehypejs/rehype-highlight), with automatic language detection disabled. Completed Markdown messages are memoized.

## Files

Created:
- `src/features/chat/ChatMessage.tsx`
- `tests/chatMessage.test.tsx`
- `docs/CHAT_UI_UPDATE.md`

Modified:
- `src/features/chat/ChatView.tsx`
- `src/features/chat/MessageMarkdown.tsx`
- `src/styles/chat.css`
- `src/app/ControlCenter.tsx`
- `tests/messageMarkdown.test.tsx`
- `tests/desktop/chat.spec.ts`
- `package.json`, `package-lock.json`

## Verification

- TypeScript passed; 195 unit/component tests passed, including role-label removal, Markdown safety, highlighted-code copying, tables/tasks and incomplete streamed code fences.
- Native chat tests verify real Electron layout, 75% user width, visible composer, syntax highlighting and retained streaming/stop/retry/clear behavior with an isolated mocked network response.
- All six native regression scenarios passed. The added 960×680 compact-window check exposed a competing outer-page scroll style; after fixing the scoped overflow rule, the expanded chat test passed, including draft-only suggestions, jump-to-latest and a visible composer with no outer overflow.
- Screenshots: `test-results/chat-streamed.png` and `test-results/chat-compact.png`.
- Live AI billing remains a separate issue: the last live response returned `credit_balance_exhausted`. UI verification does not claim successful paid generation or completion of Phase 2 live acceptance.
