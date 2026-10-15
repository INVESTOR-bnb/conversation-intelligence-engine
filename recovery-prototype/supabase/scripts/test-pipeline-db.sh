#!/usr/bin/env bash
# Stage 2A-5d-4a: runs the analysis pipeline core (fake provider, no network, no keys)
# against the REAL database contract, on a throwaway local PostgreSQL with the
# Supabase emulation, every migration and the synthetic test helpers. The pipeline
# talks to it through tests/pipeline/psqlDb.ts (founder JWT claims for reads and the
# lock; service_role claims for internal_complete_analysis only).
# INSTALL=deploy installs through the deployment files instead of the migrations.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$(cd "$HERE/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54339}"
WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi
cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

load() { "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 < "$1" >/dev/null || { echo "failed: $1"; exit 1; }; }
load "$HERE/tests/local/00_supabase_emulation.sql"
if [ "${INSTALL:-migrations}" = deploy ]; then
  for f in stage2a1 stage2a4b stage2a4c stage2a4c1 stage2a5a stage2a5b stage2a5d1 stage2a5d2 stage2a5d3a stage2a6a stage2a6c stage2a6e; do load "$HERE/deploy/${f}_deploy.sql"; done
else
  for f in "$HERE"/migrations/*.sql; do load "$f"; done
fi
load "$HERE/tests/local/01_test_helpers.sql"

cd "$APP"
echo "== deno check of the Edge Function entry point (Deno 2.1.4 via npx)"
npx --yes deno@2.1.4 check supabase/functions/analyze-case/index.ts
PIPELINE_PGHOST="$WORK" PIPELINE_PGPORT="$PORT" PIPELINE_PSQL="$PGBIN/psql" npx playwright test --config playwright.pipeline.config.ts "$@"
