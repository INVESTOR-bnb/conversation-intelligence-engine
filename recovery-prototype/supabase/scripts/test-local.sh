#!/usr/bin/env bash
# Runs the Stage 2A-1 migrations and authorization tests against a throwaway
# local PostgreSQL with a minimal Supabase emulation. No network, no secrets.
# This does NOT prove behaviour on Supabase itself; re-run equivalent tests there.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54329}"
WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi

cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUNAS[@]}" "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)

# Feed SQL on stdin so the postgres OS user needs no read access to the checkout.
run() { "${PSQL[@]}" < "$1" 2>&1; }

load() { out="$(run "$1")" || { echo "$out"; exit 1; }; }

echo "== Supabase emulation (local only)"
load "$HERE/tests/local/00_supabase_emulation.sql"
if [ "${SUPABASE_HELPER:-0}" = 1 ]; then
  echo "== Pre-existing Supabase helper public.rls_auto_enable() + event trigger ensure_rls"
  load "$HERE/deploy/known/rls_auto_enable.verified.sql"
  echo "create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();" > "$WORK/et.sql"; load "$WORK/et.sql"
fi
if [ "${INSTALL:-migrations}" = deploy ]; then
  echo "== Install via deploy/stage2a1_deploy.sql (single transaction)"
  load "$HERE/deploy/stage2a1_deploy.sql"
else
  echo "== Migrations"
  for f in "$HERE"/migrations/*.sql; do echo "   $(basename "$f")"; load "$f"; done
fi
echo "== Test helpers (local only)"
load "$HERE/tests/local/01_test_helpers.sql"

pass=0; failed=0
for f in "$HERE"/tests/*.test.sql; do
  name="$(basename "$f")"
  if out="$(run "$f")"; then
    n=$(grep -c 'NOTICE:  ok - ' <<<"$out" || true)
    pass=$((pass + n)); echo "PASS $name ($n assertions)"
  else
    n=$(grep -c 'NOTICE:  ok - ' <<<"$out" || true)
    pass=$((pass + n)); failed=$((failed + 1))
    echo "FAIL $name"; grep -E 'ERROR|FAIL' <<<"$out" | head -5 | sed 's/^/     /'
  fi
done
# Administrator bootstrap script: refuses to run unedited; grants founder to an invited user.
boot="$WORK/bootstrap.sql"
{ echo "begin; select tests.seed();"
  cat "$HERE/admin/bootstrap_founder.sql"
  echo "rollback;"; } > "$boot"
out="$(run "$boot" || true)"
if grep -q "Edit v_email before running" <<<"$out"; then
  pass=$((pass + 1)); echo "PASS admin/bootstrap_founder.sql refuses to run with the placeholder email"
else
  failed=$((failed + 1)); echo "FAIL admin/bootstrap_founder.sql ran without being edited"
fi
{ echo "begin; select tests.seed();"
  sed '0,/REPLACE_WITH_FOUNDER_EMAIL/s//invited@synthetic.test/' "$HERE/admin/bootstrap_founder.sql"
  echo "select tests.ok(exists (select 1 from public.founders where user_id = tests.unassigned()), 'bootstrap grants founder to the invited user');"
  echo "select tests.login(tests.unassigned()); select tests.is((public.whoami()) ->> 'role', 'FOUNDER', 'bootstrapped user is FOUNDER');"
  echo "rollback;"; } > "$boot"
if out="$(run "$boot")"; then
  n=$(grep -c 'NOTICE:  ok - ' <<<"$out" || true); pass=$((pass + n)); echo "PASS admin/bootstrap_founder.sql ($n assertions)"
else
  failed=$((failed + 1)); echo "FAIL admin/bootstrap_founder.sql"; grep -E 'ERROR|FAIL' <<<"$out" | head -3 | sed 's/^/     /'
fi

echo "== $pass assertions passed; $failed file(s) failed"
[ "$failed" = 0 ]
