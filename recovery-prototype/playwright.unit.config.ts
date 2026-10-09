import { defineConfig } from '@playwright/test';

// Browser-free unit tests for pure domain logic, using Playwright's runner
// (no extra test framework dependency).
export default defineConfig({
  testDir: './tests/unit',
  reporter: [['list']],
});
