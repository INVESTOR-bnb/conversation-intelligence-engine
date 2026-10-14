// Stage 2A-5d-4a — the analysis pipeline core (no real AI provider in this stage).
//
// Order of work, and why:
//  1. Restriction pre-check (founder's view, RLS): a restricted case is refused
//     before an analysis row exists or any provider is called.
//  2. founder_start_analysis: founder check, usable-evidence check, the per-case
//     lock and the frozen evidence snapshot all stay in the database.
//  3. The snapshot's own restriction list is checked again (a restriction added
//     between 1 and 2 is in the snapshot): still no provider call.
//  4. Evidence is loaded strictly from the snapshot and re-hashed.
//  4a. Stage 2A-5d-3b — spending: internal_reserve_ai_spend reserves the database's
//     own estimate (refused when spending is disabled, a model is unpriced, a rate
//     limit or the budget is reached). No reservation, no provider call.
//  Each call then: internal_ai_dispatch is recorded (committed) BEFORE the request —
//  if that fails or its outcome is unknown, nothing is sent; the request uses the
//  database-approved model and output cap; the provider's usage is reported with
//  internal_ai_report_usage only when the provider returned valid counts. A call
//  that fails, times out or returns no usable counts is never reported as zero:
//  completion then settles the reservation as HELD (potentially billable) until an
//  administrator reconciles it. Providers never retry (maxRetries: 0).
//  4b. Stage 2A-6b — the reservation's terms (internal_ai_reservation_terms) must match
//     what this run will send, or nothing is dispatched (SPEND_TERMS_MISMATCH):
//     the reservation is RESERVED; each call's model and output cap equal the
//     reservation's and the configuration's; the snapshotted prices equal the prices
//     this code expects for that model; the cap is within the model's own maximum;
//     and the worst case of both calls (input bound x input price + cap x output
//     price) is covered by the reserved amount.
//     Any refusal so far happens before the dispatch record: no conversation data has left,
//     and the reservation settles at USD 0 (NO_DISPATCH).
//     Stage 2A-6c — a priced call needs a provider that can count its input
//     (TOKEN_COUNT_UNAVAILABLE_<ROLE>, before dispatch). Counting sends the conversation to
//     the provider, so it happens only AFTER the committed dispatch record: every request
//     that carries conversation data, counted or generated, is on the ledger. The exact
//     request's input is counted with the provider's free count_tokens endpoint (no
//     generation) and, with a 10% margin for the estimate, must fit the reserved input bound
//     (INPUT_EXCEEDS_RESERVATION_<ROLE>; a failed or hung count: TOKEN_COUNT_FAILED_<ROLE>).
//     On either refusal no generation request was ever made, and counting is free, so the
//     call's usage is reported as 0/0: the reservation settles at USD 0 with the dispatch
//     (the disclosure) recorded. If even that report fails, the reservation is HELD.
//     After a call: usage is reported first, then the answer is judged — an input count
//     above the bound, an output above the cap, a refusal, a cut-off answer, invalid JSON
//     or an answer outside the schema each fail closed (the billed usage stays recorded).
//  5. Call A, the forensic analyst. 6. Call B, the adversarial reviewer: a
//     separate request with its own instructions, given the evidence and the
//     analyst's output as data (never the analyst's instructions or reasoning).
//  7. Merge into rre-analysis/2. The reviewer's verdict is stored unchanged. If it
//     is REJECT_RECOMMENDATION, every contact instruction and message is removed
//     deterministically and the replacement says why (the rejection is visible).
//  8. internal_complete_analysis (service role) — the database contract decides.
//
// From step 2 on, every path ends by recording the analysis (as ERROR on any
// failure, which releases the lock and restores the case). If even that fails,
// founder_abandon_analysis is tried; if that fails too the result is LOCK_HELD.
// Both release paths settle spending in the database from the dispatch record: a
// lock is released without ever releasing money for a call that may have been sent.
//
// LIMIT (documented, not solved here): if the host kills the run (a hard
// wall-clock limit, a crash, an out-of-memory kill), no code runs at all and the
// analysis stays PENDING, holding the case's lock. The pipeline keeps its own
// deadline below the host limit and reserves time for step 8 so this is rare,
// but it cannot be ruled out. Recovery: founder_abandon_analysis(analysis_id)
// (SQL editor until the founder UI has an Abandon control).
//
// Logs carry event names, ids, codes and counts only — never evidence, model
// output, provider error text or credentials. The result returned to the
// caller (the founder's browser) carries no analysis content either.

import { loadEvidence, PipelineFailure, snapshotRestricted } from './evidence.ts';
import { analystContent, ANALYST_SYSTEM, PROMPT_VERSION, reviewerContent, REVIEWER_SYSTEM } from './prompts.ts';
import { ANALYST_SCHEMA, REVIEWER_SCHEMA } from './schemas.ts';
import { schemaProblems, validateOutput } from './structuredOutput.ts';
import {
  DbError, ProviderCallError, type ApprovedCall, type CompletionParams, type ModelConfig, type PipelineConfig, type PipelineDeps,
  type PipelineResult, type ProviderRequest, type ProviderResponse, type ReservationTerms, type Role, type SpendReservation, type TermsCall,
} from './types.ts';

export { PROMPT_VERSION };

const VERDICTS = ['UPHOLD', 'UPHOLD_WITH_CONCERNS', 'REJECT_RECOMMENDATION'] as const;
const CLASSIFICATIONS = ['GREEN', 'YELLOW', 'RED'] as const;
const KNOWN_STOPS = ['max_tokens', 'refusal', 'pause_turn', 'tool_use', 'stop_sequence', 'model_context_window_exceeded'];
/**
 * Start errors passed through as codes (the database raises "<CODE>: <text>"); anything else is
 * START_FAILED. An analysis already running on the case shows as INVALID_STATE (case is ANALYZING).
 */
const START_CODES = ['INSUFFICIENT_EVIDENCE', 'INVALID_STATE', 'FORBIDDEN', 'NOT_FOUND'];
/** Reservation refusals passed through as codes; anything else is SPEND_RESERVATION_FAILED. */
const SPEND_CODES = ['SPENDING_DISABLED', 'BUDGET_EXCEEDED', 'RATE_LIMITED', 'MODEL_NOT_PRICED', 'RESERVATION_TOO_LARGE'];
/** The database accepts 0..10,000,000 tokens per count. */
const MAX_TOKENS = 10_000_000;
/** count_tokens is an estimate ("may differ by a small amount"): the bound must hold with this margin. */
export const INPUT_COUNT_MARGIN = 1.1;
/** Longest wait for a token count (it generates nothing; a slow count just refuses the call). */
const COUNT_TIMEOUT_MS = 10_000;

/** What replaces a recommendation the independent review rejected. States the reason; contains no contact. */
export const REJECTED_RECOMMENDATION = {
  pursue: 'UNKNOWN',
  strategy: 'UNKNOWN',
  psychological_rationale: 'UNKNOWN',
  based_on_hypotheses: [],
  next_action: {
    type: 'WAIT',
    text: 'No contact. The independent adversarial review rejected the original recommendation, so its contact '
      + 'instructions and draft message were removed. See the review before deciding anything.',
  },
} as const;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

interface Usage { inputTokens: number; outputTokens: number; costUsd: number }

export async function runAnalysisPipeline(caseId: string, deps: PipelineDeps): Promise<PipelineResult> {
  const { founderDb, serviceDb, provider, logger, config } = deps;
  const now = config.now ?? (() => Date.now());
  const startedAt = now();
  const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const model = `analyst:${config.analyst.model}|reviewer:${config.reviewer.model}`.slice(0, 100);
  let detected: CompletionParams['detectedRestrictions'] = [];
  let reservation: SpendReservation | null = null;
  let terms: ReservationTerms | null = null;

  // ---- 0. a provider that may retry could send unrecorded, unreserved requests
  if ((provider as { maxRetries?: unknown }).maxRetries !== 0) return refused('PROVIDER_RETRIES_NOT_DISABLED');
  // a schema the provider would reject (or only partly enforce) is never sent
  if (schemaProblems(ANALYST_SCHEMA).length > 0 || schemaProblems(REVIEWER_SCHEMA).length > 0) return refused('SCHEMA_UNSUPPORTED');

  // ---- 1. restriction pre-check (no analysis row, no provider call)
  try {
    if ((await founderDb.activeRestrictionCount(caseId)) > 0) return refused('CONTACT_RESTRICTED');
  } catch {
    return refused('PRECHECK_FAILED');
  }

  // ---- 2. start through the existing founder-authorised database function
  let analysisId: string;
  try {
    analysisId = await founderDb.startAnalysis(caseId);
  } catch (e) {
    return refused(startCode(e));
  }
  logger.event('pipeline.started', { analysisId });

  // ---- 3-8. from here every path records the analysis
  let reviewerVerdict: string | null = null;
  try {
    const record = await founderDb.getAnalysis(analysisId);
    if (!record || record.id !== analysisId || record.caseId !== caseId || record.status !== 'PENDING') {
      throw new PipelineFailure('ANALYSIS_NOT_PENDING');
    }
    if (snapshotRestricted(record.evidenceManifest)) throw new PipelineFailure('CONTACT_RESTRICTED');
    const evidence = await loadEvidence(founderDb, record, config.maxScreenshotBytes);
    if (config.textOnly && evidence.screenshots.length > 0) throw new PipelineFailure('PAID_PROVIDER_TEXT_ONLY');

    // 4a: reserve before any provider request (the database computes the amount)
    deadline('ANALYST', 1);
    reservation = await reserve();
    // 4b: the reservation's full terms must match what will be sent
    terms = await readTerms(reservation);

    // A: forensic analyst
    const analyst = parseAnalyst(await call('ANALYST', config.analyst, ANALYST_SYSTEM, analystContent(evidence), ANALYST_SCHEMA));
    detected = analyst.detected;

    // B: adversarial reviewer — a separate request; sees the analyst's output as data only
    const review = parseReviewer(await call('REVIEWER', config.reviewer, REVIEWER_SYSTEM,
      reviewerContent(evidence, reviewInput(analyst)), REVIEWER_SCHEMA));
    reviewerVerdict = review.verdict as string;

    const merged = merge(analyst, review);
    deadline('BEFORE_COMPLETION', 0);
    await serviceDb.completeAnalysis({
      analysisId, status: analyst.status, model, promptVersion: PROMPT_VERSION, output: merged.output,
      classification: merged.classification, proposedMessage: merged.proposedMessage, detectedRestrictions: detected,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: cost(), error: null,
    });
  } catch (e) {
    const code = e instanceof PipelineFailure ? e.code : 'INTERNAL_ERROR';
    return recordFailure(analysisId, code);
  }

  // The contract does not throw on rejection: it records ERROR. Read what was stored.
  try {
    const stored = await founderDb.getAnalysis(analysisId);
    if (stored?.status === 'COMPLETE' || stored?.status === 'INSUFFICIENT_EVIDENCE') {
      const code = reviewerVerdict === 'REJECT_RECOMMENDATION' ? 'RECOMMENDATION_REJECTED_BY_REVIEW' : 'OK';
      logger.event('pipeline.completed', { analysisId, code, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      return { outcome: 'COMPLETED', code, analysisId };
    }
    if (stored?.status === 'ERROR') {
      const rejected = (stored.error ?? '').startsWith('REJECTED');
      const code = rejected ? 'CONTRACT_REJECTED' : (stored.error ?? '').startsWith('STALE') ? 'STALE_EVIDENCE' : 'RECORDED_AS_ERROR';
      logger.event('pipeline.rejected', { analysisId, code });
      return { outcome: rejected ? 'REJECTED' : 'FAILED', code, analysisId };
    }
  } catch {
    // fall through: the state is unknown
  }
  return recordFailure(analysisId, 'COMPLETION_UNCONFIRMED');

  // ------------------------------------------------------------------ helpers

  /** Reserves spending; only a valid reservation for exactly the configured models is used. */
  async function reserve(): Promise<SpendReservation> {
    let r: SpendReservation;
    try {
      r = await serviceDb.reserveSpend(analysisId, config.analyst.model, config.reviewer.model);
    } catch (e) {
      const dbCode = e instanceof DbError ? e.code : null;
      logger.event('spend.refused', { analysisId, dbCode });
      throw new PipelineFailure(dbCode !== null && SPEND_CODES.includes(dbCode) ? dbCode : 'SPEND_RESERVATION_FAILED');
    }
    if (!r || !Number.isFinite(r.reservedUsd) || r.reservedUsd < 0 || !approvedFor(r.analyst, config.analyst)
        || !approvedFor(r.reviewer, config.reviewer)) {
      throw new PipelineFailure('SPEND_RESERVATION_INVALID');
    }
    logger.event('spend.reserved', { analysisId, reservedUsd: r.reservedUsd });
    return r;
  }

  /** Reads the reservation's terms; any mismatch with this run refuses it before the first dispatch. */
  async function readTerms(r: SpendReservation): Promise<ReservationTerms> {
    let t: ReservationTerms;
    try {
      t = await serviceDb.reservationTerms(analysisId);
    } catch (e) {
      logger.event('spend.terms_unavailable', { analysisId, dbCode: e instanceof DbError ? e.code : null });
      throw new PipelineFailure('SPEND_TERMS_UNAVAILABLE');
    }
    const problem = termsProblem(t, analysisId, r, config);
    if (problem) {
      logger.event('spend.terms_mismatch', { analysisId, check: problem });
      throw new PipelineFailure('SPEND_TERMS_MISMATCH');
    }
    return t;
  }

  /**
   * Counts the exact request's input tokens without sending it for generation. Required for a
   * priced call; a call that cannot be counted, or whose count (with the margin) exceeds the
   * reserved input bound, is refused before its dispatch record.
   */
  async function checkInput(role: Role, request: Omit<ProviderRequest, 'signal'>, bound: TermsCall): Promise<void> {
    if (!provider.countInputTokens) return; // a priced call without a counter was refused before its dispatch
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let counted: number | null;
    try {
      counted = tokenCount(await Promise.race([
        provider.countInputTokens({ ...request, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('count timeout')); }, Math.min(COUNT_TIMEOUT_MS, deadline(role, 1)));
        }),
      ]));
    } catch {
      counted = null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (counted === null) {
      logger.event('spend.input_count_failed', { analysisId, role });
      throw new PipelineFailure(`TOKEN_COUNT_FAILED_${role}`);
    }
    const ok = Math.ceil(counted * INPUT_COUNT_MARGIN) <= bound.inputBound;
    logger.event('spend.input_counted', { analysisId, role, inputTokens: counted, inputBound: bound.inputBound, ok });
    if (!ok) throw new PipelineFailure(`INPUT_EXCEEDS_RESERVATION_${role}`);
  }

  function refused(code: string): PipelineResult {
    logger.event('pipeline.refused', { code });
    return { outcome: 'NOT_STARTED', code, analysisId: null };
  }

  function cost(): number {
    return Math.round(usage.costUsd * 10000) / 10000;
  }

  /** Throws DEADLINE if less than the completion reserve (plus `need`) remains. */
  function deadline(phase: string, need: number): number {
    const left = config.deadlineMs - (now() - startedAt) - config.completionReserveMs;
    if (left < need) throw new PipelineFailure(`DEADLINE_${phase}`);
    return left;
  }

  async function call(role: Role, m: ModelConfig, system: string, content: ReturnType<typeof analystContent>,
    schema: Record<string, unknown>): Promise<unknown> {
    const approved = role === 'ANALYST' ? reservation!.analyst : reservation!.reviewer;
    const bound = role === 'ANALYST' ? terms!.analyst : terms!.reviewer;
    deadline(role, 1);
    // A priced call must be countable before anything is recorded or sent.
    if ((bound.inputUsdPerMTok > 0 || bound.outputUsdPerMTok > 0) && !provider.countInputTokens) {
      throw new PipelineFailure(`TOKEN_COUNT_UNAVAILABLE_${role}`);
    }
    // The dispatch record is committed before anything can leave. If it fails or its outcome is
    // unknown, nothing is sent (should it have committed, the database holds the reservation).
    let dispatched: ApprovedCall;
    try {
      dispatched = await serviceDb.recordDispatch(analysisId, role);
    } catch (e) {
      logger.event('spend.dispatch_failed', { analysisId, role, dbCode: e instanceof DbError ? e.code : null });
      throw new PipelineFailure(`DISPATCH_FAILED_${role}`);
    }
    if (dispatched?.model !== approved.model || dispatched?.maxOutputTokens !== approved.maxOutputTokens || approved.model !== m.model) {
      throw new PipelineFailure(`DISPATCH_MISMATCH_${role}`);
    }
    // Count the exact request (it carries the conversation: hence after the dispatch record).
    try {
      await checkInput(role, { role, model: approved.model, system, content, schema, maxOutputTokens: approved.maxOutputTokens }, bound);
    } catch (e) {
      // No generation request was made and counting is free: the call's usage is exactly 0/0.
      try {
        await serviceDb.reportUsage(analysisId, role, 0, 0);
      } catch (r) {
        logger.event('spend.usage_report_failed', { analysisId, role, dbCode: r instanceof DbError ? r.code : null });
      }
      throw e;
    }
    const timeout = Math.min(config.callTimeoutMs, deadline(role, 1));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t0 = now();
    let response: ProviderResponse;
    try {
      response = await Promise.race([
        provider.call({ role, model: approved.model, system, content, schema, maxOutputTokens: approved.maxOutputTokens, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new PipelineFailure(`PROVIDER_TIMEOUT_${role}`)); }, timeout);
        }),
      ]);
    } catch (e) {
      // Usage unknown: the request may have reached the provider. Nothing is reported, so the
      // reservation is held (potentially billable) until reconciliation — whatever the error
      // says (even an HTTP error is not taken as proof that nothing was billed).
      const pe = e instanceof ProviderCallError ? e : null;
      logger.event('provider.call', { analysisId, role, ok: false, ms: now() - t0, usageKnown: false,
        errorKind: pe ? pe.kind : e instanceof PipelineFailure ? 'TIMEOUT' : 'OTHER', httpStatus: pe?.httpStatus ?? null,
        requestId: safeId(pe?.requestId) });
      throw e instanceof PipelineFailure ? e : new PipelineFailure(`PROVIDER_ERROR_${role}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const inTok = tokenCount(response?.inputTokens);
    const outTok = tokenCount(response?.outputTokens);
    if (inTok === null || outTok === null) {
      logger.event('provider.call', { analysisId, role, ok: false, ms: now() - t0, usageKnown: false });
      throw new PipelineFailure(`PROVIDER_USAGE_UNKNOWN_${role}`);
    }
    const stop = typeof response?.stopReason === 'string' ? response.stopReason : 'missing';
    logger.event('provider.call', { analysisId, role, ok: stop === 'end_turn', ms: now() - t0, inputTokens: inTok, outputTokens: outTok,
      stopReason: stop === 'end_turn' || KNOWN_STOPS.includes(stop) ? stop : 'other', requestId: safeId(response.requestId) });
    // Billed whatever the answer turns out to be: report before judging it.
    try {
      await serviceDb.reportUsage(analysisId, role, inTok, outTok);
    } catch (e) {
      logger.event('spend.usage_report_failed', { analysisId, role, dbCode: e instanceof DbError ? e.code : null });
      throw new PipelineFailure(`USAGE_REPORT_FAILED_${role}`);
    }
    usage.inputTokens += inTok;
    usage.outputTokens += outTok;
    usage.costUsd += (inTok * m.inputPerMTok + outTok * m.outputPerMTok) / 1_000_000;
    if (outTok > approved.maxOutputTokens) throw new PipelineFailure(`PROVIDER_LIMIT_EXCEEDED_${role}`);
    if (inTok > bound.inputBound) throw new PipelineFailure(`PROVIDER_INPUT_EXCEEDED_${role}`);
    if (stop === 'refusal') throw new PipelineFailure(`PROVIDER_REFUSED_${role}`);
    if (stop !== 'end_turn') throw new PipelineFailure(`PROVIDER_INCOMPLETE_${role}`);
    if (typeof response.text !== 'string') throw new PipelineFailure(`INVALID_JSON_${role}`);
    let value: unknown;
    try {
      value = JSON.parse(response.text);
    } catch {
      throw new PipelineFailure(`INVALID_JSON_${role}`);
    }
    const off = validateOutput(value, schema);
    if (off !== null) {
      logger.event('provider.schema_invalid', { analysisId, role, path: off.slice(0, 120) });
      throw new PipelineFailure(`SCHEMA_INVALID_${role}`);
    }
    return value;
  }

  /**
   * Records the failure as ERROR (releases the lock, restores the case, keeps any
   * restriction the analyst detected). If that fails, tries founder_abandon_analysis.
   */
  async function recordFailure(id: string, code: string): Promise<PipelineResult> {
    try {
      await serviceDb.completeAnalysis({
        analysisId: id, status: 'ERROR', model, promptVersion: PROMPT_VERSION, output: null, classification: null,
        proposedMessage: null, detectedRestrictions: detected, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        estimatedCostUsd: cost(), error: `PIPELINE_ERROR: ${code}`,
      });
      logger.event('pipeline.failed', { analysisId: id, code, restrictionsKept: detected.length });
      return { outcome: 'FAILED', code, analysisId: id };
    } catch (e) {
      // Already recorded (e.g. completed, or the success call committed before a network error)?
      try {
        const stored = await founderDb.getAnalysis(id);
        if (stored && stored.status !== 'PENDING') {
          logger.event('pipeline.failed', { analysisId: id, code, alreadyRecorded: true });
          return { outcome: stored.status === 'ERROR' ? 'FAILED' : 'COMPLETED', code: stored.status === 'ERROR' ? code : 'OK', analysisId: id };
        }
      } catch {
        // unknown; try to release below
      }
      logger.event('pipeline.record_failed', { analysisId: id, code, dbCode: e instanceof DbError ? e.code : null });
      try {
        await founderDb.abandonAnalysis(id);
        logger.event('pipeline.abandoned', { analysisId: id, code, restrictionsNotRecorded: detected.length });
        return { outcome: 'FAILED', code: `${code}_ABANDONED`, analysisId: id };
      } catch {
        logger.event('pipeline.lock_held', { analysisId: id, code, restrictionsNotRecorded: detected.length });
        return { outcome: 'LOCK_HELD', code, analysisId: id };
      }
    }
  }
}

// ------------------------------------------------------------------ pure parts (exported for tests)

/** A provider-reported token count, or null when it is not a plausible count (usage then counts as unknown). */
export function tokenCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKENS ? v : null;
}

/** A provider request id fit for a log line (opaque, short, no spaces), or null. */
function safeId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null;
}

const price = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_TOKENS;

/**
 * Why the reservation's terms do not cover this run (a short fixed label), or null when they do.
 * Exported for tests. Prices are compared exactly: the database snapshots them as numeric(12,6).
 */
export function termsProblem(t: ReservationTerms | null | undefined, analysisId: string, r: SpendReservation,
  config: Pick<PipelineConfig, 'analyst' | 'reviewer'>): string | null {
  if (!t || typeof t !== 'object') return 'MISSING';
  if (t.analysisId !== analysisId) return 'ANALYSIS';
  if (t.status !== 'RESERVED') return 'STATUS';
  if (!price(t.reservedUsd) || t.reservedUsd !== r.reservedUsd) return 'RESERVED_USD';
  const pairs: [string, TermsCall, ApprovedCall, ModelConfig][] = [['ANALYST', t.analyst, r.analyst, config.analyst], ['REVIEWER', t.reviewer, r.reviewer, config.reviewer]];
  let worst = 0;
  for (const [role, c, a, m] of pairs) {
    if (!c || typeof c !== 'object') return `${role}_MISSING`;
    if (c.model !== a.model || c.model !== m.model) return `${role}_MODEL`;
    if (!count(c.maxOutputTokens) || c.maxOutputTokens !== a.maxOutputTokens) return `${role}_OUTPUT_CAP`;
    if (m.maxOutputTokens !== undefined && c.maxOutputTokens > m.maxOutputTokens) return `${role}_CAP_ABOVE_MODEL_MAXIMUM`;
    if (m.approvedOutputCap !== undefined && c.maxOutputTokens !== m.approvedOutputCap) return `${role}_CAP_NOT_APPROVED`;
    if (!count(c.inputBound)) return `${role}_INPUT_BOUND`;
    if (!price(c.inputUsdPerMTok) || !price(c.outputUsdPerMTok)) return `${role}_PRICE_INVALID`;
    if (c.inputUsdPerMTok !== m.inputPerMTok || c.outputUsdPerMTok !== m.outputPerMTok) return `${role}_PRICE`;
    worst += c.inputBound * c.inputUsdPerMTok + c.maxOutputTokens * c.outputUsdPerMTok;
  }
  // The database rounds the reservation up to 4 decimals; it must cover the worst case of both calls.
  if (Math.ceil(worst / 100 - 1e-6) / 10000 > t.reservedUsd + 1e-9) return 'NOT_COVERED';
  return null;
}

function approvedFor(a: ApprovedCall | undefined, m: ModelConfig): boolean {
  return !!a && a.model === m.model && Number.isSafeInteger(a.maxOutputTokens) && a.maxOutputTokens > 0;
}

export function startCode(e: unknown): string {
  const raw = e instanceof DbError ? e.code : '';
  return START_CODES.includes(raw) ? raw : 'START_FAILED';
}

export interface AnalystResult {
  status: 'COMPLETE' | 'INSUFFICIENT_EVIDENCE';
  classification: 'GREEN' | 'YELLOW' | 'RED' | null;
  /** The rre-analysis/1 body (everything except analysis_status and classification). */
  body: Record<string, unknown>;
  detected: CompletionParams['detectedRestrictions'];
}

/** The analyst's answer: only what the merge needs is checked here; the database contract checks the rest. */
export function parseAnalyst(value: unknown): AnalystResult {
  const o = obj(value);
  const rec = obj(o?.recommendation);
  const status = o?.analysis_status;
  const classification = o?.classification ?? null;
  if (!o || !rec || !obj(rec.next_action) || (status !== 'COMPLETE' && status !== 'INSUFFICIENT_EVIDENCE')
      || (classification !== null && !CLASSIFICATIONS.includes(classification as never))) {
    throw new PipelineFailure('INVALID_OUTPUT_ANALYST');
  }
  const { analysis_status: _s, classification: _c, ...body } = o;
  const detected = Array.isArray(body.contact_restrictions)
    ? body.contact_restrictions.map((r) => {
      const x = obj(r);
      return {
        kind: typeof x?.kind === 'string' ? x.kind.slice(0, 40) : 'OTHER',
        note: typeof x?.reason === 'string' ? x.reason.slice(0, 1000) : null,
        evidence: Array.isArray(x?.evidence) ? x.evidence : null,
      };
    })
    : [];
  return { status, classification: classification as AnalystResult['classification'], body, detected };
}

/** The reviewer's answer must be an adversarial_review with a known verdict; the contract checks the rest. */
export function parseReviewer(value: unknown): Record<string, unknown> {
  const o = obj(value);
  if (!o || !VERDICTS.includes(o.verdict as never) || !Array.isArray(o.challenges) || typeof o.verdict_rationale !== 'string') {
    throw new PipelineFailure('INVALID_OUTPUT_REVIEWER');
  }
  return o;
}

/** What the reviewer is shown: the analyst's output (with its classification), as data. */
export function reviewInput(analyst: AnalystResult): Record<string, unknown> {
  return { ...analyst.body, analysis_status: analyst.status, classification: analyst.classification };
}

/**
 * The rre-analysis/2 output. The review is stored exactly as the reviewer wrote it.
 * A rejected recommendation is replaced by REJECTED_RECOMMENDATION (no contact, says
 * why) unless it already was DO_NOT_PURSUE; either way no proposed message remains.
 */
export function merge(analyst: AnalystResult, review: Record<string, unknown>): {
  output: Record<string, unknown>; classification: AnalystResult['classification']; proposedMessage: string | null;
} {
  const output: Record<string, unknown> = { ...analyst.body, contract_version: 'rre-analysis/2', adversarial_review: review };
  const rec = obj(output.recommendation)!;
  const nextAction = obj(rec.next_action)!;
  let classification = analyst.classification;
  let proposedMessage = nextAction.type === 'SEND_MESSAGE' && typeof nextAction.text === 'string' ? nextAction.text : null;
  if (review.verdict === 'REJECT_RECOMMENDATION') {
    proposedMessage = null;
    if (rec.pursue !== 'DO_NOT_PURSUE') {
      output.recommendation = structuredClone(REJECTED_RECOMMENDATION);
      classification = null;
    }
  }
  return { output, classification, proposedMessage };
}
