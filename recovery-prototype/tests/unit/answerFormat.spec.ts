// INVALID_JSON diagnostics and harmless-formatting handling (offline; fake provider; synthetic data).
// Only whitespace, a byte-order mark and ONE enclosing code fence are removed; nothing is repaired.
import { expect, test } from '@playwright/test';
import { runAnalysisPipeline, unwrapAnswer, type PipelineConfig } from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { analystAnswer, BODY1, BODY2, CASE, CONFIG, DRAFT, FakeDb, FakeProvider, M1, M2, manifest, MemoryLogger, ok, reviewAnswer } from '../pipeline/fakes';

const J = JSON.stringify(analystAnswer());

test('unwrapAnswer: harmless formatting is removed; empty, prose, broken or partly fenced answers are classified, never repaired', () => {
  const cases: [string, string, string | null, string][] = [
    ['plain JSON', J, J, 'JSON'],
    ['surrounding whitespace', `\n  ${J}\n`, J, 'JSON_WHITESPACE'],
    ['byte-order mark', `﻿${J}`, J, 'JSON_BOM'],
    ['```json fence', `\`\`\`json\n${J}\n\`\`\``, J, 'JSON_FENCED'],
    ['``` fence with spaces', `  \`\`\`\n${J}\n\`\`\`  `, J, 'JSON_FENCED'],
    ['empty', '', null, 'EMPTY'],
    ['whitespace only', ' \n\t ', null, 'EMPTY'],
    ['fence with broken JSON', '```json\n{"analysis_status": \n```', null, 'FENCED_MALFORMED'],
    ['two fences', `\`\`\`json\n${J}\n\`\`\`\nAnd another:\n\`\`\`json\n{}\n\`\`\``, null, 'FENCED_MALFORMED'],
    ['prose around JSON', `Here is the analysis: ${J}`, null, 'TEXT_AROUND_JSON'],
    ['prose only', 'Here is my analysis of the conversation.', null, 'NOT_JSON'],
    ['truncated JSON', J.slice(0, 40), null, 'MALFORMED_JSON'],
    ['trailing comma', '{"a": 1,}', null, 'MALFORMED_JSON'],
  ];
  for (const [name, text, body, shape] of cases) expect(unwrapAnswer(text), name).toEqual({ body, shape });
});

async function run(text: string) {
  const db = new FakeDb(await manifest());
  const logger = new MemoryLogger();
  const provider = new FakeProvider({ ANALYST: { text, stopReason: 'end_turn', inputTokens: 1000, outputTokens: 500 } as never, REVIEWER: ok(reviewAnswer('UPHOLD')) as never });
  const r = await runAnalysisPipeline(CASE, { founderDb: db, serviceDb: db, provider, logger, config: { ...CONFIG } as PipelineConfig });
  return { r, db, logger, provider };
}

test('pipeline: wrapped valid JSON completes (logged as normalised, by shape only); strict validation still applies after unwrapping', async () => {
  for (const [text, shape] of [[`\`\`\`json\n${J}\n\`\`\``, 'JSON_FENCED'], [`﻿${J}`, 'JSON_BOM'], [`${J}\n`, 'JSON_WHITESPACE']]) {
    const { r, db, logger } = await run(text);
    expect(r, shape).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
    expect(db.completions[0].proposedMessage, shape).toBe(DRAFT);
    expect(logger.events.find((e) => e.name === 'provider.answer_normalized')?.fields, shape).toMatchObject({ role: 'ANALYST', shape, inputTokens: 1000, outputTokens: 500 });
  }
  const plain = await run(J);
  expect(plain.logger.events.some((e) => e.name === 'provider.answer_normalized')).toBe(false);
  // A fenced answer outside the schema is still rejected by the schema check, not accepted because it unwrapped.
  const offSchema = await run(`\`\`\`json\n${JSON.stringify({ ...analystAnswer(), secret_note: 'x' })}\n\`\`\``);
  expect(offSchema.r).toMatchObject({ outcome: 'FAILED', code: 'SCHEMA_INVALID_ANALYST' });
  const wrongEnum = await run(`\`\`\`json\n${JSON.stringify(analystAnswer(M1, M2, { classification: 'PURPLE' }))}\n\`\`\``);
  expect(wrongEnum.r).toMatchObject({ outcome: 'FAILED', code: 'SCHEMA_INVALID_ANALYST' });
});

test('pipeline: empty, prose, malformed and partly fenced answers fail closed as INVALID_JSON with a shape-only diagnostic; no retry, no extra call', async () => {
  for (const [text, shape] of [['', 'EMPTY'], ['   ', 'EMPTY'], ['Sure! Here is my analysis.', 'NOT_JSON'], [`Analysis: ${J}`, 'TEXT_AROUND_JSON'],
    [J.slice(0, 60), 'MALFORMED_JSON'], ['```json\n{"observations": [\n```', 'FENCED_MALFORMED']]) {
    const { r, db, logger, provider } = await run(text);
    expect(r, shape).toMatchObject({ outcome: 'FAILED', code: 'INVALID_JSON_ANALYST' });
    expect(provider.requests, shape).toHaveLength(1); // the reviewer is never called; nothing is retried
    expect(db.completions[0].output, shape).toBeNull();
    const ev = logger.events.find((e) => e.name === 'provider.answer_unparsable');
    expect(ev?.fields, shape).toEqual({ analysisId: expect.any(String), role: 'ANALYST', shape, chars: text.length, inputTokens: 1000, outputTokens: 500,
      reasoningTokens: null, requestId: null });
    // never the answer, the conversation or a quote from it
    const logs = JSON.stringify(logger.events);
    for (const secret of [BODY1, BODY2, 'Sure! Here is', 'the price feels high', DRAFT]) expect(logs, shape).not.toContain(secret);
  }
});
