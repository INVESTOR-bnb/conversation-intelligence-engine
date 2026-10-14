-- Stage 2A-6c — prices for the two approved Anthropic models, INACTIVE.
-- No AI is connected; no provider credential exists; spending stays disabled.
--
-- Two rows are added to private.ai_model_prices and nothing else changes: no table,
-- column, function, policy, privilege, setting or existing row (the fake provider's
-- row is untouched).
--
-- Values (official models overview and pricing pages, checked 2026-10-14):
--   claude-opus-5-5    USD 4 input / 20 output per million tokens; model maximum output 128,000
--   claude-sonnet-5-5  USD 2 input / 10 output per million tokens; model maximum output 128,000
-- These are the standard, global-inference prices. They must equal the code allowlist
-- (supabase/functions/_shared/edge/anthropicProvider.ts, ANTHROPIC_MODELS) exactly: before
-- every dispatch the pipeline compares the prices and cap snapshotted in the reservation
-- with the allowlist and refuses any difference (SPEND_TERMS_MISMATCH). The tests compare
-- this file with the allowlist.
--
-- max_output_tokens = 8,000 for both: the per-call output cap the reservation prices and the
-- request's max_tokens. It is a provisional cap (the paid evaluation should calibrate it):
-- thinking tokens count as output, and each call has 55 seconds.
--
-- active = false: the reservation function refuses inactive models (MODEL_NOT_PRICED), so
-- neither model can be reserved, and so neither can be called, until a separately approved
-- step activates it. The budget (USD 20), stop threshold (USD 18), USD 1 per-analysis limit
-- and the disabled state are not touched.
--
-- What one analysis may cost under the existing reservation formula (E = 6 x text bytes +
-- 64 per message; the analyst input bound = 8000 + E; the reviewer's = 8000 + E + 2 x 8000):
--   Opus analyst + Opus reviewer      0.448 + 8E/1e6   -> fits USD 1 up to E ~ 69,000 (about 11 KB of text)
--   Opus analyst + Sonnet reviewer    0.320 + 6E/1e6   -> up to E ~ 113,000 (about 18 KB)
--   Sonnet analyst + Sonnet reviewer  0.224 + 4E/1e6   -> up to E ~ 194,000 (about 32 KB)
-- Larger cases are refused by the existing USD 1 limit (RESERVATION_TOO_LARGE).
--
-- Rollback: supabase/deploy/stage2a6c_rollback.sql (removes the two rows while inactive and unused).

insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note) values
  ('claude-opus-5-5', 4, 20, 8000, false, 'Stage 2A-6c: Anthropic list price, standard tier, global inference (checked 2026-10-14). Inactive until separately approved.'),
  ('claude-sonnet-5-5', 2, 10, 8000, false, 'Stage 2A-6c: Anthropic list price, standard tier, global inference (checked 2026-10-14). Inactive until separately approved.');
