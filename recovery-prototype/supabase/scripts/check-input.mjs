#!/usr/bin/env node
// Checks ONE answer typed at an end-to-end script prompt, so a wrong or empty answer is asked
// again at the SAME prompt instead of shifting every later answer onto the wrong prompt.
// Usage (from the .sh wrappers): printf '%s' "$value" | node supabase/scripts/check-input.mjs <kind>
// The value arrives on stdin only (never on a command line). Exit 0: accepted. Exit 1: the
// reason is printed on stderr — it never contains the value.
import { accessToken, providerKeyProblem, publishableKeyProblem, trimEdges } from './live-guards.mjs';

const SECRET_SHAPED = /^(sbp_|sb_secret_|sk-|eyJ)/;
const checks = {
  pat: (v) => accessToken(v).problem ?? null,
  publishable: (v) => (SECRET_SHAPED.test(trimEdges(v)) ? 'that looks like a secret, not the publishable key' : publishableKeyProblem(trimEdges(v))),
  email: (v) => (SECRET_SHAPED.test(trimEdges(v)) ? 'that looks like a secret, not an email address' : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimEdges(v)) ? null : 'not an email address'),
  password: (v) => (v === '' ? 'empty' : null),
  provider: (v) => (['kimi', 'anthropic'].includes(trimEdges(v)) ? null : 'type exactly kimi or anthropic'),
  'kimi-key': (v) => providerKeyProblem('kimi', trimEdges(v)),
  'anthropic-key': (v) => providerKeyProblem('anthropic', trimEdges(v)),
  model: (v) => (['claude-sonnet-5-5', 'claude-opus-5-5'].includes(trimEdges(v)) ? null : 'type exactly claude-sonnet-5-5 or claude-opus-5-5'),
  usd: (v) => (/^\d+(\.\d{1,2})?$/.test(trimEdges(v)) && Number(trimEdges(v)) > 0 ? null : 'a positive amount in USD, for example 5'),
  'usd-or-default': (v) => (trimEdges(v) === '' ? null : /^\d+(\.\d{1,2})?$/.test(trimEdges(v)) && Number(trimEdges(v)) > 0 ? null : 'a positive amount in USD, or Enter for the default'),
};
const check = checks[process.argv[2]];
if (!check) { console.error('unknown kind of answer'); process.exit(2); }
let value = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) value += chunk;
const problem = check(value);
if (problem) { console.error(problem); process.exit(1); }
