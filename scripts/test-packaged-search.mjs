import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const resources = process.platform === 'win32' ? 'release/win-unpacked/resources' : `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Athena.app/Contents/Resources`
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/searxngRuntime.test.ts'], {
  stdio: 'inherit', env: { ...process.env, ATHENA_SEARXNG_LIVE: '1', ATHENA_SEARCH_TEST_BUNDLE: resolve(resources, 'search-runtime') },
})
process.exit(result.status ?? 1)
