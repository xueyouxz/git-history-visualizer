import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: 'history.browser.spec.ts',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4193',
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm run build && tsx test/browser-server.ts',
    url: 'http://127.0.0.1:4193/api/session',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
