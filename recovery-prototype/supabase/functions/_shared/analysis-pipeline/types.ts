// Stage 2A-5d-4a — analysis pipeline core: the interfaces it runs against.
//
// The core is plain TypeScript (no Deno, Node or SDK imports) so the same files
// run in a Supabase Edge Function (Deno) and in the local test suite (Node).
// Everything with side effects is injected:
//   FounderDb  — reads and the analysis lock, run AS THE FOUNDER (the caller's
//                JWT). Row level security applies: founder-only data.
//   ServiceDb  — exactly one call, internal_complete_analysis, which needs the
//                service role. Nothing else uses the service role.
//   AnalysisProvider — one model call. No real provider exists in this stage.
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

/** Runs with the service role. Its only job: public.internal_complete_analysis. */
export interface ServiceDb {
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
  /** 'end_turn' is the only acceptable stop; anything else (max_tokens, refusal, ...) fails closed. */
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AnalysisProvider {
  call(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface PipelineLogger {
  /** Only an event name and non-sensitive fields (ids, codes, counts). */
  event(name: string, fields?: Record<string, string | number | boolean | null>): void;
}

export interface ModelConfig {
  model: string;
  maxOutputTokens: number;
  /** Price per million tokens, for analyses.estimated_cost_usd (0 for the fake provider). */
  inputPerMTok: number;
  outputPerMTok: number;
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
