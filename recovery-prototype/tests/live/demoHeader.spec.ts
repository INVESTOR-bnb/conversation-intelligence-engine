// Demo presentation: businesses and visitors see the product name with a DEMO label and the
// sample-only rule (also next to the submission form); only the founder sees the technical
// staging label. Mocked Supabase, 390px viewport (playwright.live.config.ts).

import { expect, test, type Page } from '@playwright/test';
import { MockSupabase, USERS } from './mockSupabase';

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
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

const header = (page: Page) => page.getByRole('region', { name: 'Environment' });
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('business: product name, a small DEMO label and the sample-only rule; no technical staging banner', async ({ page }) => {
  await login(page, 'client');
  await expect(page.getByTestId('client-cases')).toBeVisible();
  const h = header(page);
  await expect(h).toContainText('Revenue Recovery Engine');
  await expect(h.getByTestId('demo-label')).toHaveText(/demo/i);
  await expect(h).toContainText('Demo workspace · sample conversations only');
  await expect(page.getByText(/staging/i)).toHaveCount(0);
  await expect(h.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
});

test('business: the sample-only rule sits in the submission form, for pasted text and for screenshots', async ({ page }) => {
  await login(page, 'client');
  const form = page.locator('form', { has: page.getByRole('heading', { name: 'New case' }) });
  await expect(form.getByTestId('demo-submit-rule')).toContainText('Use sample conversations only');
  await expect(form.getByTestId('demo-submit-rule')).toContainText('never paste or upload a real customer');
  await expect(form).toContainText('No real customer chats.');
  await form.getByRole('button', { name: 'Upload screenshots' }).click();
  await expect(form).toContainText('Sample screenshots only');
  await expect(form.getByText('Demo workspace · sample conversations only')).toBeVisible(); // right above Submit
  expect(await noSideScroll(page)).toBe(true);
});

test('sign-in page (seen during demos): DEMO header, never presented as a production service', async ({ page }) => {
  await page.goto('/login');
  await expect(header(page).getByTestId('demo-label')).toBeVisible();
  await expect(header(page)).toContainText('sample conversations only');
  await expect(page.getByText(/staging/i)).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
});

test('founder: keeps the technical staging label, without the business demo header', async ({ page }) => {
  await login(page, 'founder');
  await expect(page).toHaveURL(/\/app\/founder/);
  await expect(header(page)).toContainText('Staging · synthetic data only');
  await expect(header(page)).toContainText('founder');
  await expect(page.getByTestId('demo-label')).toHaveCount(0);
});

test('an account not yet linked to a business gets the demo header, not the founder one', async ({ page }) => {
  await login(page, 'pending');
  await expect(header(page).getByTestId('demo-label')).toBeVisible();
  await expect(header(page)).toContainText('not yet authorised');
  await expect(page.getByText('Staging · synthetic data only')).toHaveCount(0);
});
