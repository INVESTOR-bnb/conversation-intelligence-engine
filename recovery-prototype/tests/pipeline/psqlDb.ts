// Stage 2A-5d-4a — test-only database adapter: the pipeline's FounderDb and
// ServiceDb implemented with psql against the local test database, acting exactly
// as PostgREST would (role + JWT claims, so RLS and function grants apply).
// Every value is passed as a psql variable (:'name' quoting), never spliced into SQL.
// Storage is simulated: file bytes live in `storage` keyed by storage path; the
// object's metadata row is the real case_screenshots row read with the founder's RLS.

import { execFileSync } from 'node:child_process';
import {
  DbError, type AnalysisRecord, type CompletionParams, type FounderDb, type MessageRow, type ScreenshotFile, type ServiceDb,
} from '../../supabase/functions/_shared/analysis-pipeline/index.ts';

const HOST = process.env.PIPELINE_PGHOST;
const PORT = process.env.PIPELINE_PGPORT;
const PSQL = process.env.PIPELINE_PSQL ?? 'psql';

export const FOUNDER = '00000000-0000-4000-8000-00000000000f';
export const CLIENT_A = '00000000-0000-4000-8000-00000000000a';
export const CLIENT_B = '00000000-0000-4000-8000-00000000000b';
export const BIZ_A = '10000000-0000-4000-8000-00000000000a';

export type As = { role: 'authenticated'; sub: string } | { role: 'service_role' } | { role: 'anon' } | null;

/** Runs SQL (as the given caller) and returns the output rows (-At). Throws DbError with the raised code. */
export function sql(text: string, vars: Record<string, string> = {}, as: As = null): string[] {
  if (!HOST || !PORT) throw new Error('run through supabase/scripts/test-pipeline-db.sh');
  const prefix = as === null ? '' : as.role === 'anon'
    ? `select set_config('request.jwt.claims', '{"role":"anon"}', false) \\g /dev/null\nset role anon;\n`
    : `select set_config('request.jwt.claims', :'__claims', false) \\g /dev/null\nset role ${as.role};\n`;
  const allVars: Record<string, string> = { ...vars };
  if (as && as.role !== 'anon') allVars.__claims = JSON.stringify(as.role === 'service_role' ? { role: 'service_role' } : { sub: as.sub, role: 'authenticated' });
  const args = ['-h', HOST, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(allVars)) args.push('-v', `${k}=${v}`);
  try {
    const out = execFileSync(PSQL, args, { input: prefix + text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out.split('\n').filter((l) => l !== '');
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    const m = /ERROR:\s+([A-Z_]+):/.exec(stderr);
    throw new DbError(m ? m[1] : 'SQL_ERROR', stderr.trim().split('\n')[0] ?? 'error');
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

export class PsqlServiceDb implements ServiceDb {
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
