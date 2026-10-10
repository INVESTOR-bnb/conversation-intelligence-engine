// Parses what Supabase Auth appends to the redirect URL after an emailed link
// (invitation, password recovery). Dashboard invitations use the implicit
// flow: tokens or an error arrive in the URL fragment. Errors may also arrive
// in the query string. Pure function: no side effects, unit tested.

export type CallbackResult =
  | { kind: 'session'; accessToken: string; refreshToken: string; linkType: string }
  | { kind: 'error'; reason: 'expired' | 'invalid' | 'unknown'; message: string }
  | { kind: 'code'; code: string }
  | { kind: 'none' };

const EXPIRED =
  'This invitation or sign-in link has expired or has already been used. Ask the founder to send you a new invitation, then open the newest email only.';
const INVALID = 'This link is not valid. Open the most recent invitation email and tap the link again, or ask for a new invitation.';

function params(raw: string): URLSearchParams {
  return new URLSearchParams(raw.replace(/^[#?]/, ''));
}

/** True when the fragment/query carries Supabase auth results (not a Stage-1 "#/route"). */
export function looksLikeAuthCallback(hash: string, search: string): boolean {
  if (hash.startsWith('#/')) return false;
  const h = params(hash);
  const q = params(search);
  return ['access_token', 'refresh_token', 'error', 'error_code', 'error_description'].some((k) => h.has(k)) ||
    ['error', 'error_code', 'error_description', 'code'].some((k) => q.has(k));
}

export function parseAuthCallback(hash: string, search: string): CallbackResult {
  const h = hash.startsWith('#/') ? new URLSearchParams() : params(hash);
  const q = params(search);
  const errorCode = h.get('error_code') ?? q.get('error_code');
  const error = h.get('error') ?? q.get('error');
  if (errorCode || error) {
    if (errorCode === 'otp_expired' || errorCode === 'flow_state_expired') return { kind: 'error', reason: 'expired', message: EXPIRED };
    if (error === 'access_denied' || errorCode === 'bad_jwt' || errorCode === 'flow_state_not_found') {
      return { kind: 'error', reason: 'invalid', message: INVALID };
    }
    return { kind: 'error', reason: 'unknown', message: 'Sign-in could not be completed. Ask for a new invitation and try again.' };
  }
  const accessToken = h.get('access_token');
  const refreshToken = h.get('refresh_token');
  if (accessToken || refreshToken) {
    if (!accessToken || !refreshToken || accessToken.split('.').length !== 3) {
      return { kind: 'error', reason: 'invalid', message: INVALID };
    }
    return { kind: 'session', accessToken, refreshToken, linkType: h.get('type') ?? 'unknown' };
  }
  const code = q.get('code');
  if (code) return { kind: 'code', code };
  return { kind: 'none' };
}

export const CALLBACK_MESSAGES = { EXPIRED, INVALID };
