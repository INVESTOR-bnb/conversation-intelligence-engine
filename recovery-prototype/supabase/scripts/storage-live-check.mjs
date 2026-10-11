#!/usr/bin/env node
// Stage 2A-4c — REAL authenticated Storage API checks against the STAGING project.
// Uses supabase-js exactly like the app, signed in as three SYNTHETIC accounts.
// Creates two synthetic cases named LIVE-CHECK-<time> (one submitted, one left
// as an abandoned draft for the retention runbook). Uploads only generated
// test images and a few bytes of plain text. Never use real accounts or data.
//
// Run from recovery-prototype/ (after `npm ci`):
//   RRE_SUPABASE_URL=https://<ref>.supabase.co RRE_PUBLISHABLE_KEY=sb_publishable_... \
//   CLIENT_A_EMAIL=... CLIENT_A_PASSWORD=... CLIENT_B_EMAIL=... CLIENT_B_PASSWORD=... \
//   FOUNDER_EMAIL=... FOUNDER_PASSWORD=... node supabase/scripts/storage-live-check.mjs
// Clients A and B must be linked to DIFFERENT synthetic businesses.
// Only an sb_publishable_ key is accepted; legacy eyJ… JWT keys and secret keys are refused.
// Passwords are read from the environment only; never paste them into chat.

import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { publishableKeyProblem } from './live-key.mjs';

const env = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing environment variable ${k}`); process.exit(2); }
  return v;
};
const URL_ = env('RRE_SUPABASE_URL');
const KEY = env('RRE_PUBLISHABLE_KEY');
const keyProblem = publishableKeyProblem(KEY);
if (keyProblem) { console.error(`refused: ${keyProblem}. Use the publishable key (sb_publishable_…) only.`); process.exit(2); }
const BUCKET = 'case-screenshots';
const results = [];
const record = (status, name, detail = '') => { results.push({ status, name }); console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`); };
const expectOk = (name, ok, detail) => record(ok ? 'PASS' : 'FAIL', name, detail);
const refused = (r) => Boolean(r.error) || (Array.isArray(r.data) && r.data.length === 0);

async function signIn(prefix) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: env(`${prefix}_EMAIL`), password: env(`${prefix}_PASSWORD`) });
  if (error) { console.error(`${prefix}: sign-in failed: ${error.message}`); process.exit(2); }
  const who = await c.rpc('whoami');
  return { c, who: who.data };
}

// A valid 1×1 PNG (synthetic).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const path = (biz, kase, pos, bytes, ext = 'png') => `${biz}/${kase}/${pos}-${sha(bytes)}.${ext}`;

const A = await signIn('CLIENT_A');
const B = await signIn('CLIENT_B');
const F = await signIn('FOUNDER');
if (A.who?.role !== 'CLIENT' || B.who?.role !== 'CLIENT' || F.who?.role !== 'FOUNDER' || A.who.business_id === B.who.business_id) {
  console.error('accounts must be: two CLIENTS of different businesses, and the FOUNDER'); process.exit(2);
}
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const mk = async (ref) => {
  const { data, error } = await A.c.rpc('client_create_case', { p_idempotency_key: crypto.randomUUID(), p_reference: ref, p_product_service: 'Synthetic live check', p_lead_source: 'Other', p_conversation_source: 'SCREENSHOTS' });
  if (error || !data) { console.error(`could not create the synthetic case: ${error?.message}`); process.exit(2); }
  return data;
};
const caseId = await mk(`LIVE-CHECK-${stamp}`);
const caseId2 = await mk(`LIVE-CHECK-${stamp}-X`);
const p1 = path(A.who.business_id, caseId, 1, PNG);

console.log('== Upload (A1, A3, A5)');
let r = await A.c.storage.from(BUCKET).upload(p1, PNG, { contentType: 'image/png', upsert: false });
expectOk('client A uploads a valid PNG to its own draft with INSERT-only policies', !r.error, r.error?.message);
const st = (await A.c.rpc('client_screenshot_status', { p_case_id: caseId })).data;
const f1 = st?.files?.find((f) => f.position === 1);
expectOk('Storage recorded the real size (metadata.size)', f1?.size === PNG.length, `recorded ${f1?.size}, sent ${PNG.length}`);
expectOk('Storage recorded the declared type (metadata.mimetype)', f1?.mime_type === 'image/png', f1?.mime_type);

console.log('== Client A cannot read, list, sign, copy, move, replace or delete (even its own file)');
expectOk('download own file refused', refused(await A.c.storage.from(BUCKET).download(p1)));
expectOk('list own folder returns nothing', refused(await A.c.storage.from(BUCKET).list(`${A.who.business_id}/${caseId}`)));
expectOk('signed download URL refused', refused(await A.c.storage.from(BUCKET).createSignedUrl(p1, 60)));
expectOk('copy refused', refused(await A.c.storage.from(BUCKET).copy(p1, path(A.who.business_id, caseId, 2, PNG))));
expectOk('move refused', refused(await A.c.storage.from(BUCKET).move(p1, path(A.who.business_id, caseId, 3, PNG))));
expectOk('upsert (replace) refused', refused(await A.c.storage.from(BUCKET).upload(p1, PNG, { contentType: 'image/png', upsert: true })));
expectOk('update refused', refused(await A.c.storage.from(BUCKET).update(p1, PNG, { contentType: 'image/png' })));
await A.c.storage.from(BUCKET).remove([p1]);
expectOk('delete had no effect (founder can still download)', !(await F.c.storage.from(BUCKET).download(p1)).error);

console.log('== Client B (other business) is isolated');
expectOk('B cannot upload into A\'s case', refused(await B.c.storage.from(BUCKET).upload(path(A.who.business_id, caseId, 2, PNG), PNG, { contentType: 'image/png' })));
expectOk('B cannot download A\'s file', refused(await B.c.storage.from(BUCKET).download(p1)));
expectOk('B cannot list A\'s folder', refused(await B.c.storage.from(BUCKET).list(`${A.who.business_id}/${caseId}`)));
expectOk('B cannot sign A\'s file', refused(await B.c.storage.from(BUCKET).createSignedUrl(p1, 60)));
expectOk('B cannot see the status of A\'s case', Boolean((await B.c.rpc('client_screenshot_status', { p_case_id: caseId })).error));

console.log('== Anonymous access');
const anon = createClient(URL_, KEY, { auth: { persistSession: false } });
expectOk('anonymous download refused', refused(await anon.storage.from(BUCKET).download(p1)));
const pub = await fetch(`${URL_}/storage/v1/object/public/${BUCKET}/${p1}`);
expectOk('public URL refused (bucket is private)', pub.status >= 400, `HTTP ${pub.status}`);

console.log('== Bucket limits (A4) and content validation (A8)');
const big = randomBytes(6 * 1024 * 1024);
expectOk('6 MB upload refused by the bucket limit', refused(await A.c.storage.from(BUCKET).upload(path(A.who.business_id, caseId2, 1, big), big, { contentType: 'image/png' })));
const gif = Buffer.from('GIF89a synthetic');
expectOk('image/gif refused by the bucket type list', refused(await A.c.storage.from(BUCKET).upload(path(A.who.business_id, caseId2, 1, gif), gif, { contentType: 'image/gif' })));
const text = Buffer.from('not an image, synthetic');
r = await A.c.storage.from(BUCKET).upload(path(A.who.business_id, caseId2, 1, text), text, { contentType: 'image/png' });
record(r.error ? 'PASS' : 'INFO', 'plain text declared as image/png', r.error ? 'refused' : 'ACCEPTED — confirms contents are NOT validated server-side (A8); left in the abandoned draft');

console.log('== Signed upload URL created before submission, used after (A7)');
const p2 = path(A.who.business_id, caseId, 2, PNG);
const signed = await A.c.storage.from(BUCKET).createSignedUploadUrl(p2);
expectOk('client can create a signed upload URL for its own free position', !signed.error, signed.error?.message);
const fin = await A.c.rpc('client_finalize_screenshots', { p_case_id: caseId });
const sub = await A.c.rpc('client_submit_case', { p_case_id: caseId });
expectOk('finalize and submit succeed with one screenshot', !fin.error && !sub.error, fin.error?.message ?? sub.error?.message);
if (!signed.error) {
  r = await A.c.storage.from(BUCKET).uploadToSignedUrl(p2, signed.data.token, PNG, { contentType: 'image/png' });
  record(r.error ? 'PASS' : 'WARN', 'upload with that URL after submission', r.error ? 'refused (rule re-checked at upload)' : 'ACCEPTED — the file sits unrecorded in the submitted case; it is never shown or analysed');
}
expectOk('no upload after submission (normal API)', refused(await A.c.storage.from(BUCKET).upload(path(A.who.business_id, caseId, 3, PNG), PNG, { contentType: 'image/png' })));

console.log('== Founder');
const dl = await F.c.storage.from(BUCKET).download(p1);
expectOk('founder downloads the screenshot; bytes match the hash in its name', !dl.error && sha(Buffer.from(await dl.data.arrayBuffer())) === sha(PNG));
const rows = await F.c.from('case_screenshots').select('position, storage_path, size_bytes, mime_type').eq('case_id', caseId);
expectOk('exactly one screenshot recorded for the submitted case', rows.data?.length === 1 && rows.data[0].storage_path === p1);
expectOk('founder cannot upload (not a business member)', refused(await F.c.storage.from(BUCKET).upload(path(A.who.business_id, caseId2, 2, PNG), PNG, { contentType: 'image/png' })));

const failed = results.filter((x) => x.status === 'FAIL').length;
console.log(`== ${results.filter((x) => x.status === 'PASS').length} pass, ${failed} fail, ${results.filter((x) => x.status === 'WARN').length} warn, ${results.filter((x) => x.status === 'INFO').length} info`);
console.log(`Synthetic cases created: LIVE-CHECK-${stamp} (submitted), LIVE-CHECK-${stamp}-X (abandoned draft).`);
process.exit(failed ? 1 : 0);
