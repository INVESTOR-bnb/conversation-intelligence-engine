// Stage 2A-5d-4a — test-only database adapter: the pipeline's FounderDb and
// ServiceDb implemented with psql against the local test database, acting exactly
// as PostgREST would (role + JWT claims, so RLS and function grants apply).
// Every value is passed as a psql variable (:'name' quoting), never spliced into SQL.
// Storage is simulated: file bytes live in `storage` keyed by storage path; the
// object's metadata row is the real case_screenshots row read with the founder's RLS.

import { execFileSync } from 'node:child_process';
import {
  DbError, type AnalysisRecord, type ApprovedCall, type CompletionParams, type FounderDb, type MessageRow, type Role, type ScreenshotFile,
  type ServiceDb, type SpendReservation,
} from '../../supabase/functions/_shared/analysis-pipeline/index.ts';

const HOST = process.env.PIPELINE_PGHOST;
const PORT = process.env.PIPELINE_PGPORT;
const PSQL = process.env.PIPELINE_PSQL ?? 'psql';

export const FOUNDER = '00000000-0000-4000-8000-00000000000f';
export const CLIENT_A = '00000000-0000-4000-8000-00000000000a';
export const CLIENT_B = '00000000-0000-4000-8000-00000000000b';
export const BIZ_A = '10000000-0000-4000-8000-00000000000a';

export type As = { role: 'authenticated'; sub: string } | { role: 'service_role'; claims?: Record<string, unknown> } | { role: 'anon' } | null;

/** Runs SQL (as the given caller) and returns the output rows (-At). Throws DbError with the raised code. */
export function sql(text: string, vars: Record<string, string> = {}, as: As = null): string[] {
  if (!HOST || !PORT) throw new Error('run through supabase/scripts/test-pipeline-db.sh');
  const prefix = as === null ? '' : as.role === 'anon'
    ? `select set_config('request.jwt.claims', '{"role":"anon"}', false) \\g /dev/null\nset role anon;\n`
    : `select set_config('request.jwt.claims', :'__claims', false) \\g /dev/null\nset role ${as.role};\n`;
  const allVars: Record<string, string> = { ...vars };
  if (as && as.role !== 'anon') allVars.__claims = JSON.stringify(as.role === 'service_role' ? (as.claims ?? { role: 'service_role' }) : { sub: as.sub, role: 'authenticated' });
  const args = ['-h', HOST, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(allVars)) args.push('-v', `${k}=${v}`);
  try {
    const out = execFileSync(PSQL, args, { input: prefix + text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out.split('\n').filter((l) => l !== '');
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    const m = /ERROR:\s+([A-Z_]+):/.exec(stderr);
    const first = stderr.split('\n').find((l) => l.includes('ERROR:')) ?? stderr.trim().split('\n')[0] ?? 'error';
    throw new DbError(m ? m[1] : 'SQL_ERROR', first.replace(/^.*?ERROR:\s+/, ''));
  }
}
export const one = (text: string, vars: Record<string, string> = {}, as: As = null) => sql(text, vars, as)[0] ?? null;

export class PsqlFounderDb implements FounderDb {
  constructor(public storage: Map<string, Uint8Array>, public user = FOUNDER) {}
  private get as(): As { return { role: 'authenticated', sub: this.user }; }

  async activeRestrictionCount(caseId: string) {
    return Number(one(`select count(*) from public.contact_restrictions where case_id = :'c' and status = 'ACTIVE'`, { c: caseId }, this.as));
  }
  async startAnalysis(caseId: string) {
    return one(`select public.founder_start_analysis(:'c')`, { c: caseId }, this.as)!;
  }
  async getAnalysis(id: string): Promise<AnalysisRecord | null> {
    const row = one(`select json_build_object('id', id, 'caseId', case_id, 'status', status, 'evidenceVersion', evidence_version,
      'evidenceManifest', evidence_manifest, 'error', error) from public.analyses where id = :'a'`, { a: id }, this.as);
    return row ? JSON.parse(row) : null;
  }
  async getMessages(caseId: string, ids: string[]): Promise<MessageRow[]> {
    const row = one(`select coalesce(json_agg(json_build_object('id', id, 'kind', kind, 'body', body)), '[]') from public.case_messages
      where case_id = :'c' and id::text = any (string_to_array(:'ids', ','))`, { c: caseId, ids: ids.join(',') }, this.as);
    return JSON.parse(row ?? '[]');
  }
  async getScreenshotFile(caseId: string, screenshotId: string): Promise<ScreenshotFile | null> {
    const row = one(`select json_build_object('position', position, 'mimeType', mime_type, 'path', storage_path) from public.case_screenshots
      where case_id = :'c' and id = :'s' and file_deleted_at is null`, { c: caseId, s: screenshotId }, this.as);
    if (!row) return null;
    const meta = JSON.parse(row) as { position: number; mimeType: string; path: string };
    const bytes = this.storage.get(meta.path);
    return bytes ? { position: meta.position, mimeType: meta.mimeType, bytes } : null;
  }
  async abandonAnalysis(id: string) {
    sql(`select public.founder_abandon_analysis(:'a')`, { a: id }, this.as);
  }
}

const approved = (o: { model: string; max_output_tokens: number }): ApprovedCall => ({ model: o.model, maxOutputTokens: o.max_output_tokens });

export class PsqlServiceDb implements ServiceDb {
  async reserveSpend(id: string, analystModel: string, reviewerModel: string): Promise<SpendReservation> {
    const r = JSON.parse(one(`select public.internal_reserve_ai_spend(:'a', :'am', :'rm')`, { a: id, am: analystModel, rm: reviewerModel }, { role: 'service_role' })!);
    return { reservedUsd: Number(r.reserved_usd), analyst: approved(r.analyst), reviewer: approved(r.reviewer) };
  }
  async recordDispatch(id: string, role: Role): Promise<ApprovedCall> {
    return approved(JSON.parse(one(`select public.internal_ai_dispatch(:'a', :'r')`, { a: id, r: role }, { role: 'service_role' })!));
  }
  async reportUsage(id: string, role: Role, inputTokens: number, outputTokens: number) {
    sql(`select public.internal_ai_report_usage(:'a', :'r', :'i', :'o')`, { a: id, r: role, i: String(inputTokens), o: String(outputTokens) }, { role: 'service_role' });
  }
  async completeAnalysis(p: CompletionParams) {
    sql(`select public.internal_complete_analysis(:'a', :'status', nullif(:'model', ''), :'pv', nullif(:'output', '')::jsonb,
           nullif(:'cls', '')::public.classification, nullif(:'msg', ''), :'restr'::jsonb,
           nullif(:'tin', '')::integer, nullif(:'tout', '')::integer, nullif(:'cost', '')::numeric, nullif(:'err', ''))`, {
      a: p.analysisId, status: p.status, model: p.model ?? '', pv: p.promptVersion, output: p.output ? JSON.stringify(p.output) : '',
      cls: p.classification ?? '', msg: p.proposedMessage ?? '', restr: JSON.stringify(p.detectedRestrictions),
      tin: p.inputTokens === null ? '' : String(p.inputTokens), tout: p.outputTokens === null ? '' : String(p.outputTokens),
      cost: p.estimatedCostUsd === null ? '' : String(p.estimatedCostUsd), err: p.error ?? '',
    }, { role: 'service_role' });
  }
}

/**
 * Fixture only: earlier synthetic cases are moved out of the 20-per-day client limit window, and
 * earlier spending reservations out of the 24-hour founder/case attempt windows.
 */
export function makeRoomForCase(business = BIZ_A) {
  sql(`begin; set local session_replication_role = replica;
       update public.cases set created_at = created_at - interval '2 days' where business_id = :'b' and created_at > now() - interval '1 day';
       update private.ai_spend_ledger set created_at = created_at - interval '25 hours' where created_at > now() - interval '25 hours'; commit;`, { b: business });
}

/**
 * Fixture only, LOCAL TEST DATABASE: spending on (it is off by default and stays off on staging),
 * synthetic prices for the test models, and old ledger rows reconciled so the budget never fills.
 */
export function enableTestSpending(on = true) {
  sql(`update private.ai_spend_config set enabled = :'on'::boolean, budget_usd = 20, stop_at_usd = 18 where id;
       insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note)
       values ('fake-analyst', 2, 10, 8000, true, 'synthetic test price'), ('fake-reviewer', 4, 20, 4000, true, 'synthetic test price')
       on conflict (model) do nothing;
       update private.ai_spend_ledger set status = 'RECONCILED', actual_usd = coalesce(actual_usd, 0), settled_by = 'RECONCILIATION',
         reconciliation_note = 'test fixture: cleared between tests', settled_at = now()
       where status in ('HELD', 'RESERVED') and not exists (select 1 from public.analyses a where a.id = analysis_id and a.status = 'PENDING');`,
  { on: String(on) });
}

/** "STATUS:SETTLED_BY:actual" of an analysis's reservation, or NONE. */
export const spend = (analysisId: string) =>
  one(`select status || ':' || coalesce(settled_by, '-') || ':' || coalesce(actual_usd::text, '-') from private.ai_spend_ledger where analysis_id = :'a'`, { a: analysisId }) ?? 'NONE';
