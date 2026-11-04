#!/usr/bin/env node
// The ISOLATED WhatsApp preview's Cloudflare Pages project (never the prototype's `revenue-recovery-v0`).
// Run by the workflow job `wa-preview`: proves the Cloudflare credentials reach the account and can
// read and create Pages projects, creates the separate project if it is absent (free), and reports
// the site's real address (Cloudflare adds a suffix when a *.pages.dev name is already taken).
//
// Modes: `create` (default; creates the project if absent) and `check` (never creates).
// Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, WA_PREVIEW_PAGES_PROJECT.
// Writes `origin=https://…` and `has_deployment=true|false` to $GITHUB_OUTPUT when set.
// Never prints the token or the account id.

import { appendFileSync } from 'node:fs';

export const PROTOTYPE_PAGES = 'revenue-recovery-v0';
const API = 'https://api.cloudflare.com/client/v4';
class Stop extends Error {}

export function pagesConfigProblem(env) {
  const name = env.WA_PREVIEW_PAGES_PROJECT ?? '';
  if (!/^[a-z0-9][a-z0-9-]{1,56}[a-z0-9]$/.test(name)) return 'WA_PREVIEW_PAGES_PROJECT is not a valid Pages project name';
  if (name === PROTOTYPE_PAGES) return 'WA_PREVIEW_PAGES_PROJECT is the prototype\'s Pages project: refused (isolation)';
  if (!env.CLOUDFLARE_API_TOKEN) return 'secret CLOUDFLARE_API_TOKEN is not available to this job';
  if (!/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) return 'secret CLOUDFLARE_ACCOUNT_ID is not available to this job (or is not an account id)';
  return null;
}

async function cf(env, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Stop(`Cloudflare API unreachable (${e?.name ?? 'error'})`); }
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  const codes = (json?.errors ?? []).map((e) => Number(e?.code)).filter(Number.isFinite);
  return { status: res.status, ok: res.ok && json?.success !== false, result: json?.result, codes };
}

export async function main(env, mode = 'create') {
  const problem = pagesConfigProblem(env);
  if (problem) throw new Stop(problem);
  const name = env.WA_PREVIEW_PAGES_PROJECT;

  const list = await cf(env, '/pages/projects?per_page=1');
  if (list.status === 401 || list.status === 403) throw new Stop(`the Cloudflare token cannot read Pages projects in this account (HTTP ${list.status}); it needs Account › Cloudflare Pages › Edit`);
  if (!list.ok) throw new Stop(`listing Pages projects failed (HTTP ${list.status}${list.codes.length ? `, code ${list.codes.join(',')}` : ''})`);
  console.log('PASS  Cloudflare credentials available to this job; Pages projects readable');

  let project = await cf(env, `/pages/projects/${name}`);
  if (project.ok) console.log(`PASS  separate Pages project "${name}" exists (not created again)`);
  else if ((project.status === 404 || project.codes.includes(8000007)) && mode === 'check') throw new Stop(`Pages project "${name}" does not exist yet: run target wa-preview-preflight`);
  else if (project.status === 404 || project.codes.includes(8000007)) {
    const made = await cf(env, '/pages/projects', { method: 'POST', body: { name, production_branch: 'main' } });
    if (made.status === 401 || made.status === 403) throw new Stop(`the Cloudflare token cannot create Pages projects (HTTP ${made.status}); it needs Account › Cloudflare Pages › Edit`);
    if (!made.ok) throw new Stop(`creating Pages project "${name}" failed (HTTP ${made.status}${made.codes.length ? `, code ${made.codes.join(',')}` : ''})`);
    console.log(`PASS  separate Pages project "${name}" created (free; production branch main)`);
    project = made;
  } else throw new Stop(`reading Pages project "${name}" failed (HTTP ${project.status})`);

  const sub = String(project.result?.subdomain ?? '');
  if (!/^[a-z0-9-]+\.pages\.dev$/.test(sub)) throw new Stop('Cloudflare did not report the project\'s pages.dev address');
  if (sub.startsWith(`${PROTOTYPE_PAGES}.`)) throw new Stop('refused: the address is the prototype\'s site');
  const hasDeployment = Boolean(project.result?.canonical_deployment ?? project.result?.latest_deployment);
  console.log(`preview address: https://${sub}`);
  console.log(`deployed before: ${hasDeployment ? 'yes' : 'no'}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `origin=https://${sub}\nhas_deployment=${hasDeployment}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] ?? 'create';
  if (mode !== 'create' && mode !== 'check') { console.error('usage: wa-preview-pages.mjs [create|check]'); process.exit(2); }
  try { await main(process.env, mode); console.log('RESULT: PAGES PASSED'); }
  catch (e) { console.log(`RESULT: PAGES FAILED — ${e instanceof Stop ? e.message : 'unexpected error'}`); process.exitCode = 1; }
}
