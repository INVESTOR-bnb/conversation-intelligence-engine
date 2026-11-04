// WhatsApp preview screens at 390px (mocked Supabase + mocked WhatsApp RPCs). Frontend behaviour only:
// the database and Edge Function rules are tested in supabase/whatsapp and tests/pipeline/whatsapp-e2e.
import { expect, test, type Page, type Route } from '@playwright/test';
import { MockSupabase, USERS } from '../live/mockSupabase';

const base = { status: 'CONNECTED', action_code: null, number_last4: '0001',
  history: { status: 'COMPLETE', progress: 100, oldest: '2026-08-10T00:00:00Z', newest: '2026-10-25T00:00:00Z', kept: 42, discarded: 7 },
  authorization: null as null | Record<string, unknown>, counts: { conversations_reviewed: 3, followups_sent: 1, replies_received: 1, waiting_for_permission: 2 } };
let status: Record<string, unknown>;
let calls: { fn: string; body: Record<string, unknown> }[];

async function setup(page: Page, who: keyof typeof USERS) {
  const mock = new MockSupabase();
  await mock.install(page.context());
  calls = [];
  await page.route('**/rest/v1/rpc/*_wa_*', async (route: Route) => {
    const fn = new URL(route.request().url()).pathname.split('/').pop()!;
    const body = JSON.parse(route.request().postData() || '{}');
    calls.push({ fn, body });
    const ok = (b: unknown) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (fn === 'client_wa_status') return ok(status);
    if (fn === 'client_wa_contacts') return ok([
      { id: 'c1', number: '+2348000000011', permission: 'UNKNOWN', taken_over: false, evidence_incomplete: false, last_message_at: '2026-10-25T00:00:00Z', case_status: 'SUBMITTED' },
      { id: 'c2', number: '+2348000000012', permission: 'OPTED_IN', taken_over: true, evidence_incomplete: true, last_message_at: '2026-10-20T00:00:00Z', case_status: 'WAITING_FOR_PROSPECT' }]);
    if (fn === 'client_wa_pause') { status = { ...status, status: body.p_paused ? 'PAUSED' : 'CONNECTED' }; return ok(status.status); }
    if (fn === 'founder_wa_overview') return ok({ sending_enabled: false, businesses: [{ business: 'Synthetic Autos A', status: 'CONNECTED', action_code: null, history_status: 'COMPLETE',
      sends: { ACCEPTED: 1 }, unknown_sends: [{ send_id: 'u1', kind: 'REPLY_TEXT', detail: 'TIMEOUT' }] }] });
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto('/login');
  await page.getByLabel('Email').fill(USERS[who].email);
  await page.getByLabel('Password').fill(USERS[who].password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.beforeEach(() => { status = { ...base, status: 'DISCONNECTED', number_last4: null, history: { ...base.history, status: 'NOT_REQUESTED', kept: 0, discarded: 0 } }; });

test('not connected: the honest scope (6 months, 1:1 only, groups stay in the app, permission, STOP, charges) and Connect WhatsApp', async ({ page }) => {
  await setup(page, 'client');
  await page.getByRole('button', { name: 'Connect or manage WhatsApp' }).click();
  await expect(page).toHaveURL(/\/app\/client\/whatsapp$/);
  const scope = page.getByTestId('wa-scope');
  await expect(scope).toContainText('at most your last 6 months of one-to-one chats, once');
  await expect(scope).toContainText('Group chats are not shared with RRE (they stay in your app)');
  await expect(scope).toContainText('only prospects you confirm agreed');
  await expect(scope).toContainText('replies STOP is never messaged again');
  await expect(scope).toContainText('Meta charges per message');
  // authorization comes first: Connect is disabled until it is saved
  await expect(page.getByRole('button', { name: 'Connect WhatsApp' })).toBeDisabled();
  await expect(page.getByTestId('wa-authorize-first')).toContainText('RRE requests your chat history only after you have authorized it');
  await expect(page.getByRole('button', { name: 'Save authorization' })).toBeVisible();
  await expect(page.getByTestId('wa-status')).toHaveCount(0);
  status = { ...status, authorization: { send_mode: 'AUTOMATIC', history_months: 3, max_sends_per_day: 10, max_followups_per_contact: 2, spend_limit_usd: 2, reopen_template_text: null } };
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect WhatsApp' })).toBeEnabled();
  expect(await noSideScroll(page)).toBe(true);
});

test('connected: status, history actually received, counts, pause takes effect at once; never "Connected" while syncing', async ({ page }) => {
  status = { ...base, status: 'SYNCING', history: { ...base.history, status: 'RECEIVING', progress: 40 } };
  await setup(page, 'client');
  await page.goto('/app/client/whatsapp');
  await expect(page.getByTestId('wa-status')).toContainText('Connected — importing your recent chats');
  await expect(page.getByTestId('wa-status')).toContainText('arriving (40%)');
  await expect(page.getByRole('button', { name: 'Pause recovery now' })).toHaveCount(0);
  status = { ...base };
  await page.reload();
  await expect(page.getByTestId('wa-status')).toContainText('received — 42 message(s) from 2026-08-10 to 2026-10-25 kept within your chosen period, 7 older discarded');
  await expect(page.getByTestId('wa-status')).toContainText('Follow-ups sent: 1');
  await page.getByRole('button', { name: 'Pause recovery now' }).click();
  await expect(page.getByRole('button', { name: 'Resume recovery' })).toBeVisible();
  expect(calls.find((c) => c.fn === 'client_wa_pause')?.body).toEqual({ p_paused: true });
  expect(await noSideScroll(page)).toBe(true);
});

test('authorization: explicit consent and limits are required before anything is authorized', async ({ page }) => {
  status = { ...base };
  await setup(page, 'client');
  await page.goto('/app/client/whatsapp');
  const save = page.getByRole('button', { name: 'Save authorization' });
  await expect(save).toBeDisabled();
  await page.getByLabel('I authorize RRE to act as described above, within these limits.').check();
  await page.getByLabel('Approved reopening template name (from WhatsApp Manager)').fill('rre_reopen');
  await save.click();
  await expect(page.getByText('Paste the approved template’s exact text.')).toBeVisible();
  expect(calls.some((c) => c.fn === 'client_wa_authorize')).toBe(false);
  await page.getByLabel("The template's exact approved text").fill('Hello from Synthetic Autos A. Are you still interested? Reply STOP to opt out.');
  await save.click();
  await expect.poll(() => calls.find((c) => c.fn === 'client_wa_authorize')?.body).toEqual({ p_terms_version: 'v1', p_history_months: 3, p_send_mode: 'AUTOMATIC',
    p_max_sends_per_day: 10, p_max_followups_per_contact: 2, p_spend_limit_usd: 2, p_reopen_template: 'rre_reopen', p_reopen_template_lang: 'en',
    p_reopen_template_text: 'Hello from Synthetic Autos A. Are you still interested? Reply STOP to opt out.' });
});

test('conversations: permission needs a stated basis; takeover; continue in WhatsApp; no analysis shown', async ({ page }) => {
  status = { ...base };
  await setup(page, 'client');
  await page.goto('/app/client/whatsapp');
  const list = page.getByTestId('wa-contacts');
  await expect(list).toContainText('Permission not recorded — RRE will not message');
  await expect(list).toContainText('you are handling this');
  await expect(list).toContainText('some messages unreadable: no automatic follow-up');
  await page.getByLabel('How +2348000000011 agreed').fill('Asked us to follow up on WhatsApp on 20 Oct.');
  await page.getByRole('button', { name: 'Agreed' }).click();
  await expect.poll(() => calls.find((c) => c.fn === 'client_wa_set_permission')?.body).toEqual({ p_contact_id: 'c1', p_opted_in: true, p_note: 'Asked us to follow up on WhatsApp on 20 Oct.' });
  await page.getByRole('button', { name: 'I’ll handle it' }).click();
  await expect.poll(() => calls.find((c) => c.fn === 'client_wa_takeover')?.body).toEqual({ p_contact_id: 'c1' });
  await expect(list.getByRole('link', { name: 'Open in WhatsApp' }).first()).toHaveAttribute('href', 'https://wa.me/2348000000011');
  await expect(page.locator('body')).not.toContainText(/hypothes|adversarial|forensic|reviewer/i);
  expect(await noSideScroll(page)).toBe(true);
});

test('action required: a plain explanation, nothing sent', async ({ page }) => {
  status = { ...base, status: 'ACTION_REQUIRED', action_code: 'HISTORY_SYNC_META_131000' };
  await setup(page, 'client');
  await page.goto('/app/client/whatsapp');
  await expect(page.getByTestId('wa-action')).toContainText('This number may not be eligible');
  await expect(page.getByTestId('wa-action')).toContainText('2.24.17 or later');
});

test('founder diagnostics: global switch and reconciling an unconfirmed send; a business cannot open it', async ({ page }) => {
  await setup(page, 'founder');
  await page.goto('/app/founder/whatsapp');
  await expect(page.getByTestId('wa-founder')).toContainText('OFF — nothing is sent');
  await page.getByRole('button', { name: 'Turn sending ON' }).click();
  await expect.poll(() => calls.find((c) => c.fn === 'founder_wa_set_sending')?.body).toEqual({ p_enabled: true });
  await page.getByRole('button', { name: 'It was not sent' }).click();
  await expect.poll(() => calls.find((c) => c.fn === 'founder_wa_resolve_unknown')?.body).toEqual({ p_send_id: 'u1', p_was_sent: false, p_wamid: '' });
});

test('a business user cannot open the founder diagnostics', async ({ page }) => {
  await setup(page, 'client');
  await page.goto('/app/founder/whatsapp');
  await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible();
  expect(calls.some((c) => c.fn === 'founder_wa_overview')).toBe(false);
});
