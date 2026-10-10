// Live-mode frontend authentication tests (mocked Supabase; see mockSupabase.ts).
// These verify ROUTE GUARDS and auth flows in the browser. They do not, and
// cannot, prove database authorization — that is covered by supabase/tests
// (local PostgreSQL) and must still be re-run against the real project.

import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MOCK_URL, MockSupabase, USERS } from './mockSupabase';

let mock: MockSupabase;

test.beforeEach(async ({ context }) => {
  mock = new MockSupabase();
  await mock.install(context);
});

async function login(page: Page, who: 'founder' | 'client') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(USERS[who].email);
  await page.getByLabel('Password').fill(USERS[who].password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  // Sign-in is asynchronous: navigating before it finishes cancels it.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('unauthenticated access is blocked', () => {
  for (const path of ['/app', '/app/founder', '/app/client', '/demo', '/auth/set-password']) {
    test(`direct navigation to ${path} goes to sign in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByText('Founder workspace')).toHaveCount(0);
    });
  }

  test('root redirects to sign in; no public sign-up exists', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/sign up|create account|register/i)).toHaveCount(0);
  });
});

test.describe('sign in, session and sign out', () => {
  test('wrong password shows a clear error and no user enumeration', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(USERS.founder.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
    await page.getByLabel('Email').fill('nobody@synthetic.test');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  });

  test('founder signs in and lands on the founder workspace (role from server)', async ({ page }) => {
    await login(page, 'founder');
    await expect(page).toHaveURL(/\/app\/founder$/);
    await expect(page.getByTestId('founder-business-count')).toHaveText('2');
    await expect(page.getByTestId('founder-case-count')).toHaveText('3');
  });

  test('session survives reload and reopening the app', async ({ page, context }) => {
    await login(page, 'founder');
    await expect(page).toHaveURL(/\/app\/founder$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Founder workspace' })).toBeVisible();
    const reopened = await context.newPage();
    await reopened.goto('/app');
    await expect(reopened).toHaveURL(/\/app\/founder$/);
  });

  test('sign out removes access and the stored session', async ({ page }) => {
    await login(page, 'founder');
    await expect(page).toHaveURL(/\/app\/founder$/);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => localStorage.getItem('rre-auth'))).toBeNull();
    await page.goto('/app/founder');
    await expect(page).toHaveURL(/\/login/);
  });

  test('after sign-in the user returns to the page they asked for (internal only)', async ({ page }) => {
    await page.goto('/demo');
    await expect(page).toHaveURL(/\/login\?next=%2Fdemo/);
    await page.getByLabel('Email').fill(USERS.founder.email);
    await page.getByLabel('Password').fill(USERS.founder.password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL(/\/demo$/);
  });

  test('external ?next= is ignored (no open redirect)', async ({ page }) => {
    await page.goto('/login?next=https%3A%2F%2Fevil.example%2F');
    await page.getByLabel('Email').fill(USERS.founder.email);
    await page.getByLabel('Password').fill(USERS.founder.password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL(/localhost:4181\/app\/founder$/);
  });
});

test.describe('role separation in the UI (server-derived role)', () => {
  test('client lands on client workspace; metadata claiming FOUNDER is ignored', async ({ page }) => {
    await login(page, 'client');
    await expect(page).toHaveURL(/\/app\/client$/);
    await expect(page.getByTestId('client-cases')).toContainText('P-101 — Synthetic Camry');
  });

  test('client cannot open founder routes or the founder-only demo', async ({ page }) => {
    await login(page, 'client');
    await expect(page).toHaveURL(/\/app\/client$/);
    for (const path of ['/app/founder', '/demo']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible();
      await expect(page.getByText('Founder workspace')).toHaveCount(0);
    }
    expect(mock.requests.filter((r) => r.includes('/rest/v1/businesses') || r.includes('/rest/v1/cases'))).toEqual([]);
  });

  test('client page shows only client-safe fields', async ({ page }) => {
    await login(page, 'client');
    await expect(page.getByTestId('client-cases')).toBeVisible();
    const text = await page.locator('main').innerText();
    for (const s of ['analysis', 'Recovery Score', 'Confidence', 'Admin Notes', 'founder note']) expect(text).not.toContain(s);
  });

  test('if the role cannot be verified, access is denied (fail closed)', async ({ page }) => {
    mock.whoamiFails = true;
    await login(page, 'founder');
    await expect(page.getByText('Your access could not be verified')).toBeVisible();
    await expect(page.getByText('Founder workspace')).toHaveCount(0);
  });

  test('founder can open the Stage-1 prototype at /demo', async ({ page }) => {
    await login(page, 'founder');
    await page.goto('/demo#/admin');
    await expect(page.getByRole('heading', { name: 'Recovery Control Room' })).toBeVisible();
    await expect(page).toHaveURL(/\/demo#\/admin$/);
  });
});

test.describe('invitation links', () => {
  test('valid invitation at /auth/callback: tokens removed from URL, password required first', async ({ page }) => {
    await page.goto(`/auth/callback${mock.inviteFragment(USERS.invited.id)}`);
    await expect(page).toHaveURL(/\/auth\/set-password$/);
    expect(page.url()).not.toContain('access_token');
    // Cannot skip password setup.
    await page.goto('/app');
    await expect(page).toHaveURL(/\/auth\/set-password$/);
    await page.getByLabel('New password').fill('short');
    await page.getByLabel('Confirm password').fill('short');
    await page.getByRole('button', { name: 'Save Password' }).click();
    await expect(page.getByRole('alert')).toHaveText('Use at least 10 characters.');
    await page.getByLabel('New password').fill('a-long-synthetic-pass');
    await page.getByLabel('Confirm password').fill('a-different-pass-xyz');
    await page.getByRole('button', { name: 'Save Password' }).click();
    await expect(page.getByRole('alert')).toHaveText('The two passwords do not match.');
    await page.getByLabel('Confirm password').fill('a-long-synthetic-pass');
    await page.getByRole('button', { name: 'Save Password' }).click();
    // Invited but not yet authorised by the database: sees nothing, gets user id for bootstrap.
    await expect(page.getByRole('heading', { name: 'Account not yet authorised' })).toBeVisible();
    await expect(page.getByTestId('account-user-id')).toHaveText(USERS.invited.id);
    // The new password works for a normal sign-in.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Email').fill(USERS.invited.email);
    await page.getByLabel('Password').fill('a-long-synthetic-pass');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByRole('heading', { name: 'Account not yet authorised' })).toBeVisible();
  });

  test('invitation redirected to the site root (Site URL) is handled too', async ({ page }) => {
    await page.goto(`/${mock.inviteFragment(USERS.invited.id)}`);
    await expect(page).toHaveURL(/\/auth\/set-password$/);
  });

  test('expired or already-used invitation fails safely with guidance', async ({ page }) => {
    await page.goto('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await expect(page.getByRole('alert')).toContainText('expired or has already been used');
    expect(page.url()).not.toContain('error_code');
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login/);
  });

  test('tampered or unknown invitation tokens are rejected by the server check', async ({ page }) => {
    const forged = mock.inviteFragment(USERS.invited.id).replace(/access_token=[^&]+/, 'access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwiZXhwIjo5OTk5OTk5OTk5fQ.forged');
    await page.goto(`/auth/callback${forged}`);
    await expect(page.getByRole('alert')).toContainText('This link is not valid');
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login/);
  });

  test('malformed invitation link fails safely', async ({ page }) => {
    await page.goto('/auth/callback#access_token=abc&type=invite');
    await expect(page.getByRole('alert')).toContainText('This link is not valid');
  });

  test('server rejecting the new password (weak) shows a useful message', async ({ page }) => {
    await page.goto(`/auth/callback${mock.inviteFragment(USERS.invited.id)}`);
    await expect(page).toHaveURL(/\/auth\/set-password$/);
    // Client-side minimum is 10; simulate a server policy that rejects it anyway.
    await page.route(`${MOCK_URL}/auth/v1/user`, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 422, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 422, error_code: 'weak_password', msg: 'weak' }) })
        : route.fallback());
    await page.getByLabel('New password').fill('aaaaaaaaaaaa');
    await page.getByLabel('Confirm password').fill('aaaaaaaaaaaa');
    await page.getByRole('button', { name: 'Save Password' }).click();
    await expect(page.getByRole('alert')).toContainText('too weak');
  });
});

test.describe('build output', () => {
  test('bundle contains no secret or service-role keys; only the public key', () => {
    const dir = join(process.cwd(), 'dist-live', 'assets');
    const js = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(js).toContain('sb_publishable_TEST_ONLY_not_a_real_key');
    expect(js).not.toMatch(/sb_secret_[A-Za-z0-9]/);
    // No JWT whose payload declares the service_role.
    const jwts = js.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g) ?? [];
    for (const t of jwts) expect(Buffer.from(t.split('.')[1], 'base64url').toString()).not.toContain('service_role');
  });

  test('security headers are generated with a CSP limited to the Supabase project', () => {
    const headers = readFileSync(join(process.cwd(), 'dist-live', '_headers'), 'utf8');
    expect(headers).toContain(`connect-src 'self' ${MOCK_URL}`);
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('Referrer-Policy: no-referrer');
  });
});
