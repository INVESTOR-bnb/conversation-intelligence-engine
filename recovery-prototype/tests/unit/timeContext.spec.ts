// Reliability regression (live v7 run, DASH-PAID-20261108175930): the analyst and reviewer must know the analysis
// date. Before v8 neither call received any date, so a "Saturday" written in October could not be recognised as past.
import { expect, test } from '@playwright/test';
import { runAnalysisPipeline, type PipelineConfig } from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { analysisContext, ANALYST_SYSTEM, REVIEWER_SYSTEM } from '../../supabase/functions/_shared/analysis-pipeline/prompts.ts';
import { analystAnswer, BODY1, CASE, CONFIG, FakeDb, FakeProvider, manifest, MemoryLogger, ok, reviewAnswer } from '../pipeline/fakes';

const flat = (t: string) => t.replace(/\s+/g, ' ');
const NOV8 = Date.UTC(2026, 10, 8, 17, 59, 30); // the live run: Sunday 8 November 2026
const textOf = (parts: { type: string; text?: string }[]) => parts.map((p) => p.text ?? '').join('\n');

test('analysis context: the business\'s local date and weekday (Africa/Lagos), marked as not evidence', () => {
  expect(analysisContext(NOV8)).toEqual({ type: 'text', text: '<analysis_context>{"analysis_date":"2026-11-08","weekday":"Sunday","time_zone":"Africa/Lagos"}</analysis_context>' });
  expect(analysisContext(Date.UTC(2026, 9, 10, 12)).text).toContain('"analysis_date":"2026-10-10","weekday":"Saturday"');
  expect(flat(ANALYST_SYSTEM)).toContain('The <analysis_context> block is NOT evidence');
});

test('midnight boundary: 23:30 UTC on Saturday 7 Nov is already Sunday 8 Nov in Lagos (UTC+1); 22:59 UTC is still Saturday', () => {
  expect(analysisContext(Date.UTC(2026, 10, 7, 23, 30)).text).toContain('"analysis_date":"2026-11-08","weekday":"Sunday","time_zone":"Africa/Lagos"');
  expect(analysisContext(Date.UTC(2026, 10, 7, 22, 59)).text).toContain('"analysis_date":"2026-11-07","weekday":"Saturday"');
  expect(analysisContext(Date.UTC(2026, 10, 7, 23, 0)).text).toContain('"analysis_date":"2026-11-08"'); // exactly midnight in Lagos
  // the old UTC behaviour would have said Saturday at 23:30 UTC
  expect(analysisContext(Date.UTC(2026, 10, 7, 23, 30), 'UTC').text).toContain('"analysis_date":"2026-11-07","weekday":"Saturday"');
});

test('R2 a 30-day gap: both calls receive the analysis date first, before the (unchanged) evidence; no extra call', async () => {
  const db = new FakeDb(await manifest());
  const provider = new FakeProvider({ ANALYST: ok(analystAnswer()) as never, REVIEWER: ok(reviewAnswer('UPHOLD')) as never });
  const r = await runAnalysisPipeline(CASE, { founderDb: db, serviceDb: db, provider, logger: new MemoryLogger(), config: { ...CONFIG, now: () => NOV8 } as PipelineConfig });
  expect(r).toMatchObject({ outcome: 'COMPLETED' });
  expect(provider.requests.map((x) => x.role)).toEqual(['ANALYST', 'REVIEWER']);
  for (const req of provider.requests) {
    expect(req.content[0]).toEqual(analysisContext(NOV8));
    expect(textOf(req.content as never)).toContain(JSON.stringify(BODY1).slice(1, 30)); // the evidence is still there, after the context
  }
});

test('R1/R2 prompts: timeline from the analysis date; historical vs current intent; past appointments; weekdays; elapsed time is uncertainty', () => {
  for (const rule of ['<analysis_context> gives today\'s date and weekday', 'may be day/month or month/day',
    'Interest shown weeks ago is HISTORICAL intent, not current intent', 'elapsed time is an uncertainty, never proof that interest is lost',
    'if it has passed, say so and never treat it as still valid', 'Check any weekday against its date before using it',
    'Never propose or confirm a date, day or time the seller has not confirmed: that is a VERIFY FIRST']) {
    expect(flat(ANALYST_SYSTEM), rule).toContain(flat(rule));
  }
  expect(flat(REVIEWER_SYSTEM)).toContain('treat a past date, day or appointment as still valid, misstate a weekday, or treat old interest as current');
});

test('R5/R6 prompts: silence is unresolved, one reply proves nothing, competing explanations can both be true', () => {
  for (const rule of ['a specific observable reply or action that genuinely contradicts it, such as stating a different reason or acting against it',
    'A reply that simply does not mention the topic does not challenge it either', 'Silence or no reply is UNRESOLVED',
    'never write it as what would confirm or challenge the hypothesis', 'One supporting reply would not prove the hypothesis',
    'Competing explanations can both be true', 'choose a move that helps whichever holds',
    'DECISION HYPOTHESIS:', 'WHY THIS MOVE:', 'IF RIGHT, EXPECT:', 'WOULD CHALLENGE IT:']) {
    expect(flat(ANALYST_SYSTEM), rule).toContain(flat(rule));
  }
  expect(flat(REVIEWER_SYSTEM)).toContain('rely on silence, no reply, or the prospect simply not mentioning something, instead of genuinely contradicting evidence?');
});
