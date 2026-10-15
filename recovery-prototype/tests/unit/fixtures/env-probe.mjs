// Test-only preload (node --import) for the e2e wrappers: instead of running the script, reports
// which values arrived from bash, as booleans compared with EXPECT_* (never the values), then exits.
// Only the e2e script itself is replaced; the per-prompt checker (check-input.mjs) runs normally.
if (/-pipeline-e2e\.mjs$/.test(process.argv[1] ?? '')) {
const want = { SUPABASE_ACCESS_TOKEN: 'EXPECT_TOKEN', KIMI_API_KEY: 'EXPECT_KIMI', RRE_PUBLISHABLE_KEY: 'EXPECT_PUBLISHABLE', FOUNDER_EMAIL: 'EXPECT_FOUNDER_EMAIL', PAID_PROVIDER: 'EXPECT_PROVIDER' };
const seen = Object.fromEntries(Object.entries(want).filter(([, e]) => process.env[e] !== undefined)
  .map(([k, e]) => [k, (process.env[k] ?? '').trim() !== '' && process.env[k] === process.env[e]]));
process.stdout.write(`\nENV-PROBE ${JSON.stringify(seen)}\n`);
process.exit(0);
}
