// Stage 2A-4a founder onboarding in the browser (mocked Supabase; see mockSupabase.ts).
// Database-side enforcement of the same rules is tested in supabase/tests/07_onboarding.test.sql.

import { expect, test, type Page } from '@playwright/test';
import { MOCK_URL, MockSupabase, USERS } from './mockSupabase';
import { ONBOARDING_MESSAGES } from '../../src/live/onboarding';

let mock: MockSupabase;

test.beforeEach(async ({ context }) => {
  mock = new MockSupabase();
  await mock.install(context);
});

async function login(page: Page, who: keyof typeof USERS) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(USERS[who].email);
  await page.getByLabel('Password').fill(USERS[who].password);
  await page.getByRole('button', { name: 'Sign In' }).click();
}

async function founderReady(page: Page) {
  await login(page, 'founder');
  await expect(page).toHaveURL(/\/app\/founder$/);
  await expect(page.getByTestId('founder-business-count')).toHaveText('2');
}

const rpcCalls = (name: string) => mock.requests.filter((r) => r.includes(`/rest/v1/rpc/${name}`));
const createForm = (page: Page) => page.locator('form', { has: page.getByRole('heading', { name: 'Create business' }) });
const linkForm = (page: Page) => page.locator('form', { has: page.getByRole('heading', { name: 'Link client' }) });

test.describe('create business', () => {
  test('founder creates a synthetic business; list and count refresh', async ({ page }) => {
    await founderReady(page);
    const form = createForm(page);
    await form.getByLabel('Business name').fill('  Synthetic Bakery C  ');
    await form.getByLabel('Industry').fill('Food');
    await form.getByLabel('Currency').fill('ngn');
    await form.getByRole('button', { name: 'Create Business' }).click();
    await expect(form.getByRole('status')).toHaveText('Business “Synthetic Bakery C” created.');
    await expect(page.getByTestId('founder-business-count')).toHaveText('3');
    await expect(page.getByTestId('founder-business-list')).toContainText('Synthetic Bakery C');
    await expect(page.getByTestId('founder-business-list')).toContainText('Food · NGN · 0 linked clients');
    await expect(form.getByLabel('Business name')).toHaveValue('');
    expect(mock.businesses.at(-1)).toMatchObject({ name: 'Synthetic Bakery C', industry: 'Food', currency: 'NGN' });
    expect(mock.audit).toEqual([expect.objectContaining({ action: 'BUSINESS_CREATED' })]);
    // The new business can be chosen for linking straight away.
    await expect(linkForm(page).getByLabel('Business').locator('option', { hasText: 'Synthetic Bakery C' })).toHaveCount(1);
  });

  test('invalid input is explained and nothing is sent', async ({ page }) => {
    await founderReady(page);
    const form = createForm(page);
    await form.getByLabel('Business name').fill('   ');
    await form.getByLabel('Currency').fill('NA');
    await form.getByRole('button', { name: 'Create Business' }).click();
    await expect(form.getByText('Enter a business name.')).toBeVisible();
    await expect(form.getByText('Use a 3-letter currency code, for example NGN.')).toBeVisible();
    await form.getByLabel('Business name').fill('x'.repeat(121));
    await form.getByLabel('Currency').fill('NGN');
    await form.getByRole('button', { name: 'Create Business' }).click();
    await expect(form.getByText('Use at most 120 characters.')).toBeVisible();
    expect(rpcCalls('founder_create_business')).toEqual([]);
    await expect(page.getByTestId('founder-business-count')).toHaveText('2');
  });

  test('a database rejection is shown and nothing is claimed', async ({ page }) => {
    await founderReady(page);
    await page.route(`${MOCK_URL}/rest/v1/rpc/founder_create_business`, (route) =>
      route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '23514', message: 'violates check constraint' }) }));
    const form = createForm(page);
    await form.getByLabel('Business name').fill('Synthetic Rejected D');
    await form.getByRole('button', { name: 'Create Business' }).click();
    await expect(form.getByRole('alert')).toHaveText(ONBOARDING_MESSAGES.INVALID);
    await expect(form.getByRole('status')).toHaveCount(0);
    await expect(page.getByTestId('founder-business-count')).toHaveText('2');
  });
});

test.describe('link client', () => {
  test('founder links an invited account; the client then sees only that business', async ({ page, context }) => {
    await founderReady(page);
    const create = createForm(page);
    await create.getByLabel('Business name').fill('Synthetic Bakery C');
    await create.getByRole('button', { name: 'Create Business' }).click();
    await expect(page.getByTestId('founder-business-count')).toHaveText('3');

    const form = linkForm(page);
    await form.getByLabel('Business').selectOption({ label: 'Synthetic Bakery C' });
    await form.getByLabel('Client User ID').fill(`  ${USERS.pending.id.toUpperCase()}  `);
    await form.getByRole('button', { name: 'Link Client' }).click();
    await expect(form.getByRole('status')).toContainText('Client linked to “Synthetic Bakery C”');
    await expect(form.getByLabel('Client User ID')).toHaveValue('');
    await expect(page.getByTestId('founder-business-list')).toContainText('1 linked client');
    expect(mock.audit.map((a) => a.action)).toEqual(['BUSINESS_CREATED', 'MEMBER_ADDED']);

    // The client, in a separate browser session.
    const other = await context.browser()!.newContext();
    await mock.install(other);
    const client = await other.newPage();
    await login(client, 'pending');
    await expect(client).toHaveURL(/\/app\/client$/);
    await expect(client.getByText('Synthetic Bakery C')).toBeVisible();
    await expect(client.getByText('No cases yet.')).toBeVisible();
    for (const path of ['/app/founder', '/demo']) {
      await client.goto(path);
      await expect(client.getByRole('heading', { name: 'Not authorised' })).toBeVisible();
    }
    // The (RLS-mirroring) API returns the client's own business only.
    const visible = await client.evaluate(async ([url, key]) => {
      const token = JSON.parse(localStorage.getItem('rre-auth')!).access_token;
      const r = await fetch(`${url}/rest/v1/businesses?select=name`, { headers: { apikey: key, authorization: `Bearer ${token}` } });
      return r.json();
    }, [MOCK_URL, 'sb_publishable_TEST_ONLY_not_a_real_key']);
    expect(visible).toEqual([expect.objectContaining({ name: 'Synthetic Bakery C' })]);
    await other.close();
  });

  test('duplicate membership, the founder account and unknown IDs are refused with clear messages', async ({ page }) => {
    await founderReady(page);
    const form = linkForm(page);
    await form.getByLabel('Business').selectOption({ label: 'Synthetic Academy B' });
    const attempt = async (id: string, message: string) => {
      await form.getByLabel('Client User ID').fill(id);
      await form.getByRole('button', { name: 'Link Client' }).click();
      await expect(form.getByRole('alert')).toHaveText(message);
      await expect(form.getByRole('status')).toHaveCount(0);
    };
    await attempt(USERS.client.id, ONBOARDING_MESSAGES.ALREADY_LINKED);
    await attempt(USERS.founder.id, ONBOARDING_MESSAGES.IS_FOUNDER);
    await attempt('aaaaaaaa-0000-4000-8000-000000000000', ONBOARDING_MESSAGES.USER_NOT_FOUND);
    expect(mock.members.get(USERS.client.id)).toBe('b1');
    expect(mock.audit).toEqual([]);
    // Linking the same account twice: the second attempt is refused.
    await form.getByLabel('Client User ID').fill(USERS.pending.id);
    await form.getByRole('button', { name: 'Link Client' }).click();
    await expect(form.getByRole('status')).toBeVisible();
    await attempt(USERS.pending.id, ONBOARDING_MESSAGES.ALREADY_LINKED);
    expect([...mock.members.values()].filter((b) => b === 'b2')).toHaveLength(1);
  });

  test('invalid link input is explained and nothing is sent', async ({ page }) => {
    await founderReady(page);
    const form = linkForm(page);
    await form.getByRole('button', { name: 'Link Client' }).click();
    await expect(form.getByText('Choose a business.')).toBeVisible();
    await expect(form.getByText('Paste the client’s User ID.')).toBeVisible();
    await form.getByLabel('Business').selectOption({ label: 'Synthetic Autos A' });
    await form.getByLabel('Client User ID').fill('not-a-user-id');
    await form.getByRole('button', { name: 'Link Client' }).click();
    await expect(form.getByText(/That is not a valid User ID/)).toBeVisible();
    expect(rpcCalls('founder_add_member')).toEqual([]);
  });

  test('a business deleted meanwhile is reported', async ({ page }) => {
    await founderReady(page);
    const form = linkForm(page);
    await form.getByLabel('Business').selectOption({ label: 'Synthetic Academy B' });
    mock.businesses = mock.businesses.filter((b) => b.id !== 'b2');
    await form.getByLabel('Client User ID').fill(USERS.pending.id);
    await form.getByRole('button', { name: 'Link Client' }).click();
    await expect(form.getByRole('alert')).toHaveText(ONBOARDING_MESSAGES.BUSINESS_NOT_FOUND);
  });
});

test.describe('permission and failure handling', () => {
  test('non-founders cannot reach the onboarding forms', async ({ page }) => {
    for (const who of ['client', 'pending'] as const) {
      await login(page, who);
      await page.goto('/app/founder');
      await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Create business' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/\/login/);
    }
    expect(rpcCalls('founder_')).toEqual([]);
  });

  test('if the server refuses the founder (FORBIDDEN), a permission message is shown', async ({ page }) => {
    await founderReady(page);
    // e.g. founder row removed by an administrator while the page was open
    USERS.founder.role = 'NONE';
    try {
      const form = createForm(page);
      await form.getByLabel('Business name').fill('Synthetic Forbidden E');
      await form.getByRole('button', { name: 'Create Business' }).click();
      await expect(form.getByRole('alert')).toHaveText(ONBOARDING_MESSAGES.FORBIDDEN);
      const link = linkForm(page);
      await link.getByLabel('Business').selectOption({ label: 'Synthetic Autos A' });
      await link.getByLabel('Client User ID').fill(USERS.pending.id);
      await link.getByRole('button', { name: 'Link Client' }).click();
      await expect(link.getByRole('alert')).toHaveText(ONBOARDING_MESSAGES.FORBIDDEN);
      expect(mock.businesses).toHaveLength(2);
      expect(mock.members.size).toBe(1);
    } finally {
      USERS.founder.role = 'FOUNDER';
    }
  });

  test('server errors and dropped connections are reported; nothing is claimed', async ({ page }) => {
    await founderReady(page);
    const form = createForm(page);
    mock.failRpc = 'server';
    await form.getByLabel('Business name').fill('Synthetic Failure F');
    await form.getByRole('button', { name: 'Create Business' }).click();
    await expect(form.getByRole('alert')).toHaveText(ONBOARDING_MESSAGES.UNKNOWN);
    mock.failRpc = 'network';
    await form.getByRole('button', { name: 'Create Business' }).click();
    await expect(form.getByRole('alert')).toHaveText(ONBOARDING_MESSAGES.OFFLINE);
    await expect(form.getByRole('status')).toHaveCount(0);
    await expect(form.getByLabel('Business name')).toHaveValue('Synthetic Failure F'); // kept for retry
    mock.failRpc = false;
    await form.getByRole('button', { name: 'Create Business' }).click();
    await expect(form.getByRole('status')).toHaveText('Business “Synthetic Failure F” created.');
    await expect(page.getByTestId('founder-business-count')).toHaveText('3');
  });
});
