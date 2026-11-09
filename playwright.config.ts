import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/desktop',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
})
