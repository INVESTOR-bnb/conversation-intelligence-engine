// Stage-1 acceptance suite (founder-approved behaviour, baseline 92aa683).
//
// The tests run serially on ONE page because they walk a single demo dataset
// through the full workflow: each step depends on the state the previous one
// left behind. A failure therefore skips the remaining steps.

import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });

let page: Page;
const consoleErrors: string[] = [];
let FX = '';
let SHOT_FILES: string[] = [];
let newCaseHash = '';

const text = (t: string | RegExp) => page.getByText(t).first();
const expectText = (t: string | RegExp) => expect(text(t)).toBeVisible();
const expectNoText = async (t: string) => expect(page.getByText(t)).toHaveCount(0);
const mainText = () => page.locator('main').innerText();
const adminHash = (clientHash: string) => clientHash.replace('#/client/case/', '#/admin/case/');

async function noHorizontalScroll() {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, 'page must not scroll horizontally').toBeLessThanOrEqual(cw);
}

async function asClient(business?: string) {
  await page.getByRole('button', { name: 'Client Demo' }).click();
  if (business) {
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await page.getByLabel('Client Demo views as').selectOption({ label: business });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
}
const asAdmin = () => page.getByRole('button', { name: 'Admin Demo' }).click();
const previewOrder = () => page.locator('.shots img').evaluateAll((els) => els.map((e) => e.getAttribute('alt')));

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  // Synthetic chat-like screenshots (PNG, JPG, WebP) plus one invalid file.
  FX = mkdtempSync(join(tmpdir(), 'rre-fixtures-'));
  const fp = await ctx.newPage();
  const chat = (n: number, lines: [number, string][]) =>
    `<body style="margin:0;width:360px;height:640px;font:16px sans-serif;background:#ece5dd;padding:12px">` +
    `<div style="font:bold 40px sans-serif;margin-bottom:12px">SHOT ${n}</div>` +
    lines.map(([me, t]) => `<div style="margin:8px 0;padding:8px;border-radius:8px;max-width:75%;${me ? 'margin-left:auto;background:#dcf8c6' : 'background:#fff'}">${t}</div>`).join('') +
    `</body>`;
  await fp.setContent(chat(1, [[0, 'Is the Sportage still available?'], [1, 'Yes, ₦21m.']]));
  writeFileSync(join(FX, 'chat-1.png'), await fp.screenshot({ type: 'png' }));
  await fp.setContent(chat(2, [[0, 'Can I pay half now?'], [1, 'Full payment only.']]));
  writeFileSync(join(FX, 'chat-2.jpg'), await fp.screenshot({ type: 'jpeg', quality: 85 }));
  await fp.setContent(chat(3, [[0, 'Ok I will think about it.']]));
  const png3 = (await fp.screenshot({ type: 'png' })).toString('base64');
  const webp = await fp.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.drawImage(img, 0, 0);
    return c.toDataURL('image/webp', 0.9);
  }, png3);
  expect(webp.startsWith('data:image/webp'), 'browser must encode WebP').toBe(true);
  writeFileSync(join(FX, 'chat-3.webp'), Buffer.from(webp.split(',')[1], 'base64'));
  writeFileSync(join(FX, 'notes.txt'), 'not an image');
  await fp.close();
  SHOT_FILES = ['chat-1.png', 'chat-2.jpg', 'chat-3.webp'].map((f) => join(FX, f));

  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./');
});

test.afterAll(async () => {
  await page?.context().close();
});

test('T1 client creates a case from screenshots (select, preview order, remove, submit)', async () => {
  await page.getByRole('button', { name: 'Enter Client Demo' }).click();
  await expectText('Cases Requiring Your Action');
  await page.getByRole('button', { name: 'Add Stalled Prospect' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expectText('Enter the product or service.');
  await page.getByLabel('Product / Service').fill('2020 Kia Sportage');
  await page.getByLabel('Lead Source').selectOption('Referral');
  await page.getByLabel(/Estimated Deal Value/).fill('21000000');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expectText('Upload Conversation Screenshots');
  await expectText('chronological order, oldest messages first');
  await expectText('Please avoid including unnecessary sensitive personal information.');
  await expect(page.getByLabel('Sales conversation'), 'paste textarea is not the default').toHaveCount(0);

  await page.getByRole('button', { name: 'Submit for Review' }).click();
  await expectText('Add at least one screenshot');

  await page.locator('input[type=file]').setInputFiles([...SHOT_FILES, join(FX, 'notes.txt')]);
  await expectText('3 screenshots selected');
  await expectText('notes.txt is not a PNG, JPG or WebP image.');
  expect(await previewOrder()).toEqual(['Screenshot 1: chat-1.png', 'Screenshot 2: chat-2.jpg', 'Screenshot 3: chat-3.webp']);
  await noHorizontalScroll();

  await page.getByRole('button', { name: 'Remove screenshot 2 (chat-2.jpg)' }).click();
  await expectText('2 screenshots selected');
  expect(await previewOrder()).toEqual(['Screenshot 1: chat-1.png', 'Screenshot 2: chat-3.webp']);

  await page.locator('input[type=file]').setInputFiles([join(FX, 'chat-2.jpg')]);
  await expectText('3 screenshots selected');
  expect((await previewOrder())[2]).toBe('Screenshot 3: chat-2.jpg');

  await page.getByRole('button', { name: 'Submit for Review' }).click();
  await expectText('Case Submitted');
  await expectText('You don’t need to take any action yet.');
  await page.getByRole('button', { name: 'View Case' }).click();
  newCaseHash = new URL(page.url()).hash;
  await expectText('No action is required from you yet.');
  await expectNoText('Worth Following Up');
  await expectNoText('Needs Clarification');
  await expect(page.locator('main img'), 'screenshots never shown on the client case screen').toHaveCount(0);
  await expectNoText('chat-1.png');

  await page.getByRole('button', { name: 'Dashboard' }).click();
  await asAdmin();
  await expectText('P-008 — 2020 Kia Sportage');
  await page.goto('./' + adminHash(newCaseHash));
  await expectText('3 screenshots');
  expect(await page.locator('.evidence-head').allInnerTexts()).toEqual([
    'Screenshot 1 of 3 · chat-1.png',
    'Screenshot 2 of 3 · chat-3.webp',
    'Screenshot 3 of 3 · chat-2.jpg',
  ]);
  await page.getByRole('button', { name: 'Run Mock Analysis' }).click();
  await expectText('Their contents were NOT read');
  await noHorizontalScroll();
});

test('S4 client can paste the conversation instead of uploading screenshots', async () => {
  await asClient('Vee Culinary Arts');
  await page.getByRole('button', { name: 'Add Stalled Prospect' }).click();
  await page.getByLabel('Product / Service').fill('Weekend Bread Class');
  await page.getByLabel('Lead Source').selectOption('Referral');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Paste conversation instead' }).click();
  await expectText('Paste the historical sales conversation below');
  await page.getByLabel('Sales conversation').fill('Prospect: How much is the bread class?\nBusiness: ₦40,000 for the weekend.\nProspect: Thanks.');
  await page.getByRole('button', { name: 'Submit for Review' }).click();
  await expectText('Case Submitted');
  await page.getByRole('button', { name: 'View Case' }).click();
  const hash = new URL(page.url()).hash;
  await asAdmin();
  await page.goto('./' + adminHash(hash));
  await expectText('How much is the bread class?');
  await expect(page.locator('.evidence')).toHaveCount(0);
});

test('T11a demo state, including screenshots, persists across refresh', async () => {
  await page.goto('./#/admin');
  await page.reload();
  await expectText('P-008 — 2020 Kia Sportage');
  await page.goto('./' + adminHash(newCaseHash));
  await page.reload();
  await expect(page.locator('.evidence-item img')).toHaveCount(3);
});

const PRIVATE_STRINGS = ['Recovery Score', 'Confidence', 'Forensic', 'Buying Intent', 'Momentum Breakpoint', 'Admin Notes', 'Mock', 'Safety Flags', 'Unknowns', 'Alternative Hypotheses', 'Revisit only if Pasom', 'Softened slightly', 'inspection momentum'];

test('T2a private intelligence is never shown to the client', async () => {
  await asClient('Pasom Autos');
  for (const id of ['case-001', 'case-003', 'case-004', 'case-007']) {
    await page.goto(`./#/client/case/${id}`);
    await page.locator('.status-hero').waitFor();
    const body = await mainText();
    for (const s of PRIVATE_STRINGS) expect(body, `${id} must not contain "${s}"`).not.toContain(s);
  }
  await page.goto('./#/client/case/case-004');
  expect(await mainText(), 'original mock AI wording must not leak').not.toContain('The RX 350 is still here');
  await page.goto('./#/client');
  const dash = await mainText();
  for (const s of PRIVATE_STRINGS) expect(dash).not.toContain(s);
  expect(dash, "another business's case must not be listed").not.toContain('Fashion Design Training');
});

test('T2b admin sees the full private analysis', async () => {
  await asAdmin();
  await page.goto('./#/admin/case/case-001');
  for (const s of ['Recovery Score', 'Confidence', 'Buying Intent', 'Financial Capability', 'Offer Fit', 'Last Strong Buying Signal', 'Momentum Breakpoint', 'Primary Friction', 'Secondary Frictions', 'Stated Objection', 'Underlying Friction Hypothesis', 'Structural Blocker', 'Confirmed Facts', 'Inferences', 'Unknowns', 'Alternative Hypotheses', 'Seller-Side Friction', 'Safety Flags', 'Next Objective', 'Mock Proposed Message', 'Admin Notes']) {
    await expectText(s);
  }
});

const EDITED = 'Good afternoon. The 2018 Camry is still available. Would this Saturday or next suit your mechanic for the inspection? No pressure either way.';

test('T3 approval gate: client sees only the admin-edited message', async () => {
  await asClient('Pasom Autos');
  await page.goto('./#/client/case/case-001');
  await expectText('Under Review');
  await expectNoText('Worth Following Up');
  await asAdmin();
  await page.goto('./#/admin/case/case-001');
  await page.getByLabel('Approved Message').fill(EDITED);
  await page.getByLabel('Admin Notes').fill('Removed video offer — client has no video ready. PRIVATE-NOTE-XYZ');
  await expectText('The client will receive your version only');
  await expect(page.getByRole('button', { name: 'Approve Unchanged' })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit & Approve' }).click();
  await expectText('Edited recommendation approved');
  await asClient('Pasom Autos');
  await page.goto('./#/client/case/case-001');
  await expect(page.getByTestId('approved-message')).toHaveText(EDITED);
  const body = await mainText();
  expect(body).not.toContain('short video of the engine');
  expect(body).not.toContain('PRIVATE-NOTE-XYZ');
});

test('T4 GREEN result with working Copy Message', async () => {
  await expectText('GREEN');
  await expectText('Worth Following Up');
  await expectText('Deal Situation');
  await expectText('What To Do Next');
  await expectText('Recommended Message');
  await page.getByRole('button', { name: 'Copy Message' }).click();
  await expectText('Copied');
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(EDITED);
  await expect(page.getByRole('button', { name: 'I Sent It' })).toBeVisible();
});

const ACTUAL = 'Good afternoon sir. The Camry is still available. Would Saturday suit your mechanic?';

test('T5 sent-message integrity (changed and exact paths)', async () => {
  await page.getByRole('button', { name: 'I Sent It' }).click();
  await expectText('Did you send the message exactly as shown?');
  await page.getByRole('button', { name: 'I Changed It' }).click();
  const confirm = page.getByRole('button', { name: 'Confirm Sent' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Paste the exact message you sent.').fill('   ');
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Paste the exact message you sent.').fill(ACTUAL);
  await confirm.click();
  await expectText('Waiting for Prospect');
  await expectText('No response yet');
  await expectText(ACTUAL);

  await page.goto('./#/client/case/case-004');
  await page.getByRole('button', { name: 'I Sent It' }).click();
  await page.getByRole('button', { name: 'Yes, Exactly' }).click();
  await expectText('Waiting for Prospect');
  await expectText('An evening slot is also possible.');
});

const RESPONSE = 'Sorry for the silence, my mechanic travelled. Can we do Saturday 11am?';

test('T6 response loop: typed response returns to review, next action reaches client', async () => {
  await page.goto('./#/client/case/case-001');
  await page.getByRole('button', { name: 'Add Prospect Response' }).click();
  await page.getByLabel("Paste the prospect's exact response.").fill(RESPONSE);
  await page.getByRole('button', { name: 'Submit Response' }).click();
  await expectText('No action is required from you yet.');

  await asAdmin();
  await expectText('New prospect response');
  await page.goto('./#/admin/case/case-001');
  await expectText(RESPONSE);
  await page.getByRole('button', { name: 'Run Mock Analysis' }).click();
  await expectText('Mock analysis generated');
  const body = (await mainText()).toLowerCase();
  for (const s of [EDITED, ACTUAL, RESPONSE, 'changed by client', 'Mock AI proposed', 'Admin approved', 'Actually sent', 'Let me confirm with my mechanic and get back to you.']) {
    expect(body, `admin review must show: ${s}`).toContain(s.toLowerCase());
  }
  const NEXT = 'Saturday 11am works. We will have the Camry ready at Admiralty Way, Lekki.';
  await page.getByLabel('Approved Message').fill(NEXT);
  await page.locator('label.classify-opt.opt-green').click();
  await page.getByRole('button', { name: 'Edit & Approve' }).click();
  await expectText('Edited recommendation approved');
  await asClient('Pasom Autos');
  await page.goto('./#/client/case/case-001');
  await expect(page.getByTestId('approved-message')).toHaveText(NEXT);
});

test('T7 YELLOW result shows clarification without unsupported objections', async () => {
  await asClient('Fineez Designs Academy');
  await page.goto('./#/client/case/case-002');
  await expectText('YELLOW');
  await expectText('Needs Clarification');
  await expectText("There isn't enough information yet");
  await expectText('Send this short message to clarify');
  const body = (await mainText()).toLowerCase();
  for (const bad of ['afford', 'price objection', 'too expensive', 'overload']) expect(body).not.toContain(bad);
});

test('T8 RED result has no message and no I Sent It (seeded and admin Mark Red)', async () => {
  await asClient('Pasom Autos');
  await page.goto('./#/client/case/case-003');
  await expectText('RED');
  await expectText('Do Not Follow Up');
  await expectText('No further contact is recommended.');
  await expect(page.getByRole('button', { name: 'I Sent It' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy Message' })).toHaveCount(0);
  await expect(page.locator('.message-card')).toHaveCount(0);

  await asAdmin();
  await page.goto('./' + adminHash(newCaseHash));
  await page.getByRole('button', { name: 'Mark Red' }).click();
  await page.getByRole('button', { name: 'Mark Red' }).last().click();
  await expectText('Marked RED');
  await asClient('Pasom Autos');
  await page.goto('./' + newCaseHash);
  await expectText('Do Not Follow Up');
  await expect(page.getByRole('button', { name: 'I Sent It' })).toHaveCount(0);
});

test('T9 WON requires explicit confirmation; LOST requires confirmation', async () => {
  await page.goto('./#/client/case/case-004');
  await page.getByRole('button', { name: 'Record Outcome' }).click();
  await page.getByRole('button', { name: 'Mark Deal Won' }).click();
  await expectText('Has this prospect actually completed the agreed purchase, registration, or payment event?');
  await expect(page.getByRole('button', { name: 'Confirm Won' })).toHaveCount(0);
  await page.getByLabel('No, not yet').check();
  await expectText('Only mark a deal won once');
  await expect(page.getByRole('button', { name: 'Confirm Won' })).toHaveCount(0);
  await page.getByLabel('Yes, it is completed').check();
  await page.getByRole('button', { name: 'Confirm Won' }).click();
  await expectText('Enter the amount actually paid.');
  await page.getByLabel(/Deal Value/).fill('24000000');
  await page.getByLabel(/Amount Paid/).fill('23500000');
  await page.getByLabel('Payment Date').fill('2026-10-07');
  await page.getByRole('button', { name: 'Confirm Won' }).click();
  await expectText('Recovered Payment');
  await expectText('Recovery Attempts');
  await expectText('Completion Date');
  await expectText('7 Oct 2026');

  await asClient('Vee Culinary Arts');
  await page.goto('./#/client/case/case-006');
  await page.getByRole('button', { name: 'Record Outcome' }).click();
  await page.getByRole('button', { name: 'Mark Lost' }).click();
  await expectText('Close this case as lost?');
  await page.getByRole('button', { name: 'Mark Lost' }).last().click();
  await expectText('Closed — Lost');
});

test('T10 390px layout: no horizontal scroll, touch targets ≥ 36px', async () => {
  await asClient('Pasom Autos');
  for (const r of ['#/login', '#/client', '#/client/new', '#/client/case/case-001', '#/client/case/case-003', '#/client/case/case-004', '#/admin', '#/admin/clients', '#/admin/clients/new', '#/admin/case/case-005', '#/admin/case/case-002', '#/admin/case/case-007']) {
    await page.goto('./' + r);
    await page.locator('main').waitFor();
    await noHorizontalScroll();
  }
  await page.goto('./#/admin');
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height < 36 && (b as HTMLElement).offsetParent).map((b) => b.textContent),
  );
  expect(small).toEqual([]);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await noHorizontalScroll();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
});

test('Admin can approve unchanged and add a client (with validation)', async () => {
  await asAdmin();
  await page.goto('./#/admin/case/case-005');
  await page.getByRole('button', { name: 'Approve Unchanged' }).click();
  await expectText('Approved unchanged');
  await page.goto('./#/admin/clients/new');
  await page.getByLabel('Business Name').fill('Test Bakery');
  await page.getByLabel('Industry').fill('Bakery');
  await page.getByLabel('Client User Name').fill('Test User');
  await page.getByLabel('Client User Email').fill('nope');
  await page.getByRole('button', { name: 'Add Client' }).click();
  await expectText('Enter a valid email address.');
  await page.getByLabel('Client User Email').fill('test@bakery.example');
  await page.getByRole('button', { name: 'Add Client' }).click();
  await expectText('Test Bakery');
});

test('T11b Reset Demo Data restores the seed cases', async () => {
  await page.reload();
  await expectText('Test Bakery');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('button', { name: 'Reset Demo Data' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.goto('./#/admin');
  await expectText('P-001 — 2018 Toyota Camry');
  await expectNoText('Kia Sportage');
  await page.goto('./#/admin/clients');
  await expectNoText('Test Bakery');
});

test('Admin request reanalysis re-issues the analysis as a new version', async () => {
  await page.goto('./#/admin/case/case-001');
  await page.getByRole('button', { name: 'Request Reanalysis' }).click();
  await expectText('Reanalysis requested');
  await page.getByRole('button', { name: 'Run Mock Analysis' }).click();
  await expectText('no new information since the previous analysis');
  await expectText('v2');
});

test('Desktop 1280px admin review renders without horizontal scroll', async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('./#/admin/case/case-001');
  await noHorizontalScroll();
  await page.setViewportSize({ width: 390, height: 844 });
});

test('No console errors during the whole run', async () => {
  expect(consoleErrors).toEqual([]);
});
