#!/usr/bin/env bash
# Stage 2A-4c concurrency tests with REAL concurrent PostgreSQL sessions
# (separate psql connections, each signed in as a client role). Interleavings
# are made deterministic with held locks and committed-later transactions:
#
#   F  a file is uploaded WHILE client_finalize_screenshots is running
#      (finalize is held just before its INSERT by a SHARE lock on
#      case_screenshots); the late file must not be recorded unchecked.
#      Control: the pre-fix function (d10e27c) DOES record it — proving the
#      test reproduces the defect.
#   G  a CONFORMING file (same uploader, correct type) committed while finalize
#      runs, at a position that leaves a gap: per-file checks alone would
#      accept it; only the snapshot keeps it from bypassing the gap check.
#   D  two different files uploaded at the same position at the same time
#      (both pass the upload rule); finalize must reject and record nothing.
#   S  a file uploaded WHILE client_submit_case is running (uncommitted);
#      it must never be recorded; uploads after the commit are refused.
#
# Local emulation of Supabase (Storage API behaviour itself is not emulated).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54333}"
WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi
cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
PSQL=("${RUNAS[@]}" "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
load() { "${PSQL[@]}" < "$1" >/dev/null; }
sql() { "${PSQL[@]}" -At -c "$1"; }
# as <uid> <sql>: one session signed in as that user (role authenticated).
as() { "${PSQL[@]}" -At -c "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub', '$1', 'role', 'authenticated')::text, false);" -c "$2" 2>&1 | tail -n +2; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

load "$HERE/tests/local/00_supabase_emulation.sql"
for f in "$HERE"/migrations/*.sql; do load "$f"; done
load "$HERE/tests/local/01_test_helpers.sql"
sql "select tests.seed()" >/dev/null   # committed: founder, businesses A/B, clients a, a2, b
A=00000000-0000-4000-8000-00000000000a; A2=00000000-0000-4000-8000-0000000000a2
BIZ=10000000-0000-4000-8000-00000000000a
hex() { printf "$1%.0s" {1..64}; }
up() { # up <uid> <case> <pos> <hexchar> <ext> <mime>
  as "$1" "insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', '$BIZ/$2/$3-$(hex "$4").$5', auth.uid()::text, '{\"size\": 1000, \"mimetype\": \"$6\"}')"; }
new_case() { as "$A" "select public.client_create_case(gen_random_uuid(), '$1', 'Synthetic', 'Referral', 'SCREENSHOTS')" | tail -1; }
recorded() { sql "select coalesce(string_agg(position::text, ',' order by position), '') from public.case_screenshots where case_id = '$1'"; }

# hold_finalize <case> <tag> <upload...>: runs finalize for <case>, holds it
# right before its INSERT with a SHARE lock, and commits the given uploads
# ("uid pos hexchar ext mime") meanwhile. Prints how many sessions were waiting.
hold_finalize() {
  local c=$1 tag=$2; shift 2
  "${PSQL[@]}" -c "begin; lock table public.case_screenshots in share mode; select pg_sleep(3); commit;" >/dev/null 2>&1 &
  local locker=$!
  sleep 0.7
  as "$A" "select public.client_finalize_screenshots('$c')" > "$WORK/fin_$tag.out" 2>&1 &
  local fin=$!
  sleep 0.7
  sql "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like '%client_finalize_screenshots%'"
  local u; for u in "$@"; do set -- $u; up "$1" "$c" "$2" "$3" "$4" "$5" >> "$WORK/up_$tag.out" 2>&1; done
  wait "$fin" "$locker" || true
}

# Scenario F: finalize is held right before its INSERT while two non-conforming
# files are uploaded and committed: one by another member of the same business
# (wrong uploader) and one with a declared type that does not match its extension.
scenario_f() {
  local c; c=$(new_case "$1")
  up "$A" "$c" 1 a png image/png >/dev/null
  local waiting; waiting=$(hold_finalize "$c" "$1" "$A2 2 b png image/png" "$A 3 c jpg image/png")
  echo "$c|$waiting"
}

echo "== F: uploads committed while finalize runs"
load "$HERE/tests/local/regressions/finalize_before_race_fix.sql"
res=$(scenario_f F-OLD); c=${res%%|*}
check "control: finalize was really blocked mid-run when the uploads committed" '[ "${res##*|}" = 1 ]'
check "control: both late uploads were accepted by the upload rule" '[ "$(sql "select count(*) from storage.objects where name like '"'"'%/$c/%'"'"'")" = 3 ]'
check "control: the PRE-FIX function records the unchecked files (defect reproduced)" '[ "$(recorded "$c")" = "1,2,3" ]'
for f in "$HERE"/migrations/20261012120000_stage2a4c_screenshots.sql; do
  sed -n '/^create function public.client_finalize_screenshots/,/^end \$\$;/p' "$f" | sed 's/^create function/create or replace function/' > "$WORK/fixed.sql"
done
load "$WORK/fixed.sql"
res=$(scenario_f F-NEW); c=${res%%|*}
check "fixed: finalize was really blocked mid-run when the uploads committed" '[ "${res##*|}" = 1 ]'
check "fixed: only the checked file is recorded (late files ignored)" '[ "$(recorded "$c")" = "1" ] && grep -q "\"added\": 1" "$WORK/fin_F-NEW.out"'
fin2=$(as "$A" "select public.client_finalize_screenshots('$c')" 2>&1 || true)
check "fixed: the next finalize sees the late files and refuses them (nothing more recorded)" 'grep -q "screenshot failed checks at positions 2,3" <<<"$fin2" && [ "$(recorded "$c")" = "1" ]'
sub=$(as "$A" "select public.client_submit_case('$c'); select workflow_state from public.cases where id = '$c'" 2>&1 || true)
check "fixed: submitting records nothing new; only the checked file is evidence" '[ "$(recorded "$c")" = "1" ]'

echo "== G: a conforming file that leaves a gap, committed while finalize runs"
load "$HERE/tests/local/regressions/finalize_before_race_fix.sql"
c=$(new_case G-OLD); up "$A" "$c" 1 a png image/png >/dev/null
waiting=$(hold_finalize "$c" G-OLD "$A 3 c png image/png")
check "control: the PRE-FIX function records 1 and 3 — a gap its own check forbids (defect reproduced)" '[ "$waiting" = 1 ] && [ "$(recorded "$c")" = "1,3" ]'
load "$WORK/fixed.sql"
c=$(new_case G); up "$A" "$c" 1 a png image/png >/dev/null
waiting=$(hold_finalize "$c" G "$A 3 c png image/png")
check "finalize was really blocked mid-run when the upload committed" '[ "$waiting" = 1 ]'
check "the late conforming file is not recorded by the running finalize" 'grep -q "\"added\": 1" "$WORK/fin_G.out" && [ "$(recorded "$c")" = "1" ]'
fin2=$(as "$A" "select public.client_finalize_screenshots('$c')" 2>&1 || true)
check "the next finalize applies the gap check to it and records nothing more" 'grep -q "missing screenshots at positions 2" <<<"$fin2" && [ "$(recorded "$c")" = "1" ]'
up "$A" "$c" 2 b png image/png >/dev/null
fin3=$(as "$A" "select public.client_finalize_screenshots('$c')" 2>&1 || true)
check "once the gap is filled, all three are checked and recorded" '[ "$(recorded "$c")" = "1,2,3" ] && grep -q "\"added\": 2" <<<"$fin3"'

echo "== D: two different files uploaded at the same position at the same time"
c=$(new_case D)
as "$A" "begin; insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', '$BIZ/$c/1-$(hex a).png', auth.uid()::text, '{\"size\": 1000, \"mimetype\": \"image/png\"}'); select pg_sleep(2); commit;" >/dev/null 2>&1 &
first=$!
sleep 0.7
second=$(up "$A" "$c" 1 b png image/png 2>&1 || true)
wait "$first" || true
check "both concurrent uploads passed the upload rule (it is NOT a concurrency guarantee)" '[ "$(sql "select count(*) from storage.objects where name like '"'"'%/$c/1-%'"'"'")" = 2 ]'
fin=$(as "$A" "select public.client_finalize_screenshots('$c')" 2>&1 || true)
check "finalize rejects the duplicate position and records nothing" 'grep -q "conflicting screenshots at positions 1" <<<"$fin" && [ -z "$(recorded "$c")" ]'
st=$(as "$A" "select public.client_screenshot_status('$c')")
check "status shows the conflict to the owner (two files at position 1)" '[ "$(grep -o "\"position\": 1" <<<"$st" | wc -l)" = 2 ]'
other=$(as 00000000-0000-4000-8000-00000000000b "select public.client_screenshot_status('$c')" 2>&1 || true)
check "another business cannot see the conflicting draft" 'grep -q "NOT_FOUND" <<<"$other"'

echo "== S: upload while client_submit_case is running"
c=$(new_case S)
up "$A" "$c" 1 a png image/png >/dev/null
as "$A" "select public.client_finalize_screenshots('$c')" >/dev/null
as "$A" "begin; select public.client_submit_case('$c'); select pg_sleep(2); commit;" >/dev/null 2>&1 &
sub=$!
sleep 0.7
during=$(up "$A" "$c" 2 b png image/png 2>&1 && echo ACCEPTED || echo REFUSED)
wait "$sub" || true
after=$(up "$A" "$c" 3 c png image/png 2>&1 || true)
fin=$(as "$A" "select public.client_finalize_screenshots('$c')" 2>&1 || true)
check "case is submitted" '[ "$(sql "select workflow_state from public.cases where id = '"'"'$c'"'"'")" = SUBMITTED ]'
check "an upload during the uncommitted submit may land (documented), but is never recorded" '[ "$(recorded "$c")" = "1" ]'
echo "      (upload during submit: $(tail -1 <<<"$during"))"
check "uploads after the submit commits are refused" 'grep -q "row-level security" <<<"$after"'
check "finalize after submission is refused" 'grep -q "INVALID_STATE" <<<"$fin"'

echo "== R: a recorded draft file deleted under retention, then finalize again"
c=$(new_case R); up "$A" "$c" 1 a png image/png >/dev/null; up "$A" "$c" 2 b png image/png >/dev/null
as "$A" "select public.client_finalize_screenshots('$c')" >/dev/null
sql "delete from storage.objects where name like '%/$c/2-%'" >/dev/null   # as the retention runbook would
fin=$(as "$A" "select public.client_finalize_screenshots('$c')" 2>&1 || true)
check "finalize refuses when a record no longer matches a stored file" 'grep -q "recorded screenshots do not match the checked files" <<<"$fin" && [ "$(recorded "$c")" = "1,2" ]'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]
