#!/usr/bin/env bash
# Stage 2A-5d-3a spending controls under REAL concurrent PostgreSQL sessions
# (separate psql connections). Sessions are released together by a held table
# lock, so their reservations genuinely race.
#   B  six reservations race for a budget that fits exactly two
#   R  twelve reservations race for the founder's 10-per-24-hours limit
#   D  five sessions dispatch the same analyst call: exactly one wins
#   A  abandon races dispatch (repeatedly): a dispatched call is never released at $0
# Control: the same budget race against a copy of the reservation function WITHOUT
# the config-row lock overshoots — proving the test detects the defect.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54340}"
WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi
cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c max_connections=60" -w start >/dev/null
PSQL=("${RUNAS[@]}" "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -X -q)
load() { "${PSQL[@]}" -v ON_ERROR_STOP=1 < "$1" >/dev/null; }
sql() { "${PSQL[@]}" -v ON_ERROR_STOP=1 -At -c "$1"; }
SERVICE="set role service_role; select set_config('request.jwt.claims', '{\"role\": \"service_role\"}', false);"
F=00000000-0000-4000-8000-00000000000f
FOUNDER="set role authenticated; select set_config('request.jwt.claims', '{\"sub\": \"$F\", \"role\": \"authenticated\"}', false);"

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

load "$HERE/tests/local/00_supabase_emulation.sql"
for f in "$HERE"/migrations/*.sql; do load "$f"; done
load "$HERE/tests/local/01_test_helpers.sql"
sql "select tests.seed()" >/dev/null
sql "update private.ai_spend_config set enabled = true;
     insert into private.ai_model_prices values ('test-cheap', 1, 5, 1000, true, 'synthetic'), ('test-dear', 10, 50, 2000, true, 'synthetic')" >/dev/null

# new_analysis: a submitted case and a started analysis; prints the analysis id.
new_analysis() {
  local c; c=$(sql "insert into public.cases (business_id, reference, product_service, lead_source, conversation_source, idempotency_key, workflow_state, evidence_version)
    values ('10000000-0000-4000-8000-00000000000a', 'CC-' || left(gen_random_uuid()::text, 8), 'Synthetic', 'Referral', 'TEXT', gen_random_uuid(), 'SUBMITTED', 1) returning id" | head -1)
  sql "insert into public.case_messages (case_id, business_id, kind, body) values ('$c', '10000000-0000-4000-8000-00000000000a', 'PASTED_CONVERSATION', rpad('Prospect: synthetic ', 100, 'x'))" >/dev/null
  "${PSQL[@]}" -At -c "$FOUNDER" -c "select public.founder_start_analysis('$c')" | tail -1
}
age() { sql "update private.ai_spend_ledger set created_at = created_at - interval '25 hours'" >/dev/null; }
# race <fn> <id...>: runs "select <fn>(id, 'test-cheap', 'test-dear')" in parallel sessions, all released at once.
race() {
  local fn=$1; shift
  "${PSQL[@]}" -c "begin; lock table private.ai_spend_config in exclusive mode; select pg_sleep(1.5); commit;" >/dev/null 2>&1 &
  local locker=$! i=0
  sleep 0.4
  for a in "$@"; do
    "${PSQL[@]}" -At -c "$SERVICE" -c "select public.$fn('$a', 'test-cheap', 'test-dear')" > "$WORK/race_$i" 2>&1 &
    i=$((i + 1))
  done
  wait
  cat "$WORK"/race_* | grep -cE '"reserved_usd"' || true
  rm -f "$WORK"/race_*
}

echo "== B: six reservations race for a budget that fits exactly two"
ids=(); for i in 1 2 3 4 5 6; do ids+=("$(new_analysis)"); done
sql "update private.ai_spend_config set stop_at_usd = private.ai_committed_usd() + 0.4408" >/dev/null
won=$(race internal_reserve_ai_spend "${ids[@]}")
check "exactly two of six concurrent reservations succeed (got $won)" '[ "$won" = 2 ]'
check "committed spend never exceeds the stop line" '[ "$(sql "select private.ai_committed_usd() <= stop_at_usd from private.ai_spend_config")" = t ]'
sql "update private.ai_spend_config set stop_at_usd = 18" >/dev/null

echo "== Control: without the config-row lock the same race overshoots"
sql "create function public.unlocked_reserve(p_analysis_id uuid, p_a text, p_r text) returns jsonb language plpgsql security definer set search_path = '' as \$f\$
     begin
       perform pg_sleep(0.2);
       if private.ai_committed_usd() + 0.2204 > (select stop_at_usd from private.ai_spend_config) then raise exception 'BUDGET_EXCEEDED: no room'; end if;
       perform pg_sleep(0.3);
       insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model, analyst_input_bound, analyst_max_output,
         reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price, reviewer_out_price, reserved_usd)
       select a.id, a.case_id, a.business_id, a.requested_by, p_a, p_r, 1, 1, 1, 1, 0, 0, 0, 0, 0.2204 from public.analyses a where a.id = p_analysis_id;
       return jsonb_build_object('reserved_usd', 0.2204);
     end \$f\$; grant execute on function public.unlocked_reserve(uuid, text, text) to service_role;" >/dev/null
ids=(); for i in 1 2 3 4 5 6; do ids+=("$(new_analysis)"); done
age
sql "update private.ai_spend_config set stop_at_usd = private.ai_committed_usd() + 0.4408" >/dev/null
won=$(race unlocked_reserve "${ids[@]}")
check "control: the unlocked version lets more than two through (got $won) — the race is real" '[ "$won" -gt 2 ]'
sql "delete from private.ai_spend_ledger where analysis_id in ($(printf "'%s'," "${ids[@]}" | sed 's/,$//')); drop function public.unlocked_reserve(uuid, text, text); update private.ai_spend_config set stop_at_usd = 18" >/dev/null

echo "== R: twelve reservations race for the founder's limit of 10 per 24 hours"
age
ids=(); for i in $(seq 1 12); do ids+=("$(new_analysis)"); done
won=$(race internal_reserve_ai_spend "${ids[@]}")
check "exactly ten of twelve concurrent reservations succeed (got $won)" '[ "$won" = 10 ]'
check "the founder has exactly 10 attempts in the last 24 hours" '[ "$(sql "select count(*) from private.ai_spend_ledger where created_at > now() - interval '"'"'24 hours'"'"'")" = 10 ]'

echo "== D: five sessions dispatch the same analyst call"
age
a=$(new_analysis)
"${PSQL[@]}" -At -c "$SERVICE" -c "select public.internal_reserve_ai_spend('$a', 'test-cheap', 'test-dear')" >/dev/null
"${PSQL[@]}" -c "begin; lock table private.ai_spend_ledger in exclusive mode; select pg_sleep(1.5); commit;" >/dev/null 2>&1 &
sleep 0.4
for i in 1 2 3 4 5; do "${PSQL[@]}" -At -c "$SERVICE" -c "select public.internal_ai_dispatch('$a', 'ANALYST')" > "$WORK/dsp_$i" 2>&1 & done
wait
ok=$(grep -l '"model"' "$WORK"/dsp_* | wc -l); dup=$(grep -l 'ALREADY_DISPATCHED' "$WORK"/dsp_* | wc -l); rm -f "$WORK"/dsp_*
check "exactly one dispatch wins, four are refused (got $ok / $dup)" '[ "$ok" = 1 ] && [ "$dup" = 4 ]'

echo "== A: abandon races dispatch (15 rounds)"
bad=0; held=0; released=0
for round in $(seq 1 15); do
  age
  a=$(new_analysis)
  "${PSQL[@]}" -At -c "$SERVICE" -c "select public.internal_reserve_ai_spend('$a', 'test-cheap', 'test-dear')" >/dev/null
  # Alternate which side starts first so both orders are exercised.
  if [ $((round % 2)) = 0 ]; then
    "${PSQL[@]}" -At -c "$SERVICE" -c "select public.internal_ai_dispatch('$a', 'ANALYST')" > "$WORK/dispatch" 2>&1 &
    "${PSQL[@]}" -At -c "$FOUNDER" -c "select public.founder_abandon_analysis('$a')" > "$WORK/abandon" 2>&1 &
  else
    "${PSQL[@]}" -At -c "$FOUNDER" -c "select public.founder_abandon_analysis('$a')" > "$WORK/abandon" 2>&1 &
    sleep 0.3
    "${PSQL[@]}" -At -c "$SERVICE" -c "select public.internal_ai_dispatch('$a', 'ANALYST')" > "$WORK/dispatch" 2>&1 &
  fi
  wait
  st=$(sql "select status || '/' || coalesce(settled_by, '-') from private.ai_spend_ledger where analysis_id = '$a'")
  if grep -q '"model"' "$WORK/dispatch"; then
    [ "$st" = "HELD/UNKNOWN_USAGE" ] && held=$((held + 1)) || bad=$((bad + 1))
  else
    [ "$st" = "SETTLED/NO_DISPATCH" ] && released=$((released + 1)) || bad=$((bad + 1))
  fi
done
check "a dispatched call is never released at \$0; an undispatched one always is (held $held, released $released, wrong $bad)" '[ "$bad" = 0 ] && [ $((held + released)) = 15 ]'
check "both orders were exercised (dispatch first and abandon first)" '[ "$held" -gt 0 ] && [ "$released" -gt 0 ]'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]
