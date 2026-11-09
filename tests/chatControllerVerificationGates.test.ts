import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import type { AIProvider } from '../electron/main/ai/AIProvider'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

describe('independent task verification gates', () => {
  it('records build, development-server, and browser outcomes independently as operations finish', async () => {
    let chat!: ChatController
    const provider: AIProvider = {
      testConnection: async () => true,
      async *streamMessage() {
        const build = chat.activity('run_build', 'npm run build')
        chat.finishActivity(build, { status: 'complete', summary: 'Build succeeded.' })
        const server = chat.activity('start_dev_server', 'Start local server')
        chat.finishActivity(server, { status: 'error', summary: 'Permission denied by browser/server policy.' })
        const browser = chat.activity('verify_local_app', 'Verify desktop layout')
        chat.finishActivity(browser, { status: 'complete', summary: 'Inspected desktop viewport; 0 browser console errors.' })
        yield { type: 'text', text: 'Build and browser verification passed; server startup was blocked.' }
        yield { type: 'done' }
      },
    }
    chat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn() })

    expect(chat.send({ text: 'Build and verify the app.' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))

    expect(chat.snapshot().messages[1].execution?.taskCheckpoint?.verificationGates).toEqual({
      productionBuild: 'passed',
      developmentServer: 'blocked',
      browserVerification: 'passed',
    })
    chat.dispose()
  })

  it('does not mark failed browser verification as passed', async () => {
    let chat!: ChatController
    const provider: AIProvider = {
      testConnection: async () => true,
      async *streamMessage() {
        const browser = chat.activity('verify_local_app', 'Verify mobile layout')
        chat.finishActivity(browser, { status: 'error', summary: 'Inspected 390 × 844 viewport; 2 browser console errors.' })
        yield { type: 'text', text: 'Browser verification found errors.' }
        yield { type: 'done' }
      },
    }
    chat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn() })

    expect(chat.send({ text: 'Verify the mobile app.' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))

    expect(chat.snapshot().messages[1].execution?.taskCheckpoint?.verificationGates).toMatchObject({
      productionBuild: 'not-run',
      developmentServer: 'not-run',
      browserVerification: 'failed',
    })
    chat.dispose()
  })
})
