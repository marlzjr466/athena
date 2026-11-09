// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitIdentityService, gitIdentityEnvironment, parseGitIdentityField } from '../electron/main/ai/gitIdentity'

describe('Git identity detection', () => {
  it('uses the real user home rather than inherited isolated Git overrides', () => {
    const env = gitIdentityEnvironment('/private/tmp/athena-git-home', {
      HOME: '/private/tmp/agent-scratch', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOGLOBAL: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Wrong Identity',
    })
    expect(env.HOME).toBe('/private/tmp/athena-git-home')
    expect(env.XDG_CONFIG_HOME).toBe('/private/tmp/athena-git-home/.config')
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(env.GIT_CONFIG_NOGLOBAL).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined()
  })
  it('distinguishes present, absent, permission, timeout and malformed output', () => {
    expect(parseGitIdentityField({ code: 0, stdout: 'global\tMario Jr Langomez\n', stderr: '' })).toEqual({ status: 'found', scope: 'global', value: 'Mario Jr Langomez' })
    expect(parseGitIdentityField({ code: 1, stdout: '', stderr: '' }).status).toBe('missing')
    expect(parseGitIdentityField({ code: 0, stdout: 'global\t\n', stderr: '' }).status).toBe('missing')
    expect(parseGitIdentityField({ code: 128, stdout: '', stderr: 'Permission denied' }).status).toBe('permission-denied')
    expect(parseGitIdentityField({ code: null, stdout: '', stderr: '', timedOut: true }).status).toBe('timeout')
    expect(parseGitIdentityField({ code: 128, stdout: '', stderr: 'bad config' }).status).toBe('tool-failure')
    expect(parseGitIdentityField({ code: 0, stdout: 'unexpected output', stderr: '' }).status).toBe('tool-failure')
  })
  it('reads global identity and a repository-local override with fixed, read-only Git calls', async () => {
    const home = await mkdtemp(join(tmpdir(), 'athena-git-identity-'))
    const root = join(home, 'project')
    await mkdir(root)
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Fixture Global\n\temail = fixture@example.invalid\n')
    execFileSync('/usr/bin/git', ['init', '-q', root])
    const service = new GitIdentityService(undefined, home, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOGLOBAL: '1' })
    expect(await service.read(root, new AbortController().signal)).toEqual({
      name: { status: 'found', value: 'Fixture Global', scope: 'global' },
      email: { status: 'found', value: 'fixture@example.invalid', scope: 'global' }, complete: true,
    })
    execFileSync('/usr/bin/git', ['config', '--local', 'user.name', 'Fixture Local'], { cwd: root })
    expect((await service.read(root, new AbortController().signal)).name).toEqual({ status: 'found', value: 'Fixture Local', scope: 'local' })
  })
  it.runIf(process.env.ATHENA_LIVE_GIT_IDENTITY === '1')('recognizes the current Mac user’s configured identity without changing it', async () => {
    const result = await new GitIdentityService().read(process.cwd(), new AbortController().signal)
    expect(result.complete).toBe(true)
    expect(result.name.status).toBe('found')
    expect(result.email.status).toBe('found')
  })
})
