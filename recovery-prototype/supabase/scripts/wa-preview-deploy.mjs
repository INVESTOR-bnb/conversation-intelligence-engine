#!/usr/bin/env node
// Sets up and updates the ISOLATED WhatsApp preview's Supabase project (never the prototype's).
// Run by the workflow job `wa-preview`. Management API only; safe to re-run after an interruption.
//
//   preflight          read-only: probes every Management API area the deployment uses and names any missing
//                      token permission before anything is written
//   setup              schema (each migration, then the WhatsApp bundle, applied once and tracked with a checksum),
//                      function settings, worker schedule (repaired if missing; the token key is never replaced)
//   readiness          infrastructure only: schema complete and unchanged, switches off, settings, schedule
//   founder            makes an existing auth user of THIS project the founder
//   founder-readiness  a founder exists
//
// Environment: WA_PREVIEW_SUPABASE_ACCESS_TOKEN (scoped to the preview project), WA_PREVIEW_PROJECT_REF,
// WA_APP_ID, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_ALLOWED_ORIGIN; WA_PREVIEW_PUBLISHABLE_KEY for `preflight`;
// FOUNDER_EMAIL for `founder`.
// Nothing is printed but names and states.

import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOTYPE_REF = 'aqwdwswpmbnzmkvyuqil';
const MGMT = 'https://api.supabase.com';
const HERE = fileURLToPath(new URL('..', import.meta.url));
const secrets = [];
const redact = (s) => { let t = String(s); for (const v of secrets) if (v) t = t.split(v).join('[REDACTED]'); return t; };
const out = (...a) => console.log(redact(a.join(' ')));
class Stop extends Error {}

/** The token permission each Management API call needs (scoped Supabase access tokens). */
export const PERMISSIONS = [
  { call: 'GET /v1/projects/{ref}', permission: 'Project Settings: Read', why: 'confirm the project is the preview and healthy' },
  { call: 'POST /v1/projects/{ref}/database/query', permission: 'Database: Read and write', why: 'schema, tracking, schedule, readiness' },
  { call: 'GET /v1/projects/{ref}/secrets', permission: 'Edge Function Secrets: Read', why: 'which settings exist (names only)' },
  { call: 'POST /v1/projects/{ref}/secrets', permission: 'Edge Function Secrets: Write', why: 'set the function settings' },
  { call: 'GET /v1/projects/{ref}/functions', permission: 'Edge Functions: Read', why: 'readiness of the deployed functions' },
  { call: 'supabase functions deploy (CLI 2.117.0, --use-api)', permission: 'Edge Functions: Write', why: 'deploy whatsapp and analyze-case' },
];

export function configProblem(env) {
  const ref = env.WA_PREVIEW_PROJECT_REF ?? '';
  if (!/^[a-z]{20}$/.test(ref)) return 'WA_PREVIEW_PROJECT_REF is not a Supabase project reference';
  if (ref === PROTOTYPE_REF) return 'WA_PREVIEW_PROJECT_REF is the prototype\'s project: refused (isolation)';
  if (!/^sbp_[A-Za-z0-9_]{20,}$/.test(env.WA_PREVIEW_SUPABASE_ACCESS_TOKEN ?? '')) return 'WA_PREVIEW_SUPABASE_ACCESS_TOKEN is missing or not a personal access token';
  return null;
}

let TOKEN = ''; let REF = '';
async function mgmt(path, { method = 'GET', body, permission } = {}) {
  let res;
  try {
    res = await fetch(`${MGMT}/v1/projects/${REF}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Stop(`Management API unreachable (${e?.name ?? 'error'})`); }
  if (res.status === 401) throw new Stop('the access token was rejected (expired, revoked or wrong)');
  if (res.status === 403) throw new Stop(`the access token lacks "${permission ?? 'a permission'}" for ${method} ${path.split('?')[0] || '/'}`);
  if (!res.ok) {
    let msg = ''; try { msg = String((await res.json())?.message ?? ''); } catch { /* no body */ }
    throw new Stop(`HTTP ${res.status} for ${method} ${path.split('?')[0] || '/'}${/^[\w .:,'"()-]{0,200}$/.test(msg) ? `: ${msg}` : ''}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const query = (q) => mgmt('/database/query', { method: 'POST', body: { query: q }, permission: 'Database: Read and write' });
const scalar = async (q) => { const r = await query(`select (${q}) as v`); return Array.isArray(r) ? r[0]?.v : undefined; };
const secretNames = async () => new Set(((await mgmt('/secrets', { permission: 'Edge Function Secrets: Read' })) ?? []).map((s) => s?.name));
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Every schema file in order: the migrations, then the WhatsApp bundle; with checksums. */
export function schemaFiles() {
  const dir = join(HERE, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ name: f, path: join(dir, f) }));
  files.push({ name: 'whatsapp/wa_integration.sql', path: join(HERE, 'whatsapp', 'wa_integration.sql') });
  return files.map((f) => { const sql = readFileSync(f.path, 'utf8'); return { ...f, sql, sha256: createHash('sha256').update(sql).digest('hex') }; });
}

const TRACKING = `create schema if not exists rre_preview;
  revoke all on schema rre_preview from public;
  create table if not exists rre_preview.applied (file text primary key, sha256 text not null, applied_at timestamptz not null default now());
  revoke all on rre_preview.applied from public;
  do $$ begin execute 'revoke all on schema rre_preview from anon, authenticated, service_role'; exception when undefined_object then null; end $$;`;

async function preflight() {
  const project = await mgmt('', { permission: 'Project Settings: Read' });
  out(`PASS  Project Settings: Read — project ${REF} is ${project?.status ?? 'unknown'}`);
  if (project?.status !== 'ACTIVE_HEALTHY') throw new Stop('the preview project is not ACTIVE_HEALTHY');
  await scalar('1'); out('PASS  Database (query)');
  await secretNames(); out('PASS  Edge Function Secrets: Read');
  await mgmt('/functions', { permission: 'Edge Functions: Read' }); out('PASS  Edge Functions: Read');
  await publishableKeyCheck(process.env.WA_PREVIEW_PUBLISHABLE_KEY);
  out('NOTE  write permissions (Database, Edge Function Secrets, Edge Functions) are confirmed by the first setup and deploy');
}

/** The public publishable key must be accepted by THIS project's API (a key of another project is rejected). */
async function publishableKeyCheck(key) {
  if (!key) throw new Stop('variable WA_PREVIEW_PUBLISHABLE_KEY is not set');
  if (!/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) throw new Stop('WA_PREVIEW_PUBLISHABLE_KEY is not an sb_publishable_ key (never use a secret or service-role key there)');
  let res;
  try {
    res = await fetch(`https://${REF}.supabase.co/auth/v1/settings`, { headers: { apikey: key }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (e) { throw new Stop(`the preview project's API is unreachable (${e?.name ?? 'error'})`); }
  if (res.status === 401 || res.status === 403) throw new Stop(`the preview project rejected WA_PREVIEW_PUBLISHABLE_KEY (HTTP ${res.status}): it belongs to another project or was revoked`);
  if (!res.ok) throw new Stop(`the preview project's auth API answered HTTP ${res.status}`);
  out(`PASS  publishable key accepted by project ${REF}`);
}

async function setup(env) {
  await preflight();
  await query(TRACKING);
  const applied = new Map(((await query('select file, sha256 from rre_preview.applied')) ?? []).map((r) => [r.file, r.sha256]));
  if (applied.size === 0 && await scalar(`to_regclass('public.cases') is not null`)) {
    throw new Stop('this project already has an RRE schema not installed by this tool: refused (use a new, empty project)');
  }
  for (const f of schemaFiles()) {
    const done = applied.get(f.name);
    if (done === f.sha256) continue;
    if (done) throw new Stop(`${f.name} changed after it was applied (checksum differs): refused; review before changing a deployed schema`);
    // one transaction: the file and its tracking record succeed or fail together (an interruption leaves nothing half-applied)
    await query(`begin;\n${f.sql}\n;insert into rre_preview.applied (file, sha256) values (${lit(f.name)}, ${lit(f.sha256)});\ncommit;`);
    out(`applied ${f.name}`);
  }
  out('schema complete (every file applied once, checksums recorded)');

  const names = await secretNames();
  const set = [];
  for (const k of ['WA_APP_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'WA_ALLOWED_ORIGIN']) {
    if (!env[k]) throw new Stop(`${k} is required`);
    set.push({ name: k, value: env[k] });
  }
  // The token key encrypts stored WhatsApp credentials: created once, never replaced.
  if (!names.has('WA_TOKEN_KEY')) set.push({ name: 'WA_TOKEN_KEY', value: randomBytes(32).toString('base64') });
  // The worker secret is only shared with the schedule: (re)issued whenever the schedule or its Vault copy is missing.
  const scheduleOk = await scalar(`exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_namespace where nspname = 'vault')`)
    && await scalar(`exists (select 1 from cron.job where jobname = 'rre-wa-worker') and exists (select 1 from vault.secrets where name = 'rre_wa_worker_secret')`);
  let worker = null;
  if (!names.has('WA_WORKER_SECRET') || !scheduleOk) { worker = randomBytes(32).toString('base64url'); set.push({ name: 'WA_WORKER_SECRET', value: worker }); }
  for (const s of set) secrets.push(s.value);
  await mgmt('/secrets', { method: 'POST', body: set, permission: 'Edge Function Secrets: Write' });
  out(`function settings set: ${set.map((s) => s.name).join(', ')} (values not shown)`);
  if (worker) {
    await query(`create extension if not exists pg_cron; create extension if not exists pg_net;
      do $$ declare v uuid; begin
        select id into v from vault.secrets where name = 'rre_wa_worker_secret';
        if v is null then perform vault.create_secret(${lit(worker)}, 'rre_wa_worker_secret', 'RRE WhatsApp worker');
        else perform vault.update_secret(v, ${lit(worker)}); end if;
      end $$;
      select cron.unschedule(jobid) from cron.job where jobname = 'rre-wa-worker';
      select cron.schedule('rre-wa-worker', '* * * * *', $job$
        select net.http_post(url := 'https://${REF}.supabase.co/functions/v1/whatsapp/worker',
          headers := jsonb_build_object('x-rre-worker', (select decrypted_secret from vault.decrypted_secrets where name = 'rre_wa_worker_secret')),
          timeout_milliseconds := 60000)
      $job$);`);
    out('worker schedule (re)created every minute; its secret is in Vault; the token key was not touched');
  } else out('worker schedule present (not changed)');
}

async function readiness() {
  const files = schemaFiles();
  const applied = new Map(((await query(`select file, sha256 from rre_preview.applied`)) ?? []).map((r) => [r.file, r.sha256]));
  const checks = {
    schema_complete_and_unchanged: files.every((f) => applied.get(f.name) === f.sha256),
    whatsapp_sending_off: await scalar(`not (select sending_enabled from private.wa_settings where id)`),
    ai_spending_off: await scalar(`not (select enabled from private.ai_spend_config where id)`),
    worker_scheduled: await scalar(`exists (select 1 from cron.job where jobname = 'rre-wa-worker') and exists (select 1 from vault.secrets where name = 'rre_wa_worker_secret')`),
  };
  const names = await secretNames();
  for (const k of ['WA_APP_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'WA_WORKER_SECRET', 'WA_TOKEN_KEY', 'WA_ALLOWED_ORIGIN']) checks[`setting_${k}`] = names.has(k);
  const fns = ((await mgmt('/functions', { permission: 'Edge Functions: Read' })) ?? []).map((f) => `${f?.slug}:${f?.status}:${f?.verify_jwt}`);
  checks.function_whatsapp_active_jwt_off = fns.includes('whatsapp:ACTIVE:false');
  checks.function_analyze_case_active_jwt_on = fns.includes('analyze-case:ACTIVE:true');
  for (const [k, v] of Object.entries(checks)) out(`${v === true ? 'PASS' : 'FAIL'}  ${k}`);
  if (Object.values(checks).some((v) => v !== true)) throw new Stop('infrastructure readiness incomplete');
}

async function founder(env) {
  const email = String(env.FOUNDER_EMAIL ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(email)) throw new Stop('FOUNDER_EMAIL is not a valid email address');
  const id = await scalar(`select id from auth.users where lower(email) = ${lit(email)}`);
  if (!id) throw new Stop('no user with that email in the PREVIEW project: add them in its Supabase dashboard (Authentication → Add user) first');
  await query(`insert into public.founders (user_id) values (${lit(id)}) on conflict do nothing`);
  out('founder recorded in the preview project');
}

async function founderReadiness() {
  const ok = await scalar(`exists (select 1 from public.founders)`);
  out(`${ok === true ? 'PASS' : 'FAIL'}  founder_account`);
  if (ok !== true) throw new Stop('no founder yet: run target wa-preview-founder');
}

async function main() {
  const cmd = process.argv[2];
  const commands = { preflight, setup, readiness, founder, 'founder-readiness': founderReadiness };
  if (!Object.hasOwn(commands, cmd ?? '')) { console.error(`usage: wa-preview-deploy.mjs ${Object.keys(commands).join('|')}`); return 2; }
  const problem = configProblem(process.env);
  if (problem) { console.error(`refused: ${problem}`); return 2; }
  TOKEN = process.env.WA_PREVIEW_SUPABASE_ACCESS_TOKEN; REF = process.env.WA_PREVIEW_PROJECT_REF;
  secrets.push(TOKEN, process.env.WA_APP_SECRET, process.env.WA_VERIFY_TOKEN);
  try {
    await commands[cmd](process.env);
    out(`RESULT: ${cmd.toUpperCase()} PASSED`);
    return 0;
  } catch (e) {
    out(`RESULT: ${cmd.toUpperCase()} FAILED — ${e instanceof Stop ? e.message : 'unexpected error'}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
