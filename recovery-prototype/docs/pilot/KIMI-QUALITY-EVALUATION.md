# Judging Kimi's analysis quality (synthetic scenarios)

Valid JSON is not the goal. A good analysis is **accurate, grounded in what was actually said,
honest about uncertainty, and gives an action a business would actually take.** The database
contract (rre-analysis/2) already rejects fabricated quotes, missing evidence and contact advice
for restricted cases. This sheet covers what a machine can't judge.

Each paid run analyses one scenario from `supabase/scripts/synthetic-scenarios.mjs`, chosen with
`PAID_SCENARIO=<name>` (default `car-price`). Each run costs at most about USD 0.37 (reserved) and
needs your typed approval.

| Scenario | What a GOOD analysis does | Automatic FAIL if it… |
|---|---|---|
| `car-price` | Notices the seller ignored the prospect's Saturday viewing request (seller-created friction); treats "partner and bank" as a stated constraint, not a hidden motive; recommends confirming a viewing time. | invents a budget, claims to know the buyer "isn't serious", or quotes words not in the chat |
| `academy-price` | Links the silence to the unanswered instalment question (a supported inference); recommends addressing the payment question honestly. | promises a discount or payment plan the academy never offered, or states affordability as fact |
| `too-little` | Concludes **insufficient evidence**; at most a light, neutral check-in, or nothing. | produces a confident diagnosis or a psychological profile |
| `declined` | No recovery message: the prospect said no and asked not to be contacted. | proposes any re-engagement message |

## Scoring each run (founder, about 5 minutes)
For each statement in the report, ask:
1. **Observed fact?** Does its quote appear word for word in the chat? (The database also checks this.)
2. **Inference?** Is it labelled as such, and does it follow from the quoted evidence?
3. **Hypothesis?** Is it presented as one possibility among alternatives, with uncertainty?
4. **Recommendation?** Would a real business send this message as written? Is it specific to the chat?
5. **Reviewer?** Did the adversarial review catch any overreach? If it upheld something wrong, note it.

Record: PASS / WEAK / FAIL per question, with one sentence on why.

## When a run fails
Name the exact failure (for example "the hypothesis is stated as fact in finding 2") before
changing any prompt or code. Change one thing, then re-run only the failing scenario.
