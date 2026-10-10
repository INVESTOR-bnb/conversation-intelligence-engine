// Stage 2A-4c in the browser (mocked Supabase Storage; see mockSupabase.ts).
// Proves the client flow: processing (metadata removed), ordering, upload,
// recovery from failed/lost requests, resume after reload, conflicts, and the
// founder viewer. Database/storage authorization is tested in
// supabase/tests/09_screenshots.test.sql; real Storage only on staging.

import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { B1, MockSupabase, USERS } from './mockSupabase';
import { SHOT_MESSAGES } from '../../src/live/screenshots';

let mock: MockSupabase;
type Fixture = { name: string; mimeType: string; buffer: Buffer };
let fx: Record<'png1' | 'png2' | 'jpegExif' | 'noisy' | 'wide' | 'fake' | 'gif', Fixture>;

test.beforeEach(async ({ context, browser }) => {
  mock = new MockSupabase();
  await mock.install(context);
  if (!fx) fx = await makeFixtures(browser);
});

async function makeFixtures(browser: import('@playwright/test').Browser) {
  const page = await browser.newPage();
  const draw = (w: number, h: number, text: string, type: string, noise = false) => page.evaluate(async ({ w, h, text, type, noise }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    if (noise) {
      const d = x.createImageData(w, h);
      for (let i = 0; i < d.data.length; i++) d.data[i] = (Math.random() * 256) | 0;
      for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255;
      x.putImageData(d, 0, 0);
    } else {
      x.fillStyle = '#e5ddd5'; x.fillRect(0, 0, w, h); x.fillStyle = '#000'; x.font = '28px sans-serif'; x.fillText(text, 20, 60);
    }
    const b: Blob = await new Promise((r) => c.toBlob((bb) => r(bb!), type, 0.9));
    const url: string = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(b); });
    return url.slice(url.indexOf(',') + 1);
  }, { w, h, text, type, noise });
  const png1 = Buffer.from(await draw(540, 1200, 'Prospect: synthetic hello (1)', 'image/png'), 'base64');
  const png2 = Buffer.from(await draw(540, 1200, 'Business: synthetic reply (2)', 'image/png'), 'base64');
  const jpeg = Buffer.from(await draw(540, 1200, 'Prospect: synthetic photo (3)', 'image/jpeg'), 'base64');
  const noisy = Buffer.from(await draw(1400, 1400, '', 'image/png', true), 'base64');
  const wide = Buffer.from(await draw(5000, 20, 'wide', 'image/png'), 'base64');
  await page.close();
  // Insert an APP1 "Exif" segment with a fake GPS marker right after the JPEG SOI.
  const payload = Buffer.from('Exif\0\0SYNTHETIC-GPS-6.5244N-3.3792E', 'latin1');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  const jpegExif = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
  return {
    png1: { name: 'chat-1.png', mimeType: 'image/png', buffer: png1 },
    png2: { name: 'chat-2.png', mimeType: 'image/png', buffer: png2 },
    jpegExif: { name: 'photo-with-location.jpg', mimeType: 'image/jpeg', buffer: jpegExif },
    noisy: { name: 'huge.png', mimeType: 'image/png', buffer: noisy },
    wide: { name: 'too-wide.png', mimeType: 'image/png', buffer: wide },
    fake: { name: 'not-really.png', mimeType: 'image/png', buffer: Buffer.from('<html><script>alert(1)</script></html>') },
    gif: { name: 'anim.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1') },
  };
}

async function login(page: Page, who: keyof typeof USERS) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(USERS[who].email);
  await page.getByLabel('Password').fill(USERS[who].password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

const form = (page: Page) => page.locator('form', { has: page.getByRole('heading', { name: 'New case' }) });

async function startScreenshotCase(page: Page, ref: string, files: Fixture[]) {
  await login(page, 'client');
  await expect(page.getByTestId('client-cases')).toBeVisible();
  const f = form(page);
  await f.getByLabel('Reference').fill(ref);
  await f.getByLabel('Product or service').fill('Synthetic Corolla');
  await f.getByLabel('Lead source').selectOption('Referral');
  await f.getByRole('button', { name: 'Upload screenshots' }).click();
  await f.getByTestId('shots-input').setInputFiles(files);
  await expect(f.getByText(`${files.length} screenshot${files.length === 1 ? '' : 's'} selected`)).toBeVisible();
  return f;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const filesOf = (caseRef: string) => {
  const c = mock.cases.find((x) => x.reference === caseRef)!;
  return [...mock.objects.entries()].filter(([k]) => k.includes(`/${c.id}/`)).sort(([a], [b]) => a.localeCompare(b));
};

test.describe('client uploads screenshots', () => {
  test('processed (metadata removed), reordered, uploaded to the right paths, recorded and submitted', async ({ page }) => {
    const f = await startScreenshotCase(page, 'SHOT-001', [fx.png1, fx.jpegExif]);
    await f.getByRole('button', { name: 'Move screenshot 2 earlier' }).click();
    await expect(f.getByTestId('shots-list').locator('.shot-name').first()).toHaveText('photo-with-location.jpg');
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('status')).toHaveText('Case SHOT-001 submitted for review with 2 screenshots.');
    const files = filesOf('SHOT-001');
    expect(files.map(([k]) => k.split('/').pop()!.replace(/-[0-9a-f]{64}/, ''))).toEqual(['1.jpg', '2.png']);
    for (const [name, o] of files) {
      expect(name.startsWith(`${B1}/`)).toBe(true);
      expect(name).toContain(`-${sha(o.bytes)}.`); // hash in the path = hash of the uploaded (processed) bytes
      expect(o.owner).toBe(USERS.client.id);
      expect(o.size).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
    const jpeg = files[0][1];
    expect(jpeg.mime).toBe('image/jpeg');
    expect(jpeg.bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(jpeg.bytes.includes(Buffer.from('SYNTHETIC-GPS'))).toBe(false);
    expect(fx.jpegExif.buffer.includes(Buffer.from('SYNTHETIC-GPS'))).toBe(true); // the input really had it
    expect(mock.shotRows.map((r) => r.position)).toEqual([1, 2]);
    expect(mock.cases.find((c) => c.reference === 'SHOT-001')!.workflow_state).toBe('SUBMITTED');
    await expect(page.getByTestId('client-cases').locator('li', { hasText: 'SHOT-001' }).getByTestId('client-case-status')).toHaveText('Under review');
  });

  test('a PNG over 5 MB after processing becomes a JPEG under 5 MB', async ({ page }) => {
    expect(fx.noisy.buffer.length).toBeGreaterThan(5 * 1024 * 1024);
    const f = await startScreenshotCase(page, 'SHOT-BIG', [fx.noisy]);
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('status')).toContainText('submitted');
    const [[name, o]] = filesOf('SHOT-BIG');
    expect(name.endsWith('.jpg')).toBe(true);
    expect(o.mime).toBe('image/jpeg');
    expect(o.size).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  test('non-images, GIFs and oversized dimensions are rejected on the phone; nothing is sent', async ({ page }) => {
    await login(page, 'client');
    const f = form(page);
    await f.getByRole('button', { name: 'Upload screenshots' }).click();
    await f.getByTestId('shots-input').setInputFiles([fx.fake, fx.gif, fx.wide]);
    await expect(f.getByRole('alert')).toContainText('not-really.png is not a PNG, JPEG or WebP image.');
    await expect(f.getByRole('alert')).toContainText('anim.gif is not a PNG, JPEG or WebP image.');
    await expect(f.getByRole('alert')).toContainText('too-wide.png is too large in pixels');
    await expect(f.getByText('No screenshots selected')).toBeVisible();
    await f.getByLabel('Reference').fill('SHOT-NONE');
    await f.getByLabel('Product or service').fill('Synthetic');
    await f.getByLabel('Lead source').selectOption('Referral');
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('alert').last()).toHaveText(SHOT_MESSAGES.NONE);
    expect(mock.requests.filter((r) => r.includes('client_create_case') || r.includes('/storage/'))).toEqual([]);
  });

  test('at most 10 screenshots can be selected', async ({ page }) => {
    await login(page, 'client');
    const f = form(page);
    await f.getByRole('button', { name: 'Upload screenshots' }).click();
    await f.getByTestId('shots-input').setInputFiles(Array.from({ length: 11 }, (_, i) => ({ ...fx.png1, name: `s${i}.png` })));
    await expect(f.getByText('10 screenshots selected')).toBeVisible();
    await expect(f.getByRole('alert')).toContainText(SHOT_MESSAGES.TOO_MANY);
  });
});

test.describe('failures and recovery', () => {
  test('a failed upload is retried without duplicates', async ({ page }) => {
    mock.failUpload.set(2, 'server');
    const f = await startScreenshotCase(page, 'SHOT-RETRY', [fx.png1, fx.png2]);
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('alert')).toHaveText(SHOT_MESSAGES.UPLOAD_FAILED);
    await expect(f.getByTestId('shot-state').nth(1)).toHaveText('Failed');
    await f.getByRole('button', { name: 'Retry' }).click();
    await expect(f.getByRole('status')).toContainText('submitted');
    expect(filesOf('SHOT-RETRY')).toHaveLength(2);
    expect(mock.cases.filter((c) => c.reference === 'SHOT-RETRY')).toHaveLength(1);
  });

  test('an upload whose response was lost is confirmed by the server, not re-sent', async ({ page }) => {
    mock.failUpload.set(1, 'lost');
    const f = await startScreenshotCase(page, 'SHOT-LOST', [fx.png1, fx.png2]);
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('status')).toContainText('submitted');
    expect(filesOf('SHOT-LOST')).toHaveLength(2);
    expect(mock.requests.filter((r) => r.startsWith('POST /storage/'))).toHaveLength(2);
  });

  test('a lost finalize response is repeated safely', async ({ page }) => {
    mock.loseFinalizeResponse = true;
    const f = await startScreenshotCase(page, 'SHOT-FIN', [fx.png1]);
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('status')).toContainText('submitted');
    expect(mock.shotRows.filter((r) => r.storage_path.includes(mock.cases.find((c) => c.reference === 'SHOT-FIN')!.id))).toHaveLength(1);
  });

  test('after a reload the draft is reopened and can be completed with the saved screenshots', async ({ page }) => {
    mock.failUpload.set(2, 'server');
    const f = await startScreenshotCase(page, 'SHOT-RESUME', [fx.png1, fx.png2]);
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('alert')).toHaveText(SHOT_MESSAGES.UPLOAD_FAILED);
    await page.reload();
    const row = page.getByTestId('client-cases').locator('li', { hasText: 'SHOT-RESUME' });
    await expect(row.getByTestId('client-case-status')).toHaveText('Draft — upload incomplete (1 saved)');
    const panel = page.getByTestId('resume-draft'); // reopened automatically
    await expect(panel.getByTestId('resume-summary')).toHaveText('1 screenshot saved.');
    await panel.getByRole('button', { name: 'Submit Saved Screenshots' }).click();
    await expect(row.getByTestId('client-case-status')).toHaveText('Under review');
    expect(mock.shotRows.map((r) => r.position)).toEqual([1]);
  });

  test('a resumed draft can take more screenshots after the saved ones', async ({ page }) => {
    mock.failUpload.set(2, 'server');
    const f = await startScreenshotCase(page, 'SHOT-ADD', [fx.png1, fx.png2]);
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('alert')).toHaveText(SHOT_MESSAGES.UPLOAD_FAILED);
    await page.reload();
    const panel = page.getByTestId('resume-draft');
    await panel.getByTestId('shots-input').setInputFiles([fx.png2, fx.jpegExif]);
    await panel.getByRole('button', { name: 'Upload and Submit' }).click();
    await expect(page.getByTestId('client-cases').locator('li', { hasText: 'SHOT-ADD' }).getByTestId('client-case-status')).toHaveText('Under review');
    expect(filesOf('SHOT-ADD').map(([k]) => k.split('/').pop()!.split('-')[0])).toEqual(['1', '2', '3']);
  });

  test('conflicting files make a draft unusable; the user can start a new case with the same screenshots', async ({ page }) => {
    const f = await startScreenshotCase(page, 'SHOT-CONFLICT', [fx.png1]);
    // First attempt fails; meanwhile two simultaneous uploads (as concurrency can produce)
    // leave two different files at position 1 of this draft.
    mock.failUpload.set(1, 'server');
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('alert')).toHaveText(SHOT_MESSAGES.UPLOAD_FAILED);
    const c = mock.cases.find((x) => x.reference === 'SHOT-CONFLICT')!;
    for (const h of ['a', 'b']) mock.objects.set(`${B1}/${c.id}/1-${h.repeat(64)}.png`, { owner: USERS.client.id, size: 10, mime: 'image/png', bytes: Buffer.from('x') });
    await f.getByRole('button', { name: 'Retry' }).click();
    await expect(f.getByRole('alert')).toHaveText(SHOT_MESSAGES.CONFLICT);
    await expect(page.getByTestId('client-cases').locator('li', { hasText: 'SHOT-CONFLICT' }).getByTestId('client-case-status'))
      .toHaveText('Draft — cannot be completed (conflicting screenshots)');
    await f.getByRole('button', { name: 'Start a New Case With These Screenshots' }).click();
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('status')).toContainText('submitted');
    const both = mock.cases.filter((x) => x.reference === 'SHOT-CONFLICT');
    expect(both.map((x) => x.workflow_state).sort()).toEqual(['DRAFT', 'SUBMITTED']);
  });
});

test.describe('founder views screenshots', () => {
  async function submitted(page: Page, ref: string) {
    const f = await startScreenshotCase(page, ref, [fx.png1, fx.png2]);
    await f.getByRole('button', { name: 'Submit Case' }).click();
    await expect(f.getByRole('status')).toContainText('submitted');
    return mock.cases.find((c) => c.reference === ref)!;
  }
  async function founderPage(context: BrowserContext) {
    const ctx = await context.browser()!.newContext();
    await mock.install(ctx);
    const page = await ctx.newPage();
    await login(page, 'founder');
    return { ctx, page };
  }

  test('screenshots are shown in order from local blobs, downloaded with the founder session', async ({ page, context }) => {
    const c = await submitted(page, 'SHOT-VIEW');
    const { ctx, page: founder } = await founderPage(context);
    await founder.goto(`/app/founder/case/${c.id}`);
    for (const n of [1, 2]) {
      const img = founder.getByTestId(`founder-shot-${n}`);
      await expect(img).toBeVisible();
      expect(await img.getAttribute('src')).toMatch(/^blob:/);
      expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(540);
    }
    await expect(founder.getByTestId('case-conversation')).toHaveCount(0);
    expect(mock.requests.filter((r) => r.startsWith('GET /storage/v1/object/case-screenshots/'))).toHaveLength(2);
    await ctx.close();
  });

  test('deleted and missing files are labelled, nothing else breaks', async ({ page, context }) => {
    const c = await submitted(page, 'SHOT-RET');
    mock.shotRows.find((r) => r.position === 1)!.file_deleted_at = new Date().toISOString();
    mock.objects.delete(mock.shotRows.find((r) => r.position === 2)!.storage_path);
    const { ctx, page: founder } = await founderPage(context);
    await founder.goto(`/app/founder/case/${c.id}`);
    await expect(founder.getByTestId('shot-deleted')).toHaveText('File deleted under retention.');
    await expect(founder.getByTestId('shot-missing')).toHaveText('File missing or unavailable.');
    await ctx.close();
  });

  test('clients never download files and cannot open the founder case page', async ({ page }) => {
    const c = await submitted(page, 'SHOT-PRIV');
    await page.goto(`/app/founder/case/${c.id}`);
    await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible();
    expect(mock.requests.filter((r) => r.startsWith('GET /storage/'))).toEqual([]);
  });
});
