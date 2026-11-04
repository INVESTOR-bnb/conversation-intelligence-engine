#!/usr/bin/env bash
# WhatsApp integration — database rules on a throwaway local PostgreSQL (no network, no secrets):
# the Stage 2A migrations, then supabase/whatsapp/wa_integration.sql, its tests, then the removal script.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54332}"
WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi
cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
PSQL=("${RUNAS[@]}" "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
load() { out="$("${PSQL[@]}" < "$1" 2>&1)" || { echo "$out"; exit 1; }; }

load "$HERE/tests/local/00_supabase_emulation.sql"
for f in "$HERE"/migrations/*.sql; do load "$f"; done
load "$HERE/tests/local/01_test_helpers.sql"
echo "== install supabase/whatsapp/wa_integration.sql"
load "$HERE/whatsapp/wa_integration.sql"
if out="$("${PSQL[@]}" < "$HERE/whatsapp/wa_integration.test.sql" 2>&1)"; then
  echo "PASS wa_integration.test.sql ($(grep -c 'NOTICE:  ok - ' <<<"$out") assertions)"
else
  echo "FAIL wa_integration.test.sql"; grep -E -A3 "ERROR|FAIL" <<<"$out" | head -12 | sed 's/^/     /'; exit 1
fi
echo "== remove (wa_integration_remove.sql)"
load "$HERE/whatsapp/wa_integration_remove.sql"
left="$("${PSQL[@]}" -At -c "select count(*) from pg_proc where proname like 'internal_wa_%' or proname like 'client_wa_%' or proname like 'founder_wa_%' or proname like 'wa\_%'" -c "select count(*) from pg_tables where tablename like 'wa\_%'" | paste -sd' ')"
[ "$left" = "0 0" ] && echo "PASS removal leaves no function or table" || { echo "FAIL removal left: $left"; exit 1; }
