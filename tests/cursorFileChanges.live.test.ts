import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CursorACPProvider, CursorACPService } from '../electron/main/ai/cursorACP'
import { contextDefaults } from '../shared/context'
import type { AIChunk } from '../shared/chat'

it.skipIf(process.env.ATHENA_CURSOR_DIFF_LIVE_TEST !== '1')('captures verified edits through the installed Cursor ACP agent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-cursor-diff-live-')))
  try {
    await writeFile(join(root, 'status.txt'), 'status: draft\n')
    const provider = new CursorACPProvider(new CursorACPService(), root, false, null, 'grok-4.6[effort=medium,fast=false]')
    const chunks: AIChunk[] = []
    for await (const chunk of provider.streamMessage([{ id: 'live-user', role: 'user', status: 'complete', createdAt: Date.now(), content: 'This is a small file-edit regression fixture. Use workspace-relative paths and native file tools. Replace the entire contents of status.txt with exactly "status: approved" followed by a newline. Then create result.txt with exactly "verified" followed by a newline. Only touch these two files. Do not run commands or inspect other directories. Reply Done when finished.' }], {
      conversationId: 'live-diff-conversation', executionId: 'live-diff-execution', permissionMode: 'full-access',
      signal: AbortSignal.timeout(150_000), contextSettings: { ...contextDefaults(), allowProjectCommands: false },
      // The provider validates native paths before invoking this callback.
      requestApproval: async title => /(?:status|result)\.txt/.test(title),
    })) chunks.push(chunk)
    expect(await readFile(join(root, 'status.txt'), 'utf8')).toBe('status: approved\n')
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('verified\n')
    const changes = chunks.flatMap(chunk => chunk.type === 'activity' ? chunk.changes ?? [] : [])
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'status.txt', verified: true, status: 'applied', diff: expect.stringContaining('-status: draft') }),
      expect.objectContaining({ path: 'result.txt', verified: true, operation: 'create', diff: expect.stringContaining('+verified') }),
    ]))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 180_000)
