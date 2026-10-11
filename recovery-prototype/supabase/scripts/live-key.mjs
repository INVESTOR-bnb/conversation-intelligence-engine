// Key check for storage-live-check.mjs. Only a publishable key is accepted.
// Legacy JWT keys (eyJ…) are refused because a service_role JWT looks just like
// an anon one; secret keys (sb_secret_…) are refused outright. The returned
// message never contains the key.
export function publishableKeyProblem(key) {
  if (typeof key !== 'string' || key === '') return 'no key given';
  if (key.includes('sb_secret_')) return 'a secret key was given';
  if (key.startsWith('eyJ')) return 'a legacy JWT key was given (it may be the service_role key)';
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return 'the key does not start with sb_publishable_ or contains unexpected characters';
  return null;
}
