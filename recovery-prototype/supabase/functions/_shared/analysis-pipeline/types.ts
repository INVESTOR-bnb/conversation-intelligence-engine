// Stage 2A-5d-4a — analysis pipeline core: the interfaces it runs against.
//
// The core is plain TypeScript (no Deno, Node or SDK imports) so the same files
// run in a Supabase Edge Function (Deno) and in the local test suite (Node).
// Everything with side effects is injected:
//   FounderDb  — reads and the analysis lock, run AS THE FOUNDER (the caller's
//                JWT). Row level security applies: founder-only data.
//   ServiceDb  — the service-role calls: the spending controls (reserve,
//                dispatch, usage; Stage 2A-5d-3b) and internal_complete_analysis.
//                Nothing else uses the service role.
//   AnalysisProvider — one model call, never retried. Stage 2A-6b: the fake, or the
//                Anthropic adapter (edge/anthropicProvider.ts), chosen by configuration.
//   PipelineLogger   — receives event names and codes only, never content.

export type Role = 'ANALYST' | 'REVIEWER';

/** A database error: `code` is the P0001 code our functions raise (e.g. INSUFFICIENT_EVIDENCE). */
export class DbError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

export interface AnalysisRecord {
  id: string;
  caseId: string;
  status: 'PENDING' | 'COMPLETE' | 'INSUFFICIENT_EVIDENCE' | 'ERROR';
  evidenceVersion: number;
  /** The frozen evidence snapshot written by founder_start_analysis. */
  evidenceManifest: unknown;
  error: string | null;
}

export interface MessageRow { id: string; kind: string; body: string }
export interface ScreenshotFile { position: number; mimeType: string; bytes: Uint8Array }

/** Runs with the founder's own JWT (RLS applies). */
export interface FounderDb {
  /** Active contact restrictions on the case right now. */
  activeRestrictionCount(caseId: string): Promise<number>;
  /** public.founder_start_analysis: founder check, usable-evidence check, per-case lock, snapshot. */
  startAnalysis(caseId: string): Promise<string>;
  getAnalysis(analysisId: string): Promise<AnalysisRecord | null>;
  /** Messages of the case with these ids (only what RLS lets the founder read). */
  getMessages(caseId: string, ids: string[]): Promise<MessageRow[]>;
  /** The stored file of a case screenshot (by case_screenshots.id), or null if absent or deleted. */
  getScreenshotFile(caseId: string, screenshotId: string): Promise<ScreenshotFile | null>;
  /** public.founder_abandon_analysis: releases a PENDING analysis (the manual escape). */
  abandonAnalysis(analysisId: string): Promise<void>;
}

export interface CompletionParams {
  analysisId: string;
  status: 'COMPLETE' | 'INSUFFICIENT_EVIDENCE' | 'ERROR';
  model: string | null;
  promptVersion: string;
  output: Record<string, unknown> | null;
  classification: 'GREEN' | 'YELLOW' | 'RED' | null;
  proposedMessage: string | null;
  detectedRestrictions: { kind: string; note: string | null; evidence: unknown }[];
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  error: string | null;
}

/** A call the database approved: the model and the output cap the reservation priced. */
export interface ApprovedCall {
  model: string;
  maxOutputTokens: number;
}

/** public.internal_reserve_ai_spend's answer. */
export interface SpendReservation {
  reservedUsd: number;
  analyst: ApprovedCall;
  reviewer: ApprovedCall;
}

/** One call's terms exactly as the reservation recorded them (Stage 2A-6a, public.internal_ai_reservation_terms). */
export interface TermsCall {
  model: string;
  maxOutputTokens: number;
  /** The most input tokens the reservation priced for this call. */
  inputBound: number;
  /** The prices snapshotted at reservation, USD per million tokens. */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface ReservationTerms {
  analysisId: string;
  status: string;
  reservedUsd: number;
  analyst: TermsCall;
  reviewer: TermsCall;
}

/** Runs with the service role. */
export interface ServiceDb {
  /** public.internal_reserve_ai_spend: refuses (SPENDING_DISABLED, BUDGET_EXCEEDED, ...) or reserves the database's estimate. */
  reserveSpend(analysisId: string, analystModel: string, reviewerModel: string): Promise<SpendReservation>;
  /** public.internal_ai_reservation_terms (Stage 2A-6a): the reservation's full terms, read-only. */
  reservationTerms(analysisId: string): Promise<ReservationTerms>;
  /** public.internal_ai_dispatch: must succeed (committed) before the provider request; once per role. */
  recordDispatch(analysisId: string, role: Role): Promise<ApprovedCall>;
  /** public.internal_ai_report_usage: the provider's reported usage for one dispatched call; once per role. */
  reportUsage(analysisId: string, role: Role, inputTokens: number, outputTokens: number): Promise<void>;
  /** public.internal_complete_analysis: records the result and settles the reservation from the dispatch record. */
  completeAnalysis(params: CompletionParams): Promise<void>;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string };

export interface ProviderRequest {
  role: Role;
  model: string;
  system: string;
  /** One user turn. Evidence is inside it as delimited, untrusted data. */
  content: ContentPart[];
  /** JSON schema the answer must follow. */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ProviderResponse {
  /** The raw answer text; the pipeline parses it (invalid JSON fails closed). */
  text: string;
  /** The provider's request id, when it gave one (an opaque id for reconciliation; never content). */
  requestId?: string;
  /** 'end_turn' is the only acceptable stop; anything else (max_tokens, refusal, ...) fails closed. */
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One provider request per call() — no automatic retries anywhere (SDK maxRetries: 0, no
 * HTTP-level retry). A retry would be a second, unrecorded and unreserved billable request;
 * the database also refuses a second dispatch of the same role. `maxRetries` must be 0.
 */
export interface AnalysisProvider {
  readonly maxRetries: 0;
  call(request: ProviderRequest): Promise<ProviderResponse>;
  /**
   * The input tokens `call(request)` would be billed for, counted WITHOUT sending it for
   * generation (Anthropic: the free count_tokens endpoint). Required for any call whose
   * reserved prices are not zero: the pipeline refuses to dispatch a priced call it cannot
   * prove is inside the reservation's input bound. It carries the conversation to the
   * provider, so the pipeline calls it only after the call's dispatch record (Stage 2A-6c).
   */
  countInputTokens?(request: ProviderRequest): Promise<number>;
}

/** Why a provider call failed, as fixed values only (never provider text). */
export type ProviderErrorKind = 'HTTP' | 'TIMEOUT' | 'CONNECTION' | 'ABORTED' | 'MALFORMED_RESPONSE' | 'MODEL_MISMATCH' | 'PRICING_MISMATCH' | 'OTHER';

/**
 * A provider failure. It never says the request was free: after dispatch, every failure
 * leaves the usage unknown and the reservation HELD until an administrator reconciles it.
 */
export class ProviderCallError extends Error {
  readonly kind: ProviderErrorKind;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  constructor(kind: ProviderErrorKind, httpStatus: number | null = null, requestId: string | null = null) {
    super(`provider call failed: ${kind}${httpStatus === null ? '' : ` ${httpStatus}`}`);
    this.name = 'ProviderCallError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
}

export interface PipelineLogger {
  /** Only an event name and non-sensitive fields (ids, codes, counts). */
  event(name: string, fields?: Record<string, string | number | boolean | null>): void;
}

export interface ModelConfig {
  /** Must have an active price row in private.ai_model_prices; the output cap comes from there. */
  model: string;
  /** Price per million tokens, for analyses.estimated_cost_usd only (the spending ledger uses the database's prices). */
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * The model's own maximum output (Stage 2A-6b). A reservation whose approved cap is larger
   * is refused before dispatch. Omitted for the fake.
   */
  maxOutputTokens?: number;
  /**
   * Stage 2A-6c: the output cap this code approves for the model. The database's cap (the price
   * row, snapshotted in the reservation) must equal it, or the run is refused before dispatch
   * (SPEND_TERMS_MISMATCH): prices and caps cannot silently differ between database and code.
   */
  approvedOutputCap?: number;
}

export interface PipelineConfig {
  analyst: ModelConfig;
  reviewer: ModelConfig;
  /** Per provider call. */
  callTimeoutMs: number;
  /** Whole run, from the start. Must be well below the host's hard wall-clock limit. */
  deadlineMs: number;
  /** Time kept back at the end to record the result and release the lock. */
  completionReserveMs: number;
  /** Largest screenshot accepted, in bytes. */
  maxScreenshotBytes: number;
  /**
   * Stage 2A-6b: refuse evidence with screenshots before any reservation (PAID_PROVIDER_TEXT_ONLY).
   * Set for the paid provider: its first evaluation is synthetic text only.
   */
  textOnly?: boolean;
  now?: () => number;
}

export interface PipelineDeps {
  founderDb: FounderDb;
  serviceDb: ServiceDb;
  provider: AnalysisProvider;
  logger: PipelineLogger;
  config: PipelineConfig;
}

/**
 * What the caller (and so the founder's browser) receives. Deliberately no
 * analysis content: the founder reads that through RLS. `code` is one of the
 * fixed codes below, never provider or database text.
 */
export interface PipelineResult {
  outcome:
    | 'COMPLETED'            // stored as COMPLETE or INSUFFICIENT_EVIDENCE
    | 'NOT_STARTED'          // refused before any analysis row (restriction, no evidence, not the founder, busy)
    | 'FAILED'               // recorded as ERROR; lock released
    | 'REJECTED'             // the database contract rejected the output; recorded as ERROR; lock released
    | 'LOCK_HELD';           // could not record the failure: the analysis stays PENDING (use founder_abandon_analysis)
  code: string;
  analysisId: string | null;
}
