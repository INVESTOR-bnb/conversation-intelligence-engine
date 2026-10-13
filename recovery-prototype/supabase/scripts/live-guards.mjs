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
