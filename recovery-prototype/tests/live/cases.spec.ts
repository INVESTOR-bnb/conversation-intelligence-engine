// Stage 2A-4b in the browser (mocked Supabase; see mockSupabase.ts): clients
// create and submit pasted-text cases; the founder views submitted cases.
// Database enforcement is tested in supabase/tests/08_client_cases.test.sql.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { MockSupabase, USERS } from './mockSupabase';
import { CASE_MESSAGES } from '../../src/live/cases';

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
  // Sign-in is asynchronous: navigating before it finishes cancels it.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

const CONVO = 'Prospect: Is the synthetic Corolla still available?\nBusiness: Yes, it is.\nProspect: I will think about it.';

async function fillCase(page: Page, ref = 'TEST-001', convo = CONVO) {
  const form = page.locator('form', { has: page.getByRole('heading', { name: 'New case' }) });
  await form.getByLabel('Reference').fill(ref);
  await form.getByLabel('Product or service').fill('Synthetic Corolla');
  await form.getByLabel('Lead source').selectOption('Referral');
  await form.getByLabel('Estimated value').fill('4,500,000');
  await form.getByLabel('Pasted conversation').fill(convo);
  return form;
}

async function clientReady(page: Page) {
  await login(page, 'client');
  await expect(page).toHaveURL(/\/app\/client$/);
  await expect(page.getByTestId('client-cases')).toBeVisible();
}

async function otherSession(context: BrowserContext) {
  const ctx = await context.browser()!.newContext();
  await mock.install(ctx);
  return { ctx, page: await ctx.newPage() };
}

function createKeys(page: Page) {
  const keys: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rest/v1/rpc/client_create_case')) keys.push(JSON.parse(r.postData() ?? '{}').p_idempotency_key);
  });
  return keys;
}

test.describe('client creates and submits a case', () => {
  test('pasted synthetic conversation is created, submitted and listed as Under review', async ({ page }) => {
    await clientReady(page);
    const before = mock.cases.length;
    const form = await fillCase(page);
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('status')).toHaveText('Case TEST-001 submitted for review.');
    const row = page.getByTestId('client-cases').locator('li', { hasText: 'TEST-001 — Synthetic Corolla' });
    await expect(row.getByTestId('client-case-status')).toHaveText('Under review');
    await expect(form.getByLabel('Reference')).toHaveValue('');
    expect(mock.cases).toHaveLength(before + 1);
    expect(mock.cases.at(-1)).toMatchObject({ workflow_state: 'SUBMITTED', reference: 'TEST-001', estimated_value: 4500000, lead_source: 'Referral', conversation: CONVO });
    expect(mock.audit.map((a) => a.action)).toEqual(['CASE_CREATED', 'CASE_SUBMITTED']);
  });

  test('invalid input is explained and nothing is sent', async ({ page }) => {
    await clientReady(page);
    const form = page.locator('form', { has: page.getByRole('heading', { name: 'New case' }) });
    await form.getByRole('button', { name: 'Submit Case' }).click();
    for (const t of ['Enter a reference, for example TEST-001.', 'Enter the product or service.', 'Choose a lead source.', 'Paste the conversation (at least 20 characters).']) {
      await expect(form.getByText(t)).toBeVisible();
    }
    await fillCase(page, 'TEST-002', 'too short');
    await form.getByLabel('Estimated value').fill('lots');
    await form.getByLabel('Last contact date').fill('2999-01-01');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByText('Paste the conversation (at least 20 characters).')).toBeVisible();
    await expect(form.getByText(/numbers only/)).toBeVisible();
    await expect(form.getByText('The last contact cannot be in the future.')).toBeVisible();
    expect(mock.requests.filter((r) => r.includes('client_create_case'))).toEqual([]);
  });

  test('a dropped connection on create, then retry, creates exactly one case (same request ID)', async ({ page }) => {
    await clientReady(page);
    const keys = createKeys(page);
    const before = mock.cases.length;
    mock.loseCreateResponse = true;
    const form = await fillCase(page, 'TEST-003');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('alert')).toHaveText(CASE_MESSAGES.OFFLINE);
    await expect(form.getByLabel('Reference')).toHaveValue('TEST-003'); // kept for retry
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('status')).toHaveText('Case TEST-003 submitted for review.');
    expect(mock.cases).toHaveLength(before + 1);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    // The next case gets a fresh request ID.
    await fillCase(page, 'TEST-004');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('status')).toHaveText('Case TEST-004 submitted for review.');
    expect(keys[2]).not.toBe(keys[0]);
    expect(mock.cases).toHaveLength(before + 2);
  });

  test('a submit whose response is lost is completed on retry without a duplicate', async ({ page }) => {
    await clientReady(page);
    const before = mock.cases.length;
    mock.failSubmit = 'lost';
    const form = await fillCase(page, 'TEST-005');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('alert')).toContainText('Saved as a draft but not submitted');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('status')).toHaveText('Case TEST-005 submitted for review.');
    expect(mock.cases).toHaveLength(before + 1);
    expect(mock.cases.at(-1)!.workflow_state).toBe('SUBMITTED');
  });

  test('a failed submit leaves a draft that can be submitted from the list', async ({ page }) => {
    await clientReady(page);
    mock.failSubmit = 'server';
    const form = await fillCase(page, 'TEST-006');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('alert')).toContainText('Saved as a draft but not submitted');
    const row = page.getByTestId('client-cases').locator('li', { hasText: 'TEST-006' });
    await expect(row.getByTestId('client-case-status')).toHaveText('Draft — not submitted');
    await row.getByRole('button', { name: 'Submit' }).click();
    await expect(row.getByTestId('client-case-status')).toHaveText('Under review');
    await expect(row.getByRole('button', { name: 'Submit' })).toHaveCount(0);
  });

  test('the daily limit is explained', async ({ page }) => {
    await clientReady(page);
    mock.dailyLimit = 2; // business A already has two cases
    const form = await fillCase(page, 'TEST-007');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('alert')).toHaveText(CASE_MESSAGES.RATE_LIMITED);
  });
});

test.describe('founder views submitted cases', () => {
  test('founder sees the submitted case and its conversation; drafts are not listed', async ({ page, context }) => {
    await clientReady(page);
    let form = await fillCase(page, 'TEST-010');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('status')).toBeVisible();
    mock.failSubmit = 'server';
    form = await fillCase(page, 'DRAFT-011');
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('alert')).toContainText('draft');

    const { ctx, page: founder } = await otherSession(context);
    await login(founder, 'founder');
    await expect(founder.getByTestId('founder-case-count')).toHaveText('4');
    const list = founder.getByTestId('founder-case-list');
    await expect(list).toContainText('TEST-010 — Synthetic Corolla');
    await expect(list).toContainText('Synthetic Autos A · Submitted — awaiting analysis');
    await expect(list).not.toContainText('DRAFT-011');
    await list.getByRole('link', { name: /TEST-010/ }).click();
    await expect(founder).toHaveURL(/\/app\/founder\/case\/a0000000-/);
    await expect(founder.getByTestId('case-conversation')).toHaveText(CONVO);
    await expect(founder.getByTestId('founder-case-details')).toContainText('NGN 4,500,000');
    await founder.getByRole('button', { name: 'Founder workspace' }).click();
    await expect(founder).toHaveURL(/\/app\/founder$/);
    await ctx.close();
  });

  test('pasted HTML and script are shown as plain text and never executed', async ({ page, context }) => {
    const evil = 'Prospect: <img src=x onerror="window.__xss=1"><script>window.__xss=2</script><b>bold?</b> synthetic';
    await clientReady(page);
    const form = await fillCase(page, 'XSS-001', evil);
    await form.getByRole('button', { name: 'Submit Case' }).click();
    await expect(form.getByRole('status')).toBeVisible();
    const id = mock.cases.at(-1)!.id;

    const { ctx, page: founder } = await otherSession(context);
    await login(founder, 'founder');
    await expect(founder).toHaveURL(/\/app\/founder$/);
    await founder.goto(`/app/founder/case/${id}`);
    const box = founder.getByTestId('case-conversation');
    await expect(box).toHaveText(evil);
    await expect(box.locator('img, script, b')).toHaveCount(0);
    await founder.waitForTimeout(300);
    expect(await founder.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await ctx.close();
  });

  test('clients and signed-out visitors cannot open a founder case page', async ({ page }) => {
    const id = mock.cases[0].id;
    await page.goto(`/app/founder/case/${id}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fapp%2Ffounder%2Fcase%2F${id}`));
    await clientReady(page);
    await page.goto(`/app/founder/case/${id}`);
    await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible();
    await expect(page.getByTestId('case-conversation')).toHaveCount(0);
    expect(mock.requests.filter((r) => r.includes('/rest/v1/cases') || r.includes('/rest/v1/case_messages'))).toEqual([]);
  });

  test('after signing in, the founder returns to the case they asked for', async ({ page }) => {
    const id = mock.cases[0].id;
    await page.goto(`/app/founder/case/${id}`);
    await page.getByLabel('Email').fill(USERS.founder.email);
    await page.getByLabel('Password').fill(USERS.founder.password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL(new RegExp(`/app/founder/case/${id}$`));
    await expect(page.getByTestId('case-conversation')).toContainText('Is the Camry available?');
  });

  test('unknown or malformed case links are handled', async ({ page }) => {
    await login(page, 'founder');
    await expect(page).toHaveURL(/\/app\/founder$/);
    await page.goto('/app/founder/case/ffffffff-0000-4000-8000-000000000000');
    await expect(page.getByText('Case not found.')).toBeVisible();
    await page.goto('/app/founder/case/not-a-uuid');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
