import { defineConfig } from '@playwright/test';

// WhatsApp integration PREVIEW screens (isolated environment build: VITE_WHATSAPP_PREVIEW=1) at 390px,
// against a mocked Supabase. Separate port and output folder: the prototype's live tests and build are untouched.
const PORT = 4182;
export default defineConfig({
  testDir: './tests/whatsapp-ui',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, screenshot: 'only-on-failure' },
  webServer: {
    command: `npx vite build --outDir dist-wa --emptyOutDir && npx vite preview --outDir dist-wa --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { VITE_SUPABASE_URL: 'https://mock-project-ref.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TEST_ONLY_not_a_real_key',
      VITE_WHATSAPP_PREVIEW: '1', VITE_WA_APP_ID: '123456789012345', VITE_WA_ES_CONFIG_ID: '987654321098765' },
  },
});
