// Stage 2A-5c in the browser (mocked Supabase; see mockSupabase.ts): the
// founder-only analysis workspace on the founder case page. Database
// enforcement (analyses and restrictions are founder-only) is tested in
// supabase/tests/13_analysis_workspace_access.test.sql and earlier files.

import { expect, test, type Page } from '@playwright/test';
import { messageId, MockSupabase, USERS } from './mockSupabase';
import { analysisRow, insufficientOutput, MSG, reviewedOutput, richOutput } from './analysisFixtures';

let mock: MockSupabase;
const CASE = 'a0000000-0000-4000-8000-000000000101';

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

async function openCase(page: Page, id = CASE) {
  await login(page, 'founder');
  await page.goto(`/app/founder/case/${id}`);
  await expect(page.getByTestId('founder-analysis')).toBeVisible();
  return page.getByTestId('founder-analysis');
}

const ready = () => analysisRow(CASE, { output: richOutput(messageId(CASE)) });

test('a ready analysis: observations and hypotheses are separate, every section is shown', async ({ page }) => {
  mock.analyses = [ready()];
  const a = await openCase(page);
  await expect(a.getByTestId('analysis-state')).toHaveAttribute('data-state', 'READY');
  await expect(a.getByText('Founder only. This analysis is never shown to the business.')).toBeVisible();

  const obs = a.getByTestId('observations');
  await expect(obs.getByTestId('observation')).toHaveCount(2);
  await expect(obs).toContainText('Asked whether the Camry is available.');
  await expect(obs).toContainText('Pasted conversation: “Is the Camry available?”');
  await expect(obs).not.toContainText('Interested in this specific car.');

  const hyp = a.getByTestId('hypotheses');
  await expect(hyp.getByTestId('hypothesis')).toHaveCount(4);
  await expect(hyp.locator('[data-basis="STATED_BY_PROSPECT"]')).toContainText('Stated by prospect');
  await expect(hyp.locator('[data-basis="HYPOTHESIS"]').first()).toContainText('Hypothesis — interpretation, not fact');
  await expect(hyp.getByTestId('category-TRUST_AND_RISK')).toContainText('Unsure whether the listing is genuine.');
  await expect(hyp.getByTestId('category-BUYING_MOTIVATION')).toContainText('Confidence: MEDIUM');
  await expect(hyp.getByTestId('category-DECISION_FRICTION')).toContainText('Contradicted by O2');
  await expect(hyp.getByTestId('category-SELLER_CREATED_RESISTANCE')).toContainText('Competes with H2');
  await expect(hyp.getByTestId('category-EMOTIONAL_BARRIER')).toContainText('Not supported by the evidence in this analysis.');

  await expect(a.getByTestId('unknowns')).toContainText('Is the prospect still looking?');
  await expect(a.getByTestId('missing-evidence')).toContainText('What the prospect compared it with');
  await expect(a.getByTestId('challenges').locator('[data-kind="CONTRADICTION"]')).toContainText('H4');
  await expect(a.getByTestId('challenges').locator('[data-kind="COMPETING"]')).toHaveCount(4);

  const rec = a.getByTestId('recommendation');
  await expect(rec).toContainText('Pursue recovery');
  await expect(rec).toContainText('Offer a specific viewing time with no pressure.');
  await expect(rec).toContainText('Turns stated interest into a low-effort next step.');
  await expect(rec).toContainText(`Message (draft): ${MSG}`);
  await expect(a.getByTestId('proposed-message')).toContainText('Draft for your review — not sent');
});

test('nothing on the workspace can send a message', async ({ page }) => {
  mock.analyses = [ready()];
  const a = await openCase(page);
  await expect(a.getByTestId('proposed-message')).toBeVisible();
  await expect(page.getByRole('button', { name: /send|approve|publish|copy/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /send|whatsapp/i })).toHaveCount(0);
  // Only reads happen: no RPC or write is issued by opening the analysis.
  expect(mock.requests.filter((r) => r.includes('/rest/v1/rpc/') && !r.includes('/rpc/whoami'))).toEqual([]);
  expect(mock.requests.filter((r) => /^(POST|PATCH|PUT|DELETE) \/rest\/v1\/(analyses|contact_restrictions|approvals)/.test(r))).toEqual([]);
});

test('a stale analysis is marked, kept for reference, and its message withheld', async ({ page }) => {
  mock.analyses = [ready()];
  mock.cases[0].evidence_version = 2; // evidence changed after the analysis
  const a = await openCase(page);
  await expect(a.getByTestId('analysis-state')).toHaveAttribute('data-state', 'STALE');
  await expect(a.getByText('Stale — evidence changed')).toBeVisible();
  await expect(a.getByTestId('analysis-state')).toContainText('evidence version 1 (case is at 2)');
  await expect(a.getByTestId('proposed-message')).toHaveCount(0);
  await expect(a.getByTestId('message-withheld')).toContainText('not current');
});

test('a rejected analysis shows why and no findings', async ({ page }) => {
  mock.analyses = [ready(), analysisRow(CASE, { version: 2, status: 'ERROR', output: null, ai_classification: null, ai_proposed_message: null,
    error: 'REJECTED by analysis contract rre-analysis/1: observations[0].evidence[0]: quote does not appear in the cited message' })];
  const a = await openCase(page);
  await expect(a.getByTestId('analysis-state')).toHaveAttribute('data-state', 'REJECTED');
  await expect(a.getByTestId('analysis-error')).toContainText('quote does not appear in the cited message');
  await expect(a.getByTestId('observations')).toHaveCount(0);
  await expect(a.getByTestId('hypotheses')).toHaveCount(0);
  await expect(a.getByTestId('proposed-message')).toHaveCount(0);
});

test('insufficient evidence shows what is missing and no interpretations or message', async ({ page }) => {
  mock.analyses = [analysisRow(CASE, { status: 'INSUFFICIENT_EVIDENCE', output: insufficientOutput(), ai_classification: null, ai_proposed_message: null,
    evidence_manifest: { manifest_version: 2, screenshots: [], excluded_screenshots: [{ position: 2, reason: 'FILE_DELETED' }], messages: [] } })];
  const a = await openCase(page);
  await expect(a.getByTestId('analysis-state')).toHaveAttribute('data-state', 'INSUFFICIENT');
  await expect(a.getByTestId('missing-evidence')).toContainText('The rest of the conversation');
  await expect(a.getByTestId('unknowns')).toContainText('What happened after the price was given?');
  await expect(a.getByText('No interpretations were made.')).toBeVisible();
  await expect(a.getByTestId('hypothesis')).toHaveCount(0);
  await expect(a.getByTestId('recommendation')).toContainText('Unknown — not enough to decide');
  await expect(a.getByTestId('proposed-message')).toHaveCount(0);
  await expect(a.getByTestId('excluded-screenshots')).toContainText('screenshot 2 (file deleted under retention)');
});

test('an active contact restriction is shown first and withholds the message', async ({ page }) => {
  mock.analyses = [ready()];
  mock.restrictions = [{ id: 'r1', case_id: CASE, kind: 'EXPLICIT_OPT_OUT', source: 'AI_DETECTED', status: 'ACTIVE',
    note: 'Detected by analysis v1, which was not accepted. Synthetic opt-out.', created_at: '2026-10-12T10:00:00Z' }];
  const a = await openCase(page);
  await expect(a.getByTestId('active-restrictions')).toContainText('EXPLICIT_OPT_OUT');
  await expect(a.getByText('Contact restricted — do not contact')).toBeVisible();
  await expect(a.getByTestId('proposed-message')).toHaveCount(0);
  await expect(a.getByTestId('message-withheld')).toContainText('active contact restriction');
  await expect(a.getByTestId('challenges').locator('[data-kind="RESTRICTION"]')).toBeVisible();
});

test('in progress and none: nothing is shown as findings', async ({ page }) => {
  mock.analyses = [analysisRow(CASE, { status: 'PENDING', output: null, completed_at: null })];
  let a = await openCase(page);
  await expect(a.getByTestId('analysis-state')).toHaveAttribute('data-state', 'IN_PROGRESS');
  await expect(a.getByTestId('observations')).toHaveCount(0);
  mock.analyses = [];
  await page.reload();
  a = page.getByTestId('founder-analysis');
  await expect(a.getByTestId('analysis-state')).toHaveAttribute('data-state', 'NONE');
  await expect(a.getByText('No analysis has been run for this case.')).toBeVisible();
});

test('analysis text is rendered as plain text, never as HTML', async ({ page }) => {
  const out = richOutput(messageId(CASE));
  out.hypotheses[0].statement = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  out.recommendation.strategy = '<b>bold?</b>';
  mock.analyses = [analysisRow(CASE, { output: out })];
  const a = await openCase(page);
  await expect(a.getByTestId('hypotheses')).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(a.getByTestId('recommendation')).toContainText('<b>bold?</b>');
  await expect(a.locator('img, script, b')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('a business user never receives analysis data, through the UI or a direct API call', async ({ page }) => {
  mock.analyses = [ready()];
  mock.restrictions = [{ id: 'r1', case_id: CASE, kind: 'EXPLICIT_OPT_OUT', source: 'AI_DETECTED', status: 'ACTIVE', note: 'synthetic', created_at: '' }];
  await login(page, 'client');
  await expect(page).toHaveURL(/\/app\/client$/);
  await expect(page.getByTestId('client-cases')).toBeVisible();
  await page.goto(`/app/founder/case/${CASE}`);
  await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible();
  expect(mock.requests.filter((r) => r.includes('/rest/v1/analyses') || r.includes('/rest/v1/contact_restrictions'))).toEqual([]);
  await expect(page.locator('body')).not.toContainText(/Offer a specific viewing|Interested in this specific car|EXPLICIT_OPT_OUT|hypothes/i);

  // Even calling the Data API directly with the client's own session returns nothing (RLS; mirrored by the mock).
  const res = await page.evaluate(async ({ url, key }) => {
    const session = JSON.parse(localStorage.getItem('rre-auth') ?? '{}');
    const get = (t: string) => fetch(`${url}/rest/v1/${t}?select=*`, { headers: { apikey: key, authorization: `Bearer ${session.access_token}` } }).then((r) => r.json());
    return { analyses: await get('analyses'), restrictions: await get('contact_restrictions') };
  }, { url: 'https://mock-project-ref.supabase.co', key: 'sb_publishable_TEST_ONLY_not_a_real_key' });
  expect(res).toEqual({ analyses: [], restrictions: [] });
});

// ---------------------------------------------------------------- Stage 2A-5d-2: independent review

test('an rre-analysis/2 analysis shows the independent review: verdict, challenges by severity, verified evidence', async ({ page }) => {
  mock.analyses = [analysisRow(CASE, { output: reviewedOutput(messageId(CASE), 'UPHOLD_WITH_CONCERNS') })];
  const a = await openCase(page);
  const review = a.getByTestId('independent-review');
  await expect(review.getByTestId('review-verdict')).toHaveAttribute('data-verdict', 'UPHOLD_WITH_CONCERNS');
  await expect(review.getByTestId('review-verdict')).toHaveText('Upheld with concerns');
  await expect(review.getByTestId('review-rationale')).toHaveText('The recommendation holds, with caveats.');
  const items = review.getByTestId('review-challenge');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute('data-severity', 'MEDIUM');
  await expect(items.nth(0)).toContainText('Hypothesis H1');
  await expect(items.nth(0)).toContainText('Pasted conversation: “Is the Camry available?”');
  await expect(items.nth(1)).toContainText('Recommendation');
  await expect(a.getByTestId('proposed-message')).toContainText(MSG);
  await expect(a.getByTestId('review-none')).toHaveCount(0);
});

test('a review that rejects the recommendation: no draft message anywhere, shown as rejected', async ({ page }) => {
  mock.analyses = [analysisRow(CASE, { output: reviewedOutput(messageId(CASE), 'REJECT_RECOMMENDATION'), ai_classification: null, ai_proposed_message: null })];
  const a = await openCase(page);
  await expect(a.getByTestId('review-verdict')).toHaveText('Recommendation rejected');
  await expect(a.getByTestId('review-challenge').first()).toHaveAttribute('data-severity', 'HIGH');
  await expect(a.getByTestId('recommendation')).toContainText('Unknown — not enough to decide');
  await expect(a.getByTestId('proposed-message')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(MSG);
});

test('an rre-analysis/1 analysis says it has no independent review', async ({ page }) => {
  mock.analyses = [ready()];
  const a = await openCase(page);
  await expect(a.getByTestId('review-none')).toContainText('No independent review');
  await expect(a.getByTestId('independent-review')).toHaveCount(0);
});

test('review text is rendered as plain text', async ({ page }) => {
  const out = reviewedOutput(messageId(CASE));
  out.adversarial_review.challenges[0].challenge = '<img src=x onerror="window.__xss=1">';
  out.adversarial_review.verdict_rationale = '<script>window.__xss=2</script>';
  mock.analyses = [analysisRow(CASE, { output: out })];
  const a = await openCase(page);
  await expect(a.getByTestId('independent-review')).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(a.locator('img, script')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('a business user never receives the review, through the UI or a direct API call', async ({ page }) => {
  mock.analyses = [analysisRow(CASE, { output: reviewedOutput(messageId(CASE), 'REJECT_RECOMMENDATION') })];
  await login(page, 'client');
  await page.goto(`/app/founder/case/${CASE}`);
  await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/Independent review|premature|casual browsing|adversarial/i);
  expect(mock.requests.filter((r) => r.includes('/rest/v1/analyses'))).toEqual([]);
  const res = await page.evaluate(async ({ url, key }) => {
    const session = JSON.parse(localStorage.getItem('rre-auth') ?? '{}');
    return fetch(`${url}/rest/v1/analyses?select=output`, { headers: { apikey: key, authorization: `Bearer ${session.access_token}` } }).then((r) => r.json());
  }, { url: 'https://mock-project-ref.supabase.co', key: 'sb_publishable_TEST_ONLY_not_a_real_key' });
  expect(res).toEqual([]);
});
