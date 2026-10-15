#!/usr/bin/env node
// Stage 2A-6d — what the analyze-case function code may contain, checked before it is
// deployed (the local tree) and before a paid run (the deployed bundle).
//
// The Anthropic-capable code (Stage 2A-6b/6c) is allowed exactly one provider library:
// the official SDK pinned at npm:@anthropic-ai/sdk@0.133.0, imported only by
// analyze-case/index.ts. Everything else stays forbidden:
//   * any other non-relative import (npm:, jsr:, https:, bare names) and dynamic import();
//   * anything shaped like an Anthropic key (sk-ant-…) — keys live only in function secrets;
//   * any OpenAI reference; the Anthropic endpoint anywhere but anthropicProvider.ts;
//   * the Kimi (Moonshot) endpoint anywhere but kimiProvider.ts, and anything shaped like a
//     Kimi key (sk-… with a long token) — the Kimi adapter uses plain fetch, no library;
//   * retries (maxRetries other than 0) and a model `fallbacks` parameter.
// And the reviewed safeguards must be present: the fake guard, the paid-provider guard
// (staging-only, unsafe environment refused), the spending controls, the reservation terms
// and the approved-cap check (Stage 2A-6c), and the staging project as the only hosted target.
//
// CLI: node supabase/scripts/function-source-guard.mjs <supabase/functions dir>
//      prints each problem; exit 0 (clean) or 1.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SDK_SPECIFIER = 'npm:@anthropic-ai/sdk@0.133.0';
export const REQUIRED_MARKERS = [
  "STAGING_URL = 'https://aqwdwswpmbnzmkvyuqil.supabase.co'",
  'ALLOW_FAKE_PROVIDER',
  'ALLOW_PAID_PROVIDER',
  'PROVIDER_ENV_UNSAFE',
  'internal_reserve_ai_spend',
  'internal_ai_reservation_terms',
  'internal_ai_dispatch',
  'CAP_NOT_APPROVED',
];
const KEY_SHAPED = /sk-ant-[A-Za-z0-9][A-Za-z0-9_-]{19,}/;
const KIMI_KEY_SHAPED = /\bsk-[A-Za-z0-9]{32,}/;
const OPENAI = /openai/i;
const RETRIES = /maxRetries\s*:\s*[1-9]/;
const FALLBACKS = /\bfallbacks\s*:/;
const IMPORT_SPEC = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/;

/** Problems in the function sources about to be deployed. `files`: [{path (relative, '/'-separated), text}]. */
export function sourceProblems(files) {
  const problems = [];
  const all = files.map((f) => f.text).join('\n');
  for (const { path, text } of files) {
    if (KEY_SHAPED.test(text)) problems.push(`${path}: contains something shaped like an Anthropic key`);
    if (KIMI_KEY_SHAPED.test(text)) problems.push(`${path}: contains something shaped like a Kimi key`);
    if (text.includes('api.moonshot.ai') && path !== '_shared/edge/kimiProvider.ts') problems.push(`${path}: names the Kimi endpoint`);
    if (OPENAI.test(text)) problems.push(`${path}: mentions OpenAI`);
    if (RETRIES.test(text)) problems.push(`${path}: sets maxRetries above 0`);
    if (FALLBACKS.test(text)) problems.push(`${path}: sets a fallbacks parameter`);
    if (DYNAMIC_IMPORT.test(text)) problems.push(`${path}: uses a dynamic import()`);
    if (text.includes('api.anthropic.com') && path !== '_shared/edge/anthropicProvider.ts') problems.push(`${path}: names the Anthropic endpoint`);
    for (const m of text.matchAll(IMPORT_SPEC)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('./') || spec.startsWith('../')) continue;
      if (spec === SDK_SPECIFIER && path === 'analyze-case/index.ts') continue;
      problems.push(`${path}: imports "${spec}" (only relative imports, and ${SDK_SPECIFIER} in analyze-case/index.ts, are allowed)`);
    }
  }
  if (!files.some((f) => f.path === 'analyze-case/index.ts' && f.text.includes(`from '${SDK_SPECIFIER}'`))) {
    problems.push(`analyze-case/index.ts does not import the pinned SDK ${SDK_SPECIFIER}`);
  }
  for (const marker of REQUIRED_MARKERS) if (!all.includes(marker)) problems.push(`a reviewed safeguard is missing: ${marker}`);
  return problems;
}

/** Problems in a DEPLOYED bundle (decoded text). The bundle may also hold the SDK itself, so only key shapes and our markers are checked. */
export function deployedProblems(text) {
  const problems = [];
  if (typeof text !== 'string' || text.length === 0) return ['the deployed source could not be read'];
  if (KEY_SHAPED.test(text)) problems.push('the deployed source contains something shaped like an Anthropic key');
  if (KIMI_KEY_SHAPED.test(text)) problems.push('the deployed source contains something shaped like a Kimi key');
  for (const marker of [...REQUIRED_MARKERS, '@anthropic-ai/sdk@0.133.0']) {
    if (!text.includes(marker)) problems.push(`the deployed source is not the reviewed Anthropic-capable version (missing: ${marker})`);
  }
  return problems;
}

/** Every .ts/.json file under the functions directory, as {path, text}. */
export function readTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(dir, p).split(sep).join('/'), text: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: function-source-guard.mjs <supabase/functions>'); process.exit(2); }
  const problems = sourceProblems(readTree(dir));
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(problems.length ? 1 : 0);
}
