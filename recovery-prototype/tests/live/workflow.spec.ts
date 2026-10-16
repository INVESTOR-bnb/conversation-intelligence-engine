// V0 commercial workflow in the browser (mocked Supabase with the database functions' rules; see
// mockSupabase.ts): founder runs the analysis → decides → the business sees ONLY the approved
// message → sends it themselves → records the reply and the outcome → the founder sees it all.
// Synthetic data only. Database enforcement of the same rules is tested in supabase/tests/*.sql.

import { expect, test, type Page } from '@playwright/test';
import { messageId, MockSupabase, USERS } from './mockSupabase';
import { analysisRow, MSG, reviewedOutput } from './analysisFixtures';

let mock: MockSupabase;
const CASE = 'a0000000-0000-4000-8000-000000000101'; // P-101, business B1 (the test client's), SUBMITTED
const OTHER = 'a0000000-0000-4000-8000-000000000201'; // C-201, business B2

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
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
}
const caseState = (id = CASE) => mock.cases.find((c) => c.id === id)!.workflow_state;
/** Puts P-101 where the founder has just reviewed a current analysis. */
function awaitingReview(over: Record<string, unknown> = {}) {
  const c = mock.cases.find((x) => x.id === CASE)!;
  c.workflow_state = 'AWAITING_ADMIN_REVIEW';
  mock.analyses = [analysisRow(CASE, { output: reviewedOutput(messageId(CASE)), ai_classification: 'YELLOW', evidence_version: c.evidence_version, ...over })];
}
async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

// ---------------------------------------------------------------- the whole loop

test('V0 loop: run analysis → approve (edited) → business sends → prospect replies → founder sees it; nothing private reaches the business', async ({ page }) => {
  // 1. Founder runs the analysis from the case page, with their own session.
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${CASE}`);
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await expect(page.getByText('Run one analysis of this case?')).toBeVisible();
  await page.getByRole('button', { name: 'Run analysis' }).last().click();
  await expect(page.getByTestId('run-analysis-result')).toHaveText('Analysis complete. Review it below before any decision.');
  expect(mock.functionCalls).toHaveLength(1);
  expect(mock.tokens.get(mock.functionCalls[0])).toBe(USERS.founder.id);
  await expect(page.getByTestId('analysis-state')).toHaveAttribute('data-state', 'READY');
  await expect(page.getByTestId('independent-review')).toBeVisible();

  // 2. Founder edits and approves; the preview is exactly what the business will see.
  const decision = page.getByTestId('founder-decision');
  await expect(decision.getByLabel('Message the business will send')).toHaveValue(MSG);
  await decision.getByLabel('Message the business will send').fill('Hello again — would Saturday at 10 suit you to see the car?');
  await decision.getByLabel('Situation (shown to the business)').fill('The prospect asked for a viewing that was never confirmed.');
  await decision.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('decision-preview')).toContainText('Hello again — would Saturday at 10 suit you to see the car?');
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByTestId('released')).toContainText('Hello again');
  expect(mock.recommendations.get(CASE)).toMatchObject({ classification: 'YELLOW', approval_type: 'EDITED', approved_message: 'Hello again — would Saturday at 10 suit you to see the car?' });
  expect(caseState()).toBe('CLIENT_ACTION_REQUIRED');
  await noHorizontalScroll(page);
  await signOut(page);

  // 3. The business sees only the approved recommendation.
  await login(page, 'client');
  await page.getByTestId('client-cases').getByRole('button', { name: 'Open' }).first().click();
  await page.waitForURL(`**/app/client/case/${CASE}`);
  const rec = page.getByTestId('client-recommendation');
  await expect(rec).toContainText('YELLOW');
  await expect(rec).toContainText('The prospect asked for a viewing that was never confirmed.');
  await expect(page.getByTestId('approved-message')).toHaveText('Hello again — would Saturday at 10 suit you to see the car?');
  await expect(page.getByRole('link', { name: 'Open in WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=Hello%20again/);
  const body = await page.locator('body').innerText();
  for (const secret of ['Interested in this specific car', 'Availability questions are often casual', 'The recommendation holds', 'Hypothes', 'hypothes', 'Observation', 'review', MSG]) {
    expect(body, `the business must not see: ${secret}`).not.toContain(secret);
  }
  await noHorizontalScroll(page);

  // 4. The business sends it themselves, then records the prospect's reply.
  await page.getByRole('button', { name: 'I sent it' }).click();
  await page.getByRole('button', { name: 'Yes, I sent it' }).click();
  await expect(page.getByTestId('client-notice')).toContainText('Recorded as sent');
  expect(caseState()).toBe('WAITING_FOR_PROSPECT');
  await page.getByRole('button', { name: 'The prospect replied' }).click();
  await page.getByLabel('Paste the prospect’s reply').fill('Saturday works. See you at 10.');
  await page.getByRole('button', { name: 'Add reply' }).click();
  await expect(page.getByTestId('client-notice')).toContainText('Reply added');
  expect(caseState()).toBe('PROSPECT_REPLIED');
  await expect(page.getByTestId('client-history')).toContainText('Prospect response added — under review');
  await signOut(page);

  // 5. The founder sees what was sent and the reply, and can analyse again.
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${CASE}`);
  await expect(page.getByTestId('timeline-sent')).toContainText('Hello again');
  await expect(page.getByTestId('timeline-reply')).toContainText('Saturday works. See you at 10.');
  await expect(page.getByRole('button', { name: 'Run analysis' })).toBeVisible();
});

test('an unchanged approval is recorded as UNCHANGED', async ({ page }) => {
  awaitingReview();
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${CASE}`);
  await page.getByTestId('founder-decision').getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByTestId('released')).toBeVisible();
  expect(mock.recommendations.get(CASE)).toMatchObject({ classification: 'YELLOW', approval_type: 'UNCHANGED', approved_message: MSG });
});

test('outcome: a WON outcome needs the amount and date; the business sees it closed; the founder sees the outcome', async ({ page }) => {
  awaitingReview();
  mock.cases.find((x) => x.id === CASE)!.workflow_state = 'CLIENT_ACTION_REQUIRED';
  mock.recommendations.set(CASE, { classification: 'GREEN', deal_situation: 'Worth one follow-up.', next_action: 'Send it once.', approved_message: MSG, published_at: '2026-10-12T10:00:00Z', approval_type: 'UNCHANGED' });
  await login(page, 'client');
  await page.goto(`/app/client/case/${CASE}`);
  await page.getByRole('button', { name: 'Record the outcome' }).click();
  await page.getByLabel('What happened?').selectOption('WON');
  await page.getByRole('button', { name: 'Save outcome' }).click();
  await expect(page.getByText('Enter the amount paid, in numbers only.')).toBeVisible();
  await expect(page.getByText('Choose the payment date.')).toBeVisible();
  expect(mock.outcomes.size).toBe(0);
  await page.getByLabel('Amount paid (NGN)').fill('9500');
  await page.getByLabel('Payment date').fill('2026-10-10');
  await page.getByRole('button', { name: 'Save outcome' }).click();
  await expect(page.getByTestId('client-outcome')).toContainText('Won');
  expect(mock.outcomes.get(CASE)).toMatchObject({ state: 'WON', amount_paid: 9500, payment_date: '2026-10-10', recorded_by_role: 'CLIENT' });
  await signOut(page);
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${CASE}`);
  await expect(page.getByTestId('timeline-outcome')).toContainText('Outcome: WON');
  await expect(page.getByTestId('timeline-outcome')).toContainText('reported by the business');
});

test('a restricted case: only RED is possible; the business gets no message and cannot mark it sent', async ({ page }) => {
  awaitingReview();
  mock.restrictions = [{ id: 'r1', case_id: CASE, kind: 'EXPLICIT_OPT_OUT', source: 'CLIENT', status: 'ACTIVE', note: null, created_at: '2026-10-12T09:00:00Z' }];
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${CASE}`);
  const d = page.getByTestId('founder-decision');
  await expect(d.getByRole('radio', { name: /GREEN/ })).toBeDisabled();
  await expect(d.getByRole('radio', { name: /RED/ })).toBeChecked();
  await expect(d.getByLabel('Message the business will send')).toHaveCount(0);
  await d.getByRole('button', { name: 'Mark RED' }).click();
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByTestId('released')).toContainText('RED');
  expect(mock.recommendations.get(CASE)).toMatchObject({ classification: 'RED', approved_message: null, approval_type: 'MARKED_RED' });
  await signOut(page);
  await login(page, 'client');
  await page.goto(`/app/client/case/${CASE}`);
  await expect(page.getByTestId('client-recommendation')).toContainText('Further contact with this prospect is not recommended.');
  await expect(page.getByTestId('approved-message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'I sent it' })).toHaveCount(0);
});

test('the database refusal is shown plainly: a stale analysis cannot be approved', async ({ page }) => {
  awaitingReview();
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${CASE}`);
  await expect(page.getByTestId('founder-decision').getByRole('button', { name: 'Approve' })).toBeVisible();
  mock.cases.find((x) => x.id === CASE)!.evidence_version += 1; // evidence changed after the page loaded
  await page.getByTestId('founder-decision').getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByText('The evidence or analysis changed while you were reviewing. Reload and review the latest analysis.')).toBeVisible();
  expect(mock.recommendations.size).toBe(0);
});

test('running an analysis while spending is off, or offline: a clear message, nothing changes', async ({ page }) => {
  mock.analyzeMode = 'SPENDING_DISABLED';
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${CASE}`);
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await page.getByRole('button', { name: 'Run analysis' }).last().click();
  await expect(page.getByTestId('run-analysis-result')).toContainText('AI spending is switched off, so no analysis was started.');
  expect(mock.analyses).toHaveLength(0);
  expect(caseState()).toBe('SUBMITTED');
  mock.analyzeMode = 'network';
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await page.getByRole('button', { name: 'Run analysis' }).last().click();
  await expect(page.getByTestId('run-analysis-result')).toContainText('Could not reach the analysis service');
});

test('request re-analysis from the decision card', async ({ page }) => {
  awaitingReview();
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${CASE}`);
  await page.getByTestId('founder-decision').getByRole('button', { name: 'Request re-analysis' }).click();
  await expect(page.getByRole('button', { name: 'Run analysis' })).toBeVisible();
  expect(caseState()).toBe('REANALYZING');
});

test('the business can report an opt-out; no further message is offered', async ({ page }) => {
  mock.cases.find((x) => x.id === CASE)!.workflow_state = 'CLIENT_ACTION_REQUIRED';
  mock.recommendations.set(CASE, { classification: 'GREEN', deal_situation: 'Worth one follow-up.', next_action: 'Send it once.', approved_message: MSG, published_at: '2026-10-12T10:00:00Z', approval_type: 'UNCHANGED' });
  await login(page, 'client');
  await page.goto(`/app/client/case/${CASE}`);
  await page.getByRole('button', { name: 'The prospect asked not to be contacted' }).click();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByTestId('client-notice')).toContainText('No further messages will be recommended');
  expect(mock.restrictions.some((r) => r.case_id === CASE && r.source === 'CLIENT' && r.status === 'ACTIVE')).toBe(true);
  await expect(page.getByTestId('approved-message')).toHaveCount(0);
});

test('access: a business cannot open another business’s case, nor the founder page; the founder actions are founder-only', async ({ page }) => {
  await login(page, 'client');
  await page.goto(`/app/client/case/${OTHER}`);
  await expect(page.getByText('Case not found.')).toBeVisible();
  await page.goto(`/app/founder/case/${CASE}`);
  await expect(page.getByTestId('founder-analysis')).toHaveCount(0);
  // Direct calls with the business's own session are refused by the server, whatever the UI shows.
  const token = [...mock.tokens].find(([, id]) => id === USERS.client.id)![0];
  const call = (path: string, data: object) => page.evaluate(async ([p, d, t]) => (await fetch(`https://mock-project-ref.supabase.co${p}`, {
    method: 'POST', headers: { apikey: 'sb_publishable_TEST_ONLY_not_a_real_key', authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(d) })).status,
  [path, data, token] as const);
  expect(await call('/functions/v1/analyze-case', { case_id: CASE })).toBe(403);
  expect(await call('/rest/v1/rpc/founder_approve', { p_case_id: CASE })).toBe(403);
});
