// Test-only preload (node --import) for supabase/scripts/fake-pipeline-e2e.mjs: routes the
// staging project's API, its Edge Functions and the Supabase Management API to local test
// servers (which run against the REAL local test database), and refuses every other host.
// Nothing can reach a real Supabase project from a process started with this preload.
const realFetch = globalThis.fetch;
const routes = {
  'aqwdwswpmbnzmkvyuqil.supabase.co': (u) => (u.pathname.startsWith('/functions/v1/') ? process.env.ROUTE_FUNCTIONS : process.env.ROUTE_SUPABASE),
  'api.supabase.com': () => process.env.ROUTE_MGMT,
};

globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const u = new URL(req.url);
  const target = routes[u.host]?.(u);
  if (!target) throw new Error(`blocked by test: ${u.host} is not routed to a local server`);
  const to = new URL(`${u.pathname}${u.search}`, target);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  return realFetch(to, { method: req.method, headers: req.headers, body, redirect: 'manual', signal: init?.signal ?? req.signal });
};
