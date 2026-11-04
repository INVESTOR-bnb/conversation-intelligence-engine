#!/usr/bin/env node
// Sets up and updates the ISOLATED WhatsApp preview's Supabase project (never the prototype's).
// Run by the workflow job `wa-preview` (target wa-preview-deploy). Management API only.
//
//   node supabase/scripts/wa-preview-deploy.mjs setup        schema (migrations, then the WhatsApp bundle) if absent,
//                                                            function secrets, worker schedule
//   node supabase/scripts/wa-preview-deploy.mjs founder      makes an existing auth user of THIS project the founder
//   node supabase/scripts/wa-preview-deploy.mjs readiness    read-only checks (schema, secrets by name, schedule)
//
// Environment: WA_PREVIEW_SUPABASE_ACCESS_TOKEN (scoped to the preview project), WA_PREVIEW_PROJECT_REF,
// WA_APP_ID, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_ALLOWED_ORIGIN; FOUNDER_EMAIL for `founder`.
// WA_WORKER_SECRET and WA_TOKEN_KEY are generated here once and never printed or overwritten (overwriting
// the token key would make stored WhatsApp credentials unreadable). Nothing is printed but names and states.

import { randomBytes } from 'node:crypto';
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

export function configProblem(env) {
  const ref = env.WA_PREVIEW_PROJECT_REF ?? '';
  if (!/^[a-z]{20}$/.test(ref)) return 'WA_PREVIEW_PROJECT_REF is not a Supabase project reference';
  if (ref === PROTOTYPE_REF) return 'WA_PREVIEW_PROJECT_REF is the prototype\'s project: refused (isolation)';
  if (!/^sbp_[A-Za-z0-9_]{20,}$/.test(env.WA_PREVIEW_SUPABASE_ACCESS_TOKEN ?? '')) return 'WA_PREVIEW_SUPABASE_ACCESS_TOKEN is missing or not a personal access token';
  return null;
}

let TOKEN = ''; let REF = '';
async function mgmt(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${MGMT}/v1/projects/${REF}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Stop(`Management API unreachable (${e?.name ?? 'error'})`); }
  if (res.status === 401 || res.status === 403) throw new Stop(`the access token is not accepted for ${method} ${path.split('?')[0]} (HTTP ${res.status})`);
  if (!res.ok) {
    let msg = ''; try { msg = String((await res.json())?.message ?? ''); } catch { /* no body */ }
    throw new Stop(`HTTP ${res.status} for ${method} ${path.split('?')[0]}${/^[\w .:,'()-]{0,200}$/.test(msg) ? `: ${msg}` : ''}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const query = (q) => mgmt('/database/query', { method: 'POST', body: { query: q } });
const scalar = async (q) => { const r = await query(`select (${q}) as v`); return Array.isArray(r) ? r[0]?.v : undefined; };

/** Migrations in order, then the WhatsApp bundle; each only if its marker table is absent. */
export function schemaFiles() {
  const dir = join(HERE, 'migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => join(dir, f));
}

async function setup(env) {
  const project = await mgmt('');
  out(`project ${REF}: ${project?.status ?? 'unknown'}`);
  if (project?.status !== 'ACTIVE_HEALTHY') throw new Stop('the preview project is not ACTIVE_HEALTHY');
  if (await scalar(`to_regclass('public.cases') is null`)) {
    for (const f of schemaFiles()) { await query(readFileSync(f, 'utf8')); out(`applied ${f.split('/').pop()}`); }
  } else out('RRE schema present (not re-applied)');
  if (await scalar(`to_regclass('private.wa_settings') is null`)) {
    await query(readFileSync(join(HERE, 'whatsapp', 'wa_integration.sql'), 'utf8'));
    out('applied whatsapp/wa_integration.sql');
  } else out('WhatsApp bundle present (not re-applied)');

  const names = new Set((await mgmt('/secrets') ?? []).map((s) => s?.name));
  const set = [];
  for (const k of ['WA_APP_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'WA_ALLOWED_ORIGIN']) {
    if (!env[k]) throw new Stop(`${k} is required`);
    set.push({ name: k, value: env[k] });
  }
  let worker = null;
  if (!names.has('WA_TOKEN_KEY')) set.push({ name: 'WA_TOKEN_KEY', value: randomBytes(32).toString('base64') });
  if (!names.has('WA_WORKER_SECRET')) { worker = randomBytes(32).toString('base64url'); secrets.push(worker); set.push({ name: 'WA_WORKER_SECRET', value: worker }); }
  for (const s of set) secrets.push(s.value);
  await mgmt('/secrets', { method: 'POST', body: set });
  out(`function settings set: ${set.map((s) => s.name).join(', ')} (values not shown)`);

  if (worker) {
    // The worker runs every minute; its secret lives in Vault (never in the job text).
    await query(`create extension if not exists pg_cron; create extension if not exists pg_net;
      select vault.create_secret('${worker}', 'rre_wa_worker_secret', 'RRE WhatsApp worker');
      select cron.unschedule(jobid) from cron.job where jobname = 'rre-wa-worker';
      select cron.schedule('rre-wa-worker', '* * * * *', $job$
        select net.http_post(url := 'https://${REF}.supabase.co/functions/v1/whatsapp/worker',
          headers := jsonb_build_object('x-rre-worker', (select decrypted_secret from vault.decrypted_secrets where name = 'rre_wa_worker_secret')),
          timeout_milliseconds := 60000)
      $job$);`);
    out('worker scheduled every minute (secret in Vault)');
  }
}

async function founder(env) {
  const email = String(env.FOUNDER_EMAIL ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(email)) throw new Stop('FOUNDER_EMAIL is not a valid email address');
  const id = await scalar(`select id from auth.users where lower(email) = '${email}'`);
  if (!id) throw new Stop('no user with that email in the PREVIEW project: invite or add them in its Supabase dashboard first');
  await query(`insert into public.founders (user_id) values ('${id}') on conflict do nothing`);
  out('founder recorded in the preview project');
}

async function readiness() {
  const checks = {
    schema: await scalar(`to_regclass('public.cases') is not null and to_regclass('private.wa_settings') is not null`),
    sending_switch_off: await scalar(`not (select sending_enabled from private.wa_settings where id)`),
    ai_spending_off: await scalar(`not (select enabled from private.ai_spend_config where id)`),
    worker_scheduled: await scalar(`exists (select 1 from cron.job where jobname = 'rre-wa-worker')`),
    founder: await scalar(`exists (select 1 from public.founders)`),
  };
  const names = new Set((await mgmt('/secrets') ?? []).map((s) => s?.name));
  for (const k of ['WA_APP_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'WA_WORKER_SECRET', 'WA_TOKEN_KEY', 'WA_ALLOWED_ORIGIN']) checks[`secret_${k}`] = names.has(k);
  for (const [k, v] of Object.entries(checks)) out(`${v === true ? 'PASS' : 'FAIL'}  ${k}`);
  if (Object.values(checks).some((v) => v !== true)) throw new Stop('readiness incomplete');
}

async function main() {
  const cmd = process.argv[2];
  if (!['setup', 'founder', 'readiness'].includes(cmd ?? '')) { console.error('usage: wa-preview-deploy.mjs setup|founder|readiness'); return 2; }
  const problem = configProblem(process.env);
  if (problem) { console.error(`refused: ${problem}`); return 2; }
  TOKEN = process.env.WA_PREVIEW_SUPABASE_ACCESS_TOKEN; REF = process.env.WA_PREVIEW_PROJECT_REF;
  secrets.push(TOKEN, process.env.WA_APP_SECRET, process.env.WA_VERIFY_TOKEN);
  try {
    if (cmd === 'setup') await setup(process.env); else if (cmd === 'founder') await founder(process.env); else await readiness();
    out(`RESULT: ${cmd.toUpperCase()} PASSED`);
    return 0;
  } catch (e) {
    out(`RESULT: ${cmd.toUpperCase()} FAILED — ${e instanceof Stop ? e.message : 'unexpected error'}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
