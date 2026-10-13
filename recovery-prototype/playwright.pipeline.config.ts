import { defineConfig } from '@playwright/test';

// Stage 2A-5d-4a: the analysis pipeline core against the real database contract.
// Run through supabase/scripts/test-pipeline-db.sh (it starts the local database).
export default defineConfig({
  testDir: './tests/pipeline',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
});
