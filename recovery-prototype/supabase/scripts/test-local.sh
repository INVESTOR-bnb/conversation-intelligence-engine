#!/usr/bin/env bash
# Runs the Stage 2A migrations (or deployment files) and authorization tests against a throwaway
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
  echo "== Install via deploy/stage2a4b_deploy.sql (single transaction)"
  load "$HERE/deploy/stage2a4b_deploy.sql"
  echo "== Install via deploy/stage2a4c_deploy.sql (single transaction)"
  load "$HERE/deploy/stage2a4c_deploy.sql"
  echo "== Install via deploy/stage2a4c1_deploy.sql (single transaction)"
  load "$HERE/deploy/stage2a4c1_deploy.sql"
  echo "== Install via deploy/stage2a5a_deploy.sql (single transaction)"
  load "$HERE/deploy/stage2a5a_deploy.sql"
  echo "== Install via deploy/stage2a5b_deploy.sql (single transaction)"
  load "$HERE/deploy/stage2a5b_deploy.sql"
  echo "== Install via deploy/stage2a5d1_deploy.sql (single transaction)"
  load "$HERE/deploy/stage2a5d1_deploy.sql"
  echo "== Install via deploy/stage2a5d2_deploy.sql (single transaction)"
  load "$HERE/deploy/stage2a5d2_deploy.sql"
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
# Administrator bootstrap script (admin/bootstrap_founder.sql).
UNASSIGNED_ID=00000000-0000-4000-8000-00000000000e
CLIENT_A_ID=00000000-0000-4000-8000-00000000000a
# boot_case <name> <email> <user-id> <setup-sql> <expected: GRANTED|refusal text>
boot_case() {
  local name="$1" email="$2" uid="$3" setup="$4" expect="$5" f="$WORK/bootstrap.sql"
  { echo "begin; select tests.seed(); delete from public.founders;"
    echo "update auth.users set email_confirmed_at = now(), last_sign_in_at = now(), encrypted_password = 'x' where email = 'invited@synthetic.test';"
    echo "$setup"
    sed -e "s/REPLACE_WITH_FOUNDER_EMAIL';/$email';/" -e "s/'REPLACE_WITH_FOUNDER_USER_ID';/'$uid';/" "$HERE/admin/bootstrap_founder.sql"
    if [ "$expect" = GRANTED ]; then
      echo "select tests.ok(exists (select 1 from public.founders where user_id = '$uid'), 'founder row created');"
      echo "select tests.ok((select count(*) = 1 from public.audit_log where action = 'FOUNDER_BOOTSTRAPPED'), 'bootstrap is audited');"
      echo "select tests.login('$uid'); select tests.is((public.whoami()) ->> 'role', 'FOUNDER', 'whoami reports FOUNDER');"
    fi
    echo "rollback;"; } > "$f"
  local out; out="$(run "$f" || true)"
  if [ "$expect" = GRANTED ]; then
    if [ "$(grep -c 'NOTICE:  ok - ' <<<"$out")" = 3 ]; then pass=$((pass + 3)); echo "PASS bootstrap: $name"; else failed=$((failed + 1)); echo "FAIL bootstrap: $name"; grep -E 'ERROR|FAIL' <<<"$out" | head -3 | sed 's/^/     /'; fi
  else
    if grep -qF "$expect" <<<"$out" && ! grep -q "Founder role granted" <<<"$out"; then pass=$((pass + 1)); echo "PASS bootstrap refuses: $name"; else failed=$((failed + 1)); echo "FAIL bootstrap should refuse: $name"; grep -E 'ERROR|NOTICE' <<<"$out" | head -3 | sed 's/^/     /'; fi
  fi
}
boot_case "unedited placeholders" "REPLACE_WITH_FOUNDER_EMAIL" "REPLACE_WITH_FOUNDER_USER_ID" "" "Edit v_email and v_user_id"
boot_case "verified invited account" "Invited@Synthetic.test" "$UNASSIGNED_ID" "" GRANTED
boot_case "email and user ID of different accounts" "invited@synthetic.test" "$CLIENT_A_ID" "" "No account has BOTH"
boot_case "malformed user ID" "invited@synthetic.test" "not-a-uuid" "" "not a valid user ID"
boot_case "email not confirmed" "invited@synthetic.test" "$UNASSIGNED_ID" "update auth.users set email_confirmed_at = null where id = '$UNASSIGNED_ID';" "email is not confirmed"
boot_case "password never set" "invited@synthetic.test" "$UNASSIGNED_ID" "update auth.users set encrypted_password = '' where id = '$UNASSIGNED_ID';" "has not set a password"
boot_case "never signed in" "invited@synthetic.test" "$UNASSIGNED_ID" "update auth.users set last_sign_in_at = null where id = '$UNASSIGNED_ID';" "never signed in"
boot_case "client member" "client-a@synthetic.test" "$CLIENT_A_ID" "update auth.users set email_confirmed_at = now(), last_sign_in_at = now(), encrypted_password = 'x' where id = '$CLIENT_A_ID';" "client member"
boot_case "another founder already exists" "invited@synthetic.test" "$UNASSIGNED_ID" "insert into public.founders (user_id) values (tests.founder());" "A different founder already exists"

echo "== $pass assertions passed; $failed file(s) failed"
[ "$failed" = 0 ]
