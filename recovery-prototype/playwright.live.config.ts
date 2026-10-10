import { defineConfig } from '@playwright/test';

// Live-mode (authenticated) frontend tests. Builds the app configured for a
// FAKE Supabase project and intercepts every request to it with a mock
// (tests/live/mockSupabase.ts). These prove frontend behaviour only; database
// authorization (RLS) is tested separately in supabase/tests.
export const MOCK_SUPABASE_URL = 'https://mock-project-ref.supabase.co';
export const MOCK_PUBLISHABLE_KEY = 'sb_publishable_TEST_ONLY_not_a_real_key';
const PORT = 4181;

export default defineConfig({
  testDir: './tests/live',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite build --outDir dist-live --emptyOutDir && npx vite preview --outDir dist-live --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { VITE_SUPABASE_URL: MOCK_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY: MOCK_PUBLISHABLE_KEY },
  },
});
