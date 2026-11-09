import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', timeout: 60000, expect: { timeout: 15000 }, workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000', channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
