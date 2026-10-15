// Guards for the staging live checks (storage-live-check.mjs, analyze-case-live-check.mjs),
// checked before any connection is made.
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
const EDGE_JUNK = /^[\s\u00a0\u200b-\u200d\u2060\ufeff]+|[\s\u00a0\u200b-\u200d\u2060\ufeff]+$/g;
const charKind = (c) => (c === '\r' || c === '\n' ? 'a line break' : /\s|\u00a0/.test(c) ? 'a space'
  : /[\u200b-\u200d\u2060\ufeff]/.test(c) ? 'an invisible character' : c === '-' ? 'a hyphen' : c === '.' ? 'a dot'
  : /[\x21-\x7e]/.test(c) ? 'a punctuation mark' : 'a non-ASCII character');
export function accessToken(raw) {
  if (typeof raw !== 'string') return { problem: 'no access token given' };
  const t = raw.replace(EDGE_JUNK, '');
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
