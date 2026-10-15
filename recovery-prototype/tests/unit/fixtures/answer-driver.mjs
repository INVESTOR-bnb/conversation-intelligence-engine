// Test-only: the shared confirmation reader (live-guards.mjs answerReader) as the e2e scripts use
// it — a busy pause (the audit), then two prompts — reporting whether each EXACT phrase was given.
import { answerReader } from '../../../supabase/scripts/live-guards.mjs';
const answers = answerReader();
await new Promise((r) => setTimeout(r, Number(process.env.BUSY_MS ?? 1200)));
const c1 = await answers.ask('\nType PROVIDER-LIMIT-CONFIRMED: ');
process.stdout.write(`\n[c1 ${c1 === 'PROVIDER-LIMIT-CONFIRMED' ? 'ACCEPTED' : 'REFUSED'}]\n`);
if (c1 === 'PROVIDER-LIMIT-CONFIRMED') {
  const c2 = await answers.ask('\nType RUN-ONE-PAID-ANALYSIS: ');
  process.stdout.write(`\n[c2 ${c2 === 'RUN-ONE-PAID-ANALYSIS' ? 'ACCEPTED' : 'REFUSED'}]\n`);
}
answers.close();
