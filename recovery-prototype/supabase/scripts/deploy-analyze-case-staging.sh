#!/usr/bin/env bash
# RETIRED (Stage 2A-5d-4c). This script deployed the fake-only analyze-case code and always set
# ANALYSIS_PROVIDER=fake: run today it would silently replace a configured paid (Kimi) provider.
# It now refuses and changes nothing. Use instead:
#   bash supabase/scripts/deploy-analyze-case-2a6d.sh             code only; provider settings untouched
#   bash supabase/scripts/deploy-analyze-case-2a6d.sh --set-fake  code and the fake provider (explicit)
# or the "Supabase staging — paid analysis" GitHub Actions workflow.
echo "REFUSED (nothing deployed): deploy-analyze-case-staging.sh is retired: it would reset the provider to fake. Use supabase/scripts/deploy-analyze-case-2a6d.sh (code only) or --set-fake." >&2
exit 2
