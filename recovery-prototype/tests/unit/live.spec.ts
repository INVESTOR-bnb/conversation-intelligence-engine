// Pure-logic tests for the live (Supabase) layer: key safety, callback parsing,
// open-redirect protection. No browser, no network.

import { expect, test } from '@playwright/test';
import { looksLikeAuthCallback, parseAuthCallback } from '../../src/live/authCallback';
import { readLiveConfig, unsafeKeyReason } from '../../src/live/config';
import { safeNext } from '../../src/live/router';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: object) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';

test.describe('configuration never accepts privileged keys', () => {
  test('unconfigured when nothing is set (Stage-1 demo mode)', () => {
    expect(readLiveConfig({}).status).toBe('unconfigured');
  });
  test('accepts a publishable key and the legacy anon JWT', () => {
    expect(readLiveConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc123' }).status).toBe('ok');
    expect(readLiveConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon' }) }).status).toBe('ok');
  });
  test('refuses secret and service-role keys', () => {
    expect(unsafeKeyReason('sb_secret_abc123')).toMatch(/secret key/);
    expect(unsafeKeyReason(jwt({ role: 'service_role' }))).toMatch(/service_role/);
    expect(readLiveConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'service_role' }) }).status).toBe('invalid');
    expect(readLiveConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_x' }).status).toBe('invalid');
  });
  test('refuses unknown key formats, non-https and path-bearing URLs, and half configuration', () => {
    expect(unsafeKeyReason('random-string')).not.toBeNull();
    expect(readLiveConfig({ VITE_SUPABASE_URL: 'http://x.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_a' }).status).toBe('invalid');
    expect(readLiveConfig({ VITE_SUPABASE_URL: `${URL_OK}/rest/v1`, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_a' }).status).toBe('invalid');
    expect(readLiveConfig({ VITE_SUPABASE_URL: URL_OK }).status).toBe('invalid');
  });
});

test.describe('invitation callback parsing', () => {
  const at = jwt({ sub: 'u1', exp: 9999999999 });
  test('invite tokens in the fragment', () => {
    const r = parseAuthCallback(`#access_token=${at}&expires_in=3600&refresh_token=rt1&token_type=bearer&type=invite`, '');
    expect(r).toEqual({ kind: 'session', accessToken: at, refreshToken: 'rt1', linkType: 'invite' });
  });
  test('expired or already-used link (otp_expired), in fragment or query', () => {
    const frag = parseAuthCallback('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', '');
    expect(frag).toMatchObject({ kind: 'error', reason: 'expired' });
    expect(parseAuthCallback('', '?error=access_denied&error_code=otp_expired')).toMatchObject({ kind: 'error', reason: 'expired' });
  });
  test('denied or malformed links are invalid', () => {
    expect(parseAuthCallback('#error=access_denied', '')).toMatchObject({ kind: 'error', reason: 'invalid' });
    expect(parseAuthCallback('#access_token=not-a-jwt&refresh_token=x', '')).toMatchObject({ kind: 'error', reason: 'invalid' });
    expect(parseAuthCallback(`#access_token=${at}`, '')).toMatchObject({ kind: 'error', reason: 'invalid' });
  });
  test('Stage-1 hash routes are never mistaken for callbacks', () => {
    expect(looksLikeAuthCallback('#/client/case/case-001', '')).toBe(false);
    expect(parseAuthCallback('#/admin', '')).toEqual({ kind: 'none' });
    expect(looksLikeAuthCallback(`#access_token=${at}&refresh_token=r`, '')).toBe(true);
    expect(looksLikeAuthCallback('', '?error_code=otp_expired')).toBe(true);
  });
  test('PKCE code is recognised (not completable for dashboard invites)', () => {
    expect(parseAuthCallback('', '?code=abc')).toEqual({ kind: 'code', code: 'abc' });
  });
});

test.describe('post-login redirect cannot leave the app', () => {
  test('allows known internal paths only', () => {
    expect(safeNext('/app/founder')).toBe('/app/founder');
    expect(safeNext('/demo')).toBe('/demo');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/auth/callback', '/unknown', null, '']) {
      expect(safeNext(bad as string | null)).toBe('/app');
    }
  });
});
