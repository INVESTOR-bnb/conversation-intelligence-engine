// Guards for the staging live checks (storage-live-check.mjs, analyze-case-live-check.mjs) and
// the end-to-end scripts, checked before any connection is made.
// Messages never repeat the value given: a password or key typed at the wrong
// prompt must not end up on screen.

// The only project the live check may touch: the synthetic STAGING project.
export const STAGING_URL = 'https://aqwdwswpmbnzmkvyuqil.supabase.co';

export function stagingUrlProblem(url) {
  if (typeof url !== 'string' || url === '') return 'no Supabase URL given';
  if (url !== STAGING_URL && url !== `${STAGING_URL}/`) return `this is not the staging project; only ${STAGING_URL} is allowed`;
  return null;
}

// Only a publishable key is accepted. Legacy JWT keys (eyJ…) are refused because
// a service_role JWT looks just like an anon one; secret keys are refused outright.
export function publishableKeyProblem(key) {
  if (typeof key !== 'string' || key === '') return 'no key given';
  if (key.includes('sb_secret_')) return 'a secret key was given';
  if (key.startsWith('eyJ')) return 'a legacy JWT key was given (it may be the service_role key)';
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return 'the key does not start with sb_publishable_ or contains unexpected characters';
  return null;
}

// A Supabase personal access token (classic or scoped: both are sbp_ followed by letters,
// digits or _). Pasting on a phone can add invisible characters at either end (a carriage
// return, a byte-order mark, a non-breaking or zero-width space): those are trimmed — only at
// the ends — and nothing else is changed. Returns { token } or { problem }; the problem names
// the rule that failed and the KIND of character at fault, never the token or any of its
// characters, so it can be shown on screen.
import { createInterface } from 'node:readline';

const EDGE_JUNK = /^[\s\u00a0\u200b-\u200d\u2060\ufeff]+|[\s\u00a0\u200b-\u200d\u2060\ufeff]+$/g;
/** Removes spaces, line breaks and invisible characters at the two ends only. */
export const trimEdges = (v) => (typeof v === 'string' ? v.replace(EDGE_JUNK, '') : v);
const charKind = (c) => (c === '\r' || c === '\n' ? 'a line break' : /\s|\u00a0/.test(c) ? 'a space'
  : /[\u200b-\u200d\u2060\ufeff]/.test(c) ? 'an invisible character' : c === '-' ? 'a hyphen' : c === '.' ? 'a dot'
  : /[\x21-\x7e]/.test(c) ? 'a punctuation mark' : 'a non-ASCII character');
export function accessToken(raw) {
  if (typeof raw !== 'string') return { problem: 'no access token given' };
  const t = trimEdges(raw);
  if (t === '') return { problem: 'no access token given' };
  if (t.startsWith('sb_secret_')) return { problem: 'a secret API key was given, not a personal access token' };
  if (t.startsWith('sb_publishable_')) return { problem: 'a publishable key was given, not a personal access token' };
  if (t.startsWith('eyJ')) return { problem: 'a JWT was given, not a personal access token' };
  if (!t.startsWith('sbp_')) return { problem: 'it does not start with sbp_' };
  const bad = [...t.slice(4)].findIndex((c) => !/[A-Za-z0-9_]/.test(c));
  if (bad >= 0) return { problem: `it contains ${charKind(t[4 + bad])} at character ${4 + bad + 1} of ${t.length} (only letters, digits and _ are expected after sbp_)` };
  if (t.length < 24) return { problem: `it is too short (${t.length} characters; at least 24 expected)` };
  return { token: t };
}

// The paid providers' API key shapes (checked after trimEdges; the message never repeats the key).
export function providerKeyProblem(provider, key) {
  if (typeof key !== 'string' || key === '') return 'no key given';
  if (provider === 'kimi') return /^sk-[A-Za-z0-9_-]{20,300}$/.test(key) && !key.startsWith('sk-ant-') ? null : 'not shaped like a Kimi API key (sk-…)';
  if (provider === 'anthropic') return /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key) ? null : 'not shaped like an Anthropic API key (sk-ant-…)';
  return 'unknown provider';
}

// Reads typed answers (the confirmation phrases). On a real terminal, a line typed BEFORE the
// prompt was shown (an Enter pressed while the script was busy, the second half of a paste)
// is discarded, and blank lines are ignored: only something typed in answer to the prompt
// counts. The answer is returned with spaces and invisible characters trimmed at its ends;
// the caller still requires the exact phrase. From a pipe (tests, automation) every line is
// kept in order, as before; an ended input answers '' (which cancels).
export function answerReader(input = process.stdin, output = process.stdout) {
  const tty = Boolean(input.isTTY);
  const lines = [];
  let waiting = null;
  let closed = false;
  const rl = createInterface({ input, terminal: false });
  const take = (l) => {
    const v = trimEdges(l);
    if (tty && v === '') return;
    if (waiting) { const w = waiting; waiting = null; w(v); } else lines.push(v);
  };
  rl.on('line', take);
  rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
  return {
    ask(prompt) {
      if (tty) lines.length = 0;
      output.write(prompt);
      if (lines.length) return Promise.resolve(lines.shift());
      if (closed) return Promise.resolve('');
      return new Promise((resolve) => { waiting = resolve; });
    },
    close() { rl.close(); },
  };
}
