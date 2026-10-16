// Synthetic WhatsApp-style sales conversations for the guarded paid runs (paid-pipeline-e2e.mjs).
// Every business, person, number and amount is INVENTED. One scenario per paid run, chosen with
// PAID_SCENARIO (default: car-price). Each states what a good analysis should and should not do,
// so the founder can judge the real model's output against it (docs/pilot/KIMI-QUALITY-EVALUATION.md).
// The seller in each conversation is the business that submits the case: scenarioText() takes that
// business's name, so a case never shows one business's name on another business's conversation.
// The name in each scenario is only the default when no business name is given.

export const SCENARIOS = Object.freeze({
  'car-price': {
    seller: 'Synthetic Autos A',
    title: 'Car enquiry goes quiet after price and pressure',
    expect: 'Observed: price asked, price defended, "partner and bank" mentioned, a viewing proposed, then the seller asked "still interested?" without answering the viewing request. '
      + 'Should notice the unanswered Saturday request as seller-created friction. Must not invent the buyer\'s budget or motives.',
    lines: (stamp, seller) => [
      `[02/10/2026, 10:02] Synthetic Prospect ${stamp}: Hello, I saw the synthetic 2019 hatchback on your site. Is it still for sale?`,
      `[02/10/2026, 10:15] ${seller}: Yes it is! Great car, one owner, full service history.`,
      '[02/10/2026, 10:17] Synthetic Prospect: Good. What is the best price? The listing says 9,500.',
      `[02/10/2026, 13:40] ${seller}: 9,500 is already a very good price. Lots of people are asking about it.`,
      '[02/10/2026, 13:42] Synthetic Prospect: I understand. I need to check with my partner and my bank first.',
      `[04/10/2026, 09:05] ${seller}: Any news? Someone else wants to see it this weekend.`,
      '[06/10/2026, 18:30] Synthetic Prospect: Sorry, busy week. Could I come on Saturday morning to see it?',
      `[09/10/2026, 08:50] ${seller}: Hello? Are you still interested?`,
    ],
  },
  'academy-price': {
    seller: 'Synthetic Academy B',
    title: 'Course enquiry goes silent after the fee is quoted',
    expect: 'Observed: start date and fee given, prospect asked about instalments, the academy replied only "full payment required" with no alternative. '
      + 'Should treat affordability as a supported inference (the instalment question), not a certainty. A good recommendation addresses the payment question; must not promise discounts the academy never offered.',
    lines: (stamp, seller) => [
      `[05/10/2026, 19:12] Synthetic Prospect ${stamp}: Good evening. I want to ask about the data analysis course. When is the next class?`,
      `[05/10/2026, 19:40] ${seller}: Good evening! Next cohort starts 20 October, 8 weeks, weekends.`,
      '[05/10/2026, 19:41] Synthetic Prospect: How much is it?',
      `[05/10/2026, 19:55] ${seller}: The fee is 250,000.`,
      '[05/10/2026, 20:03] Synthetic Prospect: Ok. Can it be paid in instalments?',
      `[06/10/2026, 11:30] ${seller}: Full payment is required before resumption.`,
      `[09/10/2026, 10:00] ${seller}: Hello, registration closes soon. Should I reserve your seat?`,
    ],
  },
  'too-little': {
    seller: 'Synthetic Academy B',
    title: 'Almost nothing was said',
    expect: 'Only a greeting and a generic reply. The correct result is INSUFFICIENT_EVIDENCE: no psychological hypothesis stated as fact, no confident diagnosis.',
    lines: (stamp, seller) => [
      `[07/10/2026, 08:15] Synthetic Prospect ${stamp}: Hi`,
      `[07/10/2026, 09:02] ${seller}: Hello, how can we help you today?`,
    ],
  },
  'declined': {
    seller: 'Synthetic Realty C',
    title: 'The prospect clearly said no',
    expect: 'The prospect explicitly chose another provider and asked not to be contacted again. The correct result is no recovery message (RED or no contact). Any push to re-engage is a failure.',
    lines: (stamp, seller) => [
      `[03/10/2026, 14:20] Synthetic Prospect ${stamp}: Hello, is the 3-bedroom flat in the listing still available?`,
      `[03/10/2026, 15:05] ${seller}: Yes. Inspection is 10,000 and rent is 4.5m per year.`,
      '[03/10/2026, 15:10] Synthetic Prospect: Ok I will let you know.',
      `[06/10/2026, 09:00] ${seller}: Good morning, are you still interested in the flat?`,
      '[06/10/2026, 12:44] Synthetic Prospect: Thanks, I have taken another place. Please don\'t message me again about it.',
    ],
  },
});

export const DEFAULT_SCENARIO = 'car-price';

/** A business name safe to put in a chat line: one line, no "[" "]" ":" (they delimit the line), at most 80 characters. */
export function sellerName(name) {
  const clean = typeof name === 'string' ? name.replace(/[\[\]:\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return clean || null;
}

/** The scenario's conversation text, the seller named as `business` (default: the scenario's own), or null if the name is unknown. */
export function scenarioText(name, stamp, business) {
  const s = Object.hasOwn(SCENARIOS, name) ? SCENARIOS[name] : null;
  return s ? s.lines(stamp, sellerName(business) ?? s.seller).join('\n') : null;
}
