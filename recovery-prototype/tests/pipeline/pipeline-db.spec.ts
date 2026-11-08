// Stage 2A-5d-4a — the pipeline core against the REAL database contract
// (local PostgreSQL; fake provider; synthetic data). Run via
// supabase/scripts/test-pipeline-db.sh.

import { expect, test } from '@playwright/test';
import {
  REJECTED_RECOMMENDATION, runAnalysisPipeline, sha256Hex, type AnalysisProvider, type FounderDb, type PipelineResult,
} from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { analystAnswer, BODY1, BODY2, CONFIG, DRAFT, FakeProvider, MemoryLogger, ok, reviewAnswer } from './fakes';
// @ts-expect-error plain ES module without type declarations
import { DIAGNOSE_SQL } from '../../supabase/scripts/paid-staging.mjs';
import { BIZ_A, CLIENT_A, CLIENT_B, enableTestSpending, makeRoomForCase, one, PsqlFounderDb, PsqlServiceDb, spend, sql } from './psqlDb';

const storage = new Map<string, Uint8Array>();
const service = new PsqlServiceDb();
let n = 0;

test.beforeAll(() => { sql('select tests.seed() where not exists (select 1 from public.founders)'); });
test.beforeEach(() => { enableTestSpending(); });

/** A submitted TEXT case of business A (pasted conversation + one prospect reply); returns ids. */
function textCase() {
  n += 1;
  makeRoomForCase();
  const c = one(`select public.client_create_case(gen_random_uuid(), :'ref', 'Synthetic car', 'Referral', 'TEXT', :'body')`,
    { ref: `PL-${n}`, body: BODY1 }, { role: 'authenticated', sub: CLIENT_A })!;
  sql(`select public.client_submit_case(:'c')`, { c }, { role: 'authenticated', sub: CLIENT_A });
  const m1 = one(`select id from public.case_messages where case_id = :'c' and kind = 'PASTED_CONVERSATION'`, { c })!;
  const m2 = one(`insert into public.case_messages (case_id, business_id, kind, body) values (:'c', :'b', 'PROSPECT_RESPONSE', :'body') returning id`,
    { c, b: BIZ_A, body: BODY2 })!;
  return { c, m1, m2 };
}

/** A submitted SCREENSHOTS case with stored files (Storage simulated); returns ids and paths. */
async function shotCase(files: Uint8Array[]) {
  n += 1;
  makeRoomForCase();
  const c = one(`select public.client_create_case(gen_random_uuid(), :'ref', 'Synthetic car', 'Referral', 'SCREENSHOTS')`,
    { ref: `PS-${n}` }, { role: 'authenticated', sub: CLIENT_A })!;
  const paths: string[] = [];
  for (const [i, bytes] of files.entries()) {
    const sha = await sha256Hex(bytes);
    const path = `${BIZ_A}/${c}/${i + 1}-${sha}.png`;
    storage.set(path, bytes);
    paths.push(path);
    sql(`insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
         values (:'c', :'b', :'p', :'path', 'image/png', :'size', :'sha', :'u')`,
      { c, b: BIZ_A, p: String(i + 1), path, size: String(bytes.length), sha, u: CLIENT_A });
  }
  sql(`update public.cases set workflow_state = 'SUBMITTED', evidence_version = 1 where id = :'c'`, { c });
  return { c, paths };
}

function run(caseId: string, provider: AnalysisProvider, founderDb: FounderDb = new PsqlFounderDb(storage)): Promise<PipelineResult> {
  return runAnalysisPipeline(caseId, { founderDb, serviceDb: service, provider, logger: new MemoryLogger(), config: CONFIG });
}
const row = (id: string) => JSON.parse(one(`select row_to_json(a) from public.analyses a where id = :'a'`, { a: id })!);
const caseState = (c: string) => one(`select workflow_state from public.cases where id = :'c'`, { c });

// ---------------------------------------------------------------- success through the real contract

test('success: the merged rre-analysis/2 output passes the real contract and is stored for the founder', async () => {
  const { c, m1, m2 } = textCase();
  const r = await run(c, new FakeProvider({ ANALYST: ok(analystAnswer(m1, m2)), REVIEWER: ok(reviewAnswer('UPHOLD_WITH_CONCERNS', m1)) }));
  expect(r).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  const a = row(r.analysisId!);
  expect(a.status).toBe('COMPLETE');
  expect(a.output.contract_version).toBe('rre-analysis/2');
  expect(a.output.adversarial_review.verdict).toBe('UPHOLD_WITH_CONCERNS');
  expect(a.ai_classification).toBe('GREEN');
  expect(a.ai_proposed_message).toBe(DRAFT);
  expect([a.input_tokens, a.output_tokens, Number(a.estimated_cost_usd)]).toEqual([2000, 1000, 0.021]);
  expect(a.model).toBe('analyst:fake-analyst|reviewer:fake-reviewer');
  expect(caseState(c)).toBe('AWAITING_ADMIN_REVIEW');
});

test("the pipeline's message hashes match the database's (UTF-8, including non-ASCII text)", async () => {
  const { c } = textCase();
  const body = 'Prospect: Ọ̀rẹ́, ₦4.5m is too high — maybe next week? 😊';
  sql(`update public.case_messages set body = :'b' where case_id = :'c' and kind = 'PROSPECT_RESPONSE'`, { b: body, c });
  const id = one(`select public.founder_start_analysis(:'c')`, { c }, { role: 'authenticated', sub: '00000000-0000-4000-8000-00000000000f' })!;
  const m = row(id).evidence_manifest.messages.find((x: { kind: string }) => x.kind === 'PROSPECT_RESPONSE');
  expect(m.body_sha256).toBe(await sha256Hex(body));
  sql(`select public.founder_abandon_analysis(:'a')`, { a: id }, { role: 'authenticated', sub: '00000000-0000-4000-8000-00000000000f' });
});

test('a rejecting review: the real contract accepts the deterministic no-contact form; verdict kept; no message anywhere', async () => {
  const { c, m1, m2 } = textCase();
  const r = await run(c, new FakeProvider({ ANALYST: ok(analystAnswer(m1, m2)), REVIEWER: ok(reviewAnswer('REJECT_RECOMMENDATION', m1)) }));
  expect(r).toMatchObject({ outcome: 'COMPLETED', code: 'RECOMMENDATION_REJECTED_BY_REVIEW' });
  const a = row(r.analysisId!);
  expect(a.status).toBe('COMPLETE');
  expect(a.output.adversarial_review).toEqual(reviewAnswer('REJECT_RECOMMENDATION', m1));
  expect(a.output.recommendation).toEqual(REJECTED_RECOMMENDATION);
  expect([a.ai_classification, a.ai_proposed_message]).toEqual([null, null]);
  expect(JSON.stringify(a)).not.toContain('SYNTHETIC-DRAFT');
});

test('screenshot evidence: stored files are re-hashed and cited; the contract accepts', async () => {
  const { c } = await shotCase([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
  const shotAnswer = analystAnswer('', '', {
    classification: null,
    observations: [{ id: 'O1', actor: 'PROSPECT', behavior: 'Asked about delivery.', evidence: [{ type: 'SCREENSHOT', position: 2 }] }],
    hypotheses: [], unknowns: [{ question: 'When is delivery needed?', why_it_matters: 'Decides urgency.' }],
    recommendation: { pursue: 'UNKNOWN', strategy: 'UNKNOWN', psychological_rationale: 'UNKNOWN', based_on_hypotheses: [], next_action: { type: 'WAIT', text: 'Wait.' } },
  });
  const provider = new FakeProvider({ ANALYST: ok(shotAnswer), REVIEWER: ok(reviewAnswer('UPHOLD')) });
  const r = await run(c, provider);
  expect(r).toMatchObject({ outcome: 'COMPLETED' });
  expect(provider.requests[0].content.filter((p) => p.type === 'image')).toHaveLength(2);
});

// ---------------------------------------------------------------- the contract rejects what the pipeline cannot know

test('a fabricated citation by the analyst is rejected by the contract: ERROR, nothing kept, case restored', async () => {
  const { c, m1, m2 } = textCase();
  const fake = analystAnswer(m1, m2);
  fake.observations[0].evidence[0].quote = 'I will pay cash today';
  const r = await run(c, new FakeProvider({ ANALYST: ok(fake), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) }));
  expect(r).toMatchObject({ outcome: 'REJECTED', code: 'CONTRACT_REJECTED' });
  const a = row(r.analysisId!);
  expect(a.status).toBe('ERROR');
  expect(a.error).toMatch(/^REJECTED by analysis contract .*quote does not appear in the cited message/);
  expect([a.output, a.ai_proposed_message, a.ai_classification]).toEqual([null, null, null]);
  expect(caseState(c)).toBe('SUBMITTED');
});

test('a fabricated citation by the reviewer (another case\'s message) is rejected too', async () => {
  const other = textCase();
  const { c, m1, m2 } = textCase();
  const r = await run(c, new FakeProvider({ ANALYST: ok(analystAnswer(m1, m2)), REVIEWER: ok(reviewAnswer('UPHOLD_WITH_CONCERNS', other.m1)) }));
  expect(r).toMatchObject({ outcome: 'REJECTED', code: 'CONTRACT_REJECTED' });
  expect(row(r.analysisId!).error).toContain("adversarial_review.challenges[0].evidence[0]: message is not part of this analysis's evidence");
});

// ---------------------------------------------------------------- restrictions, missing evidence, tampering

test('a restricted case: refused before any analysis row or provider call', async () => {
  const { c } = textCase();
  sql(`select public.founder_add_restriction(:'c', 'EXPLICIT_OPT_OUT', 'Synthetic opt-out.')`, { c }, { role: 'authenticated', sub: '00000000-0000-4000-8000-00000000000f' });
  const provider = new FakeProvider({});
  expect(await run(c, provider)).toEqual({ outcome: 'NOT_STARTED', code: 'CONTACT_RESTRICTED', analysisId: null });
  expect(provider.requests).toHaveLength(0);
  expect(one(`select count(*) from public.analyses where case_id = :'c'`, { c })).toBe('0');
});

test('a restriction recorded between the pre-check and the start is caught from the snapshot', async () => {
  const { c } = textCase();
  const founderDb = new PsqlFounderDb(storage);
  founderDb.activeRestrictionCount = async () => {
    sql(`select public.founder_add_restriction(:'c', 'PROHIBITED_CONTACT', 'Synthetic race.')`, { c }, { role: 'authenticated', sub: '00000000-0000-4000-8000-00000000000f' });
    return 0;
  };
  const provider = new FakeProvider({});
  const r = await run(c, provider, founderDb);
  expect(r).toMatchObject({ outcome: 'FAILED', code: 'CONTACT_RESTRICTED' });
  expect(provider.requests).toHaveLength(0);
  expect(row(r.analysisId!).status).toBe('ERROR');
  expect(caseState(c)).toBe('SUBMITTED');
});

test('no usable evidence: the database refuses to start (no row, no call)', async () => {
  const { c } = await shotCase([new Uint8Array([9])]);
  sql(`update public.case_screenshots set file_deleted_at = now() where case_id = :'c'`, { c });
  const provider = new FakeProvider({});
  expect(await run(c, provider)).toMatchObject({ outcome: 'NOT_STARTED', code: 'INSUFFICIENT_EVIDENCE' });
  expect(provider.requests).toHaveLength(0);
});

test('a screenshot file changed in storage after the snapshot: hash mismatch, no call, lock released', async () => {
  const { c, paths } = await shotCase([new Uint8Array([7, 7, 7])]);
  const founderDb = new PsqlFounderDb(storage);
  const realGet = founderDb.getScreenshotFile.bind(founderDb);
  founderDb.getScreenshotFile = async (caseId, id) => { storage.set(paths[0], new Uint8Array([6, 6, 6])); return realGet(caseId, id); };
  const provider = new FakeProvider({});
  const r = await run(c, provider, founderDb);
  expect(r).toMatchObject({ outcome: 'FAILED', code: 'EVIDENCE_HASH_MISMATCH' });
  expect(provider.requests).toHaveLength(0);
  expect(row(r.analysisId!)).toMatchObject({ status: 'ERROR', error: 'PIPELINE_ERROR: EVIDENCE_HASH_MISMATCH' });
});

test('a message edited after the snapshot: hash mismatch, no call, lock released', async () => {
  const { c } = textCase();
  const founderDb = new PsqlFounderDb(storage);
  const realGet = founderDb.getMessages.bind(founderDb);
  founderDb.getMessages = async (caseId, ids) => {
    sql(`update public.case_messages set body = body || ' (edited)' where case_id = :'c' and kind = 'PROSPECT_RESPONSE'`, { c });
    return realGet(caseId, ids);
  };
  const provider = new FakeProvider({});
  const r = await run(c, provider, founderDb);
  expect(r).toMatchObject({ outcome: 'FAILED', code: 'EVIDENCE_HASH_MISMATCH' });
  expect(provider.requests).toHaveLength(0);
});

// ---------------------------------------------------------------- provider failure, restriction preservation, lock

test('a provider failure records ERROR, keeps a detected opt-out, releases the lock; a re-run then works', async () => {
  const { c, m1, m2 } = textCase();
  const optOut = analystAnswer(m1, m2, { contact_restrictions: [{ kind: 'EXPLICIT_OPT_OUT', reason: 'Synthetic: asked to stop.',
    evidence: [{ type: 'MESSAGE', message_id: m1, quote: 'the price feels high' }] }] });
  const r = await run(c, new FakeProvider({ ANALYST: ok(optOut), REVIEWER: new Error('upstream 529') }));
  expect(r).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_ERROR_REVIEWER' });
  expect(row(r.analysisId!)).toMatchObject({ status: 'ERROR', error: 'PIPELINE_ERROR: PROVIDER_ERROR_REVIEWER', output: null });
  expect(caseState(c)).toBe('SUBMITTED');
  expect(one(`select count(*) from public.contact_restrictions where case_id = :'c' and kind = 'EXPLICIT_OPT_OUT' and source = 'AI_DETECTED' and status = 'ACTIVE'`, { c })).toBe('1');
  // The kept opt-out now blocks the next run before any call.
  const again = new FakeProvider({});
  expect(await run(c, again)).toMatchObject({ outcome: 'NOT_STARTED', code: 'CONTACT_RESTRICTED' });
  expect(again.requests).toHaveLength(0);
});

test('the per-case lock is the database\'s: a second run during a pending one is refused', async () => {
  const { c, m1, m2 } = textCase();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = new FakeProvider({ ANALYST: async () => { await gate; return ok(analystAnswer(m1, m2)); }, REVIEWER: ok(reviewAnswer('UPHOLD', m1)) });
  const first = runAnalysisPipeline(c, { founderDb: new PsqlFounderDb(storage), serviceDb: service, provider: slow, logger: new MemoryLogger(),
    config: { ...CONFIG, callTimeoutMs: 20000, deadlineMs: 30000 } });
  await expect.poll(() => slow.requests.length).toBe(1);
  expect(await run(c, new FakeProvider({}))).toMatchObject({ outcome: 'NOT_STARTED', code: 'INVALID_STATE' });
  release();
  expect(await first).toMatchObject({ outcome: 'COMPLETED' });
});

test('LOCK_HELD when nothing can be written; founder_abandon_analysis then releases it and a re-run works', async () => {
  const { c, m1, m2 } = textCase();
  const founderDb = new PsqlFounderDb(storage);
  founderDb.abandonAnalysis = async () => { throw new Error('network down'); };
  const broken = Object.assign(new PsqlServiceDb(), { completeAnalysis: async () => { throw new Error('network down'); } });
  const r = await runAnalysisPipeline(c, { founderDb, serviceDb: broken, provider: new FakeProvider({ ANALYST: new Error('x') }),
    logger: new MemoryLogger(), config: CONFIG });
  expect(r).toMatchObject({ outcome: 'LOCK_HELD', code: 'PROVIDER_ERROR_ANALYST' });
  expect(row(r.analysisId!).status).toBe('PENDING');
  expect(caseState(c)).toBe('ANALYZING');
  expect(spend(r.analysisId!)).toBe('RESERVED:-:-');
  // The documented manual recovery.
  sql(`select public.founder_abandon_analysis(:'a')`, { a: r.analysisId! }, { role: 'authenticated', sub: '00000000-0000-4000-8000-00000000000f' });
  expect(row(r.analysisId!)).toMatchObject({ status: 'ERROR', error: 'Abandoned by founder' });
  expect(spend(r.analysisId!)).toBe('HELD:UNKNOWN_USAGE:0.0000'); // the analyst call was dispatched: not released
  expect(caseState(c)).toBe('SUBMITTED');
  expect(await run(c, new FakeProvider({ ANALYST: ok(analystAnswer(m1, m2)), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) }))).toMatchObject({ outcome: 'COMPLETED' });
});

// ---------------------------------------------------------------- who can run it, who can read it

test('a business user cannot run the pipeline (the database refuses to start)', async () => {
  const { c } = textCase();
  const provider = new FakeProvider({});
  expect(await run(c, provider, new PsqlFounderDb(storage, CLIENT_A))).toMatchObject({ outcome: 'NOT_STARTED', code: 'FORBIDDEN' });
  expect(provider.requests).toHaveLength(0);
});

test('the founder-side adapter cannot complete an analysis (the service role is needed, and used only there)', async () => {
  const { c } = textCase();
  const id = one(`select public.founder_start_analysis(:'c')`, { c }, { role: 'authenticated', sub: '00000000-0000-4000-8000-00000000000f' })!;
  expect(() => sql(`select public.internal_complete_analysis(:'a', 'ERROR')`, { a: id }, { role: 'authenticated', sub: '00000000-0000-4000-8000-00000000000f' }))
    .toThrow(/permission denied|FORBIDDEN/);
  sql(`select public.founder_abandon_analysis(:'a')`, { a: id }, { role: 'authenticated', sub: '00000000-0000-4000-8000-00000000000f' });
});

test('business users never receive analyses or reviews produced by the pipeline', async () => {
  const { c, m1, m2 } = textCase();
  await run(c, new FakeProvider({ ANALYST: ok(analystAnswer(m1, m2)), REVIEWER: ok(reviewAnswer('REJECT_RECOMMENDATION', m1)) }));
  expect(one(`select count(*) from public.analyses where output ? 'adversarial_review'`)).not.toBe('0');
  for (const sub of [CLIENT_A, CLIENT_B]) {
    expect(one('select count(*) from public.analyses', {}, { role: 'authenticated', sub })).toBe('0');
    expect(one('select count(*) from public.contact_restrictions', {}, { role: 'authenticated', sub })).toBe('0');
  }
  const detail = one(`select public.client_get_case(:'c')::text`, { c }, { role: 'authenticated', sub: CLIENT_A })!;
  expect(detail).not.toMatch(/SYNTHETIC-REVIEW|SYNTHETIC-DRAFT|adversarial|verdict|hypothes|price feels high for the value/);
  expect(one(`select status from public.client_list_cases() where id = :'c'`, { c }, { role: 'authenticated', sub: CLIENT_A })).toBe('UNDER_REVIEW');
  expect(() => sql('select count(*) from public.analyses', {}, { role: 'anon' })).toThrow(/permission denied/);
});

// ---------------------------------------------------------------- Stage 2A-5d-3b: the real spending ledger

test('spending: the real ledger settles at reported usage x each role\'s own database price; requests use the database caps', async () => {
  const { c, m1, m2 } = textCase();
  const provider = new FakeProvider({ ANALYST: ok(analystAnswer(m1, m2)), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) });
  const r = await run(c, provider);
  expect(r).toMatchObject({ outcome: 'COMPLETED' });
  // analyst 1000 in x 2 + 500 out x 10; reviewer 1000 x 4 + 500 x 20 (per million) = 0.0210
  expect(spend(r.analysisId!)).toBe('SETTLED:REPORTED_USAGE:0.0210');
  expect(provider.requests.map((x) => [x.role, x.maxOutputTokens])).toEqual([['ANALYST', 8000], ['REVIEWER', 4000]]);
  const l = JSON.parse(one(`select row_to_json(l) from private.ai_spend_ledger l where analysis_id = :'a'`, { a: r.analysisId! })!);
  expect([l.analyst_input_tokens, l.analyst_output_tokens, l.reviewer_input_tokens, l.reviewer_output_tokens]).toEqual([1000, 500, 1000, 500]);
  expect(Number(l.reserved_usd)).toBeGreaterThan(0.021);
});

test('spending: a provider failure after dispatch leaves the real reservation HELD (fully committed) and releases the lock', async () => {
  for (const [name, replies, held] of [
    ['analyst fails', { ANALYST: new Error('500') }, 'HELD:UNKNOWN_USAGE:0.0000'],
    ['reviewer fails', { ANALYST: 'OK', REVIEWER: new Error('overloaded') }, 'HELD:UNKNOWN_USAGE:0.0070'],
  ] as const) {
    const { c, m1, m2 } = textCase();
    const before = Number(one('select private.ai_committed_usd()'));
    const r = await run(c, new FakeProvider({ ...replies, ...(replies.ANALYST === 'OK' ? { ANALYST: ok(analystAnswer(m1, m2)) } : {}) } as never));
    expect(r.outcome, name).toBe('FAILED');
    expect(spend(r.analysisId!), name).toBe(held);
    const reserved = Number(one(`select reserved_usd from private.ai_spend_ledger where analysis_id = :'a'`, { a: r.analysisId! }));
    expect(Number(one('select private.ai_committed_usd()')), name).toBeCloseTo(before + reserved, 4);
    expect(caseState(c), name).toBe('SUBMITTED');
  }
});

test('spending: disabled in the database -> the real pipeline makes no provider request and reserves nothing', async () => {
  enableTestSpending(false);
  const { c } = textCase();
  const provider = new FakeProvider({});
  const r = await run(c, provider);
  enableTestSpending();
  expect(r).toMatchObject({ outcome: 'FAILED', code: 'SPENDING_DISABLED' });
  expect(provider.requests).toHaveLength(0);
  expect(spend(r.analysisId!)).toBe('NONE');
  expect(row(r.analysisId!)).toMatchObject({ status: 'ERROR', error: 'PIPELINE_ERROR: SPENDING_DISABLED' });
  expect(caseState(c)).toBe('SUBMITTED');
});

test('spending: a second dispatch of the same call is refused by the database (no retry is possible even by mistake)', async () => {
  const { c, m1, m2 } = textCase();
  const service = new PsqlServiceDb();
  let retried: unknown = null;
  const provider = new FakeProvider({
    ANALYST: async () => {
      const a = one(`select id from public.analyses where case_id = :'c' and status = 'PENDING'`, { c })!;
      try { await service.recordDispatch(a, 'ANALYST'); } catch (e) { retried = (e as { code?: string }).code; }
      return ok(analystAnswer(m1, m2));
    },
    REVIEWER: ok(reviewAnswer('UPHOLD', m1)),
  });
  expect(await run(c, provider)).toMatchObject({ outcome: 'COMPLETED' });
  expect(retried).toBe('ALREADY_DISPATCHED');
});

test('strategic next move: the BUYER SIGNAL / NEXT MOVE / WHY THIS MOVE format fits the existing fields and the real contract', async () => {
  const strategy = (move: string) => `BUYER SIGNAL: the prospect asked "Can I see it on Saturday?" after saying "the price feels high". NEXT MOVE: ${move}`;
  const send = 'Saturday works. Would 10am suit you? I can also bring the service history so you can judge the price against the car itself.';
  const cases = [
    { name: 'PURSUE + message', classification: 'GREEN', message: send,
      recommendation: { pursue: 'PURSUE', strategy: strategy('confirm the Saturday viewing and offer the service history.'),
        psychological_rationale: 'WHY THIS MOVE: it answers the request they made and addresses the price concern with information, not pressure.',
        based_on_hypotheses: ['H1'], next_action: { type: 'SEND_MESSAGE', text: send } } },
    { name: 'UNKNOWN + wait', classification: null, message: null,
      recommendation: { pursue: 'UNKNOWN', strategy: strategy('wait for the prospect; do not send a check-in.'),
        psychological_rationale: 'WHY THIS MOVE: silence alone shows nothing about their intent.',
        based_on_hypotheses: [], next_action: { type: 'WAIT', text: 'Wait; do not send a generic follow-up.' } } },
    { name: 'DO_NOT_PURSUE + close respectfully', classification: 'RED', message: null,
      recommendation: { pursue: 'DO_NOT_PURSUE', strategy: strategy('close respectfully and stop contact.'),
        psychological_rationale: 'WHY THIS MOVE: the evidence does not justify more effort.',
        based_on_hypotheses: [], next_action: { type: 'STOP_CONTACT', text: 'Close respectfully; send nothing further.' } },
      reasons_not_to_pursue: [{ reason: 'Price objection with no budget given.', evidence: [] as unknown[] }] },
  ];
  for (const t of cases) {
    const { c, m1, m2 } = textCase();
    const answer = analystAnswer(m1, m2, {
      classification: t.classification, recommendation: t.recommendation,
      reasons_not_to_pursue: (t.reasons_not_to_pursue ?? []).map((r) => ({ ...r, evidence: [{ type: 'MESSAGE', message_id: m1, quote: 'the price feels high' }] })),
    });
    const r = await run(c, new FakeProvider({ ANALYST: ok(answer), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) }));
    expect(r, t.name).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
    const a = row(r.analysisId!);
    expect(a.output.recommendation.strategy, t.name).toMatch(/^BUYER SIGNAL: .+ NEXT MOVE: .+/);
    expect(a.output.recommendation.psychological_rationale, t.name).toMatch(/^WHY THIS MOVE: /);
    expect(a.ai_proposed_message, t.name).toBe(t.message);
  }
});

test('founder-review case: seller mistake as an observation, silence cause as a competing hypothesis, VERIFY FIRST, a draft true either way — the real contract accepts it', async () => {
  const { c, m1, m2 } = textCase();
  const draft = 'Thanks for asking about Saturday. Let me confirm the car and a viewing time for you today. What time of day usually suits you best?';
  const answer = analystAnswer(m1, m2, {
    classification: 'YELLOW',
    observations: [
      { id: 'O1', actor: 'PROSPECT', behavior: 'Said the price feels high.', evidence: [{ type: 'MESSAGE', message_id: m1, quote: 'the price feels high' }] },
      { id: 'O2', actor: 'PROSPECT', behavior: 'Asked to see the car on Saturday.', evidence: [{ type: 'MESSAGE', message_id: m2, quote: 'Can I see it on Saturday' }] },
      { id: 'O3', actor: 'SELLER', behavior: 'Answered the price concern with a flat refusal.', evidence: [{ type: 'MESSAGE', message_id: m1, quote: 'It is our best price' }] },
    ],
    hypotheses: [
      { id: 'H1', category: 'SELLER_CREATED_RESISTANCE', statement: 'The flat price reply may have discouraged the prospect.', basis: 'HYPOTHESIS',
        supporting_observations: ['O3'], contradicting_observations: ['O2'], competing_hypotheses: ['H2'], confidence: 'LOW',
        uncertainty: 'The prospect still asked to view afterwards; the cause of any silence is unknown.' },
      { id: 'H2', category: 'DECISION_FRICTION', statement: 'The prospect may simply be arranging time to view.', basis: 'HYPOTHESIS',
        supporting_observations: ['O2'], contradicting_observations: [], competing_hypotheses: ['H1'], confidence: 'LOW',
        uncertainty: 'Nothing shows why no visit was fixed.' },
    ],
    recommendation: { pursue: 'PURSUE',
      strategy: 'BUYER SIGNAL: the prospect asked "Can I see it on Saturday". VERIFY FIRST: that the car is still available and which Saturday times the seller can offer. NEXT MOVE: reply to the viewing request once confirmed.',
      psychological_rationale: 'WHY THIS MOVE: it answers the request they made without asserting availability or a time nobody has confirmed.',
      based_on_hypotheses: ['H2'], next_action: { type: 'SEND_MESSAGE', text: draft } },
  });
  const r = await run(c, new FakeProvider({ ANALYST: ok(answer), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) }));
  expect(r).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  const a = row(r.analysisId!);
  expect(a.output.recommendation.strategy).toMatch(/BUYER SIGNAL: .+ VERIFY FIRST: .+ NEXT MOVE: .+/);
  expect(a.ai_proposed_message).toBe(draft);
  expect(a.ai_proposed_message).not.toMatch(/still (here|available)/i);
});

test('founder-review case: a draft asserting unverified availability, challenged HIGH by the reviewer, is removed deterministically — no message survives', async () => {
  const { c, m1, m2 } = textCase();
  const bad = 'Good morning. The car is still here. Would Saturday at 10 suit you for a viewing?';
  const answer = analystAnswer(m1, m2, { recommendation: { pursue: 'PURSUE', strategy: 'BUYER SIGNAL: asked to view. NEXT MOVE: offer Saturday.',
    psychological_rationale: 'WHY THIS MOVE: turns interest into a visit.', based_on_hypotheses: ['H1'], next_action: { type: 'SEND_MESSAGE', text: bad } } });
  const review = { challenges: [{ id: 'C1', target: 'RECOMMENDATION', target_id: null, severity: 'HIGH',
    challenge: 'The draft asserts the car is still available and offers a time the seller never stated.', evidence: [{ type: 'MESSAGE', message_id: m2, quote: 'Can I see it on Saturday' }] }],
    verdict: 'REJECT_RECOMMENDATION', verdict_rationale: 'Unverified operational claims in the draft.' };
  const r = await run(c, new FakeProvider({ ANALYST: ok(answer), REVIEWER: ok(review) }));
  expect(r).toMatchObject({ outcome: 'COMPLETED', code: 'RECOMMENDATION_REJECTED_BY_REVIEW' });
  const a = row(r.analysisId!);
  expect(a.output.recommendation).toEqual(REJECTED_RECOMMENDATION);
  expect([a.ai_classification, a.ai_proposed_message]).toEqual([null, null]);
  expect(JSON.stringify(a.output.recommendation)).not.toContain('still here');
});

test('KNOWN GAP (documented, not fixed): if the AI reviewer upholds it, a draft asserting unverified availability passes the contract and reaches the founder unchanged', async () => {
  // Nothing deterministic inspects draft wording. Only the founder's review stands between this draft and the business.
  const { c, m1, m2 } = textCase();
  const bad = 'Good morning. The car is still here. Would Saturday at 10 suit you for a viewing?';
  const answer = analystAnswer(m1, m2, { recommendation: { pursue: 'PURSUE', strategy: 'BUYER SIGNAL: asked to view. NEXT MOVE: offer Saturday.',
    psychological_rationale: 'WHY THIS MOVE: turns interest into a visit.', based_on_hypotheses: ['H1'], next_action: { type: 'SEND_MESSAGE', text: bad } } });
  const r = await run(c, new FakeProvider({ ANALYST: ok(answer), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) }));
  expect(r).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  expect(row(r.analysisId!).ai_proposed_message).toBe(bad);
});

/** The v5 live failure (DASH-PAID-20261108131559): a fourth, evidence-free competing hypothesis. */
function fourHypotheses(m1: string, m2: string, h4Supporting: string[]) {
  return analystAnswer(m1, m2, {
    hypotheses: [
      { id: 'H1', category: 'DECISION_FRICTION', statement: 'Wants to view the car before deciding.', basis: 'STATED_BY_PROSPECT',
        supporting_observations: ['O2'], contradicting_observations: [], competing_hypotheses: [], confidence: 'MEDIUM', uncertainty: 'No visit was fixed.' },
      { id: 'H2', category: 'TRUST_AND_RISK', statement: 'The price may feel high for the value seen.', basis: 'HYPOTHESIS',
        supporting_observations: ['O1'], contradicting_observations: [], competing_hypotheses: ['H3', 'H4'], confidence: 'LOW', uncertainty: 'No target price given.' },
      { id: 'H3', category: 'SELLER_CREATED_RESISTANCE', statement: 'The flat price reply may have discouraged the prospect.', basis: 'HYPOTHESIS',
        supporting_observations: ['O1'], contradicting_observations: ['O2'], competing_hypotheses: ['H2'], confidence: 'LOW', uncertainty: 'They still asked to view.' },
      { id: 'H4', category: 'BUYING_MOTIVATION', statement: 'The prospect may have bought a car elsewhere.', basis: 'HYPOTHESIS',
        supporting_observations: h4Supporting, contradicting_observations: [], competing_hypotheses: ['H2'], confidence: 'UNKNOWN', uncertainty: 'Nothing in the chat shows this.' },
    ],
  });
}

test('REGRESSION v5 live failure: an evidence-free competing hypothesis is rejected by the real contract with the exact message; both calls billed; nothing kept', async () => {
  const { c, m1, m2 } = textCase();
  const provider = new FakeProvider({ ANALYST: ok(fourHypotheses(m1, m2, [])), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) });
  const r = await run(c, provider);
  expect(r).toMatchObject({ outcome: 'REJECTED', code: 'CONTRACT_REJECTED' });
  const a = row(r.analysisId!);
  expect(a.status).toBe('ERROR');
  expect(a.error).toBe('REJECTED by analysis contract rre-analysis/1: hypotheses[3] rests on no observation; record it as an unknown instead');
  expect([a.output, a.ai_proposed_message, a.ai_classification]).toEqual([null, null, null]); // validation is not weakened, nothing repaired or kept
  expect(provider.requests.map((x) => x.role)).toEqual(['ANALYST', 'REVIEWER']); // the contract runs after both calls: two billed calls, no retry
  expect(spend(r.analysisId!)).toBe('SETTLED:REPORTED_USAGE:0.0210'); // usage of both calls settled, nothing left reserved
  expect([a.input_tokens, a.output_tokens]).toEqual([2000, 1000]);
  expect(caseState(c)).toBe('SUBMITTED'); // the case returns to its prior state
});

test('REGRESSION v5 corrected form: the same possibility recorded under unknowns (not as a hypothesis) passes the real contract', async () => {
  const { c, m1, m2 } = textCase();
  const answer = fourHypotheses(m1, m2, []);
  answer.hypotheses = answer.hypotheses.slice(0, 3).map((h) => ({ ...h, competing_hypotheses: h.competing_hypotheses.filter((x: string) => x !== 'H4') }));
  answer.unknowns = [...answer.unknowns, { question: 'Has the prospect bought a car elsewhere?', why_it_matters: 'Nothing in the chat shows it; if so, no follow-up helps.' }];
  const r = await run(c, new FakeProvider({ ANALYST: ok(answer), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) }));
  expect(r).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  const out = row(r.analysisId!).output;
  expect(out.hypotheses.every((h: { supporting_observations: string[] }) => h.supporting_observations.length > 0)).toBe(true);
  expect(out.unknowns.map((u: { question: string }) => u.question)).toContain('Has the prospect bought a car elsewhere?');
});

test('paid-diagnose (read-only) against the real schema: the rejected analysis\'s stored metadata, two dispatched calls, settled usage, no content', async () => {
  const { c, m1, m2 } = textCase();
  sql(`update public.cases set reference = 'DASH-PAID-DIAG' || floor(random() * 1e9)::text where id = :'c'`, { c });
  await run(c, new FakeProvider({ ANALYST: ok(fourHypotheses(m1, m2, [])), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) }));
  const raw = one(`select ${DIAGNOSE_SQL}`)!;
  const d = JSON.parse(raw);
  expect(d).toMatchObject({ status: 'ERROR', output_stored: false, input_tokens: 2000, output_tokens: 1000, case_attempts_total: 1,
    error: 'REJECTED by analysis contract rre-analysis/1: hypotheses[3] rests on no observation; record it as an unknown instead' });
  expect(d.ledger).toMatchObject({ status: 'SETTLED', settled_by: 'REPORTED_USAGE', analyst_dispatched: true, reviewer_dispatched: true,
    analyst_tokens: [1000, 500], reviewer_tokens: [1000, 500] });
  for (const secret of [BODY1, BODY2, 'the price feels high', 'bought a car elsewhere', DRAFT]) expect(raw).not.toContain(secret);
});

test('v7 format: DECISION HYPOTHESIS / IF RIGHT, EXPECT / WOULD CHALLENGE IT fits psychological_rationale and passes the real contract', async () => {
  const { c, m1, m2 } = textCase();
  const answer = analystAnswer(m1, m2, { recommendation: { pursue: 'PURSUE',
    strategy: 'BUYER SIGNAL: the prospect asked "Can I see it on Saturday" after "the price feels high". VERIFY FIRST: that the car is still available and which Saturday times the seller can offer. NEXT MOVE: answer the viewing request once confirmed.',
    psychological_rationale: 'DECISION HYPOTHESIS: H1: still evaluating the car in person before deciding. WHY THIS MOVE: it answers the request they made and lets them judge the price against the car. IF RIGHT, EXPECT: they suggest a viewing time or ask about a Saturday slot. WOULD CHALLENGE IT: they raise the price again without mentioning the viewing, which would point to H2.',
    based_on_hypotheses: ['H1'], next_action: { type: 'SEND_MESSAGE', text: 'Thanks for asking about Saturday. Let me confirm the car and a viewing time for you today. What time of day usually suits you best?' } } });
  const r = await run(c, new FakeProvider({ ANALYST: ok(answer), REVIEWER: ok(reviewAnswer('UPHOLD', m1)) }));
  expect(r).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  const rec = row(r.analysisId!).output.recommendation;
  expect(rec.psychological_rationale).toMatch(/^DECISION HYPOTHESIS: H1: .+ WHY THIS MOVE: .+ IF RIGHT, EXPECT: .+ WOULD CHALLENGE IT: .+/);
  expect(rec.psychological_rationale.length).toBeLessThanOrEqual(1500);
});

test('WHY THE UI RULE IS NEEDED: the contract accepts UPHOLD_WITH_CONCERNS with a HIGH recommendation challenge and stores the draft as the proposed message', async () => {
  const { c, m1, m2 } = textCase();
  const bad = 'Good morning. The car is still here. Would Saturday at 10 suit you for a viewing?';
  const answer = analystAnswer(m1, m2, { recommendation: { pursue: 'PURSUE', strategy: 'BUYER SIGNAL: asked to view. NEXT MOVE: offer Saturday.',
    psychological_rationale: 'DECISION HYPOTHESIS: H1. WHY THIS MOVE: x. IF RIGHT, EXPECT: y. WOULD CHALLENGE IT: z.', based_on_hypotheses: ['H1'], next_action: { type: 'SEND_MESSAGE', text: bad } } });
  const review = { challenges: [{ id: 'C1', target: 'RECOMMENDATION', target_id: null, severity: 'HIGH',
    challenge: 'The draft asserts availability the seller never confirmed.', evidence: [] }], verdict: 'UPHOLD_WITH_CONCERNS', verdict_rationale: 'Concerns.' };
  const r = await run(c, new FakeProvider({ ANALYST: ok(answer), REVIEWER: ok(review) }));
  expect(r).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  expect(row(r.analysisId!).ai_proposed_message).toBe(bad); // stored; only src/live/analysis.ts proposedMessage() now withholds it
});
