// V0 commercial workflow helpers (pure, testable): running an analysis, the founder's decision,
// and the business's follow-up. Every rule here is ALSO enforced by the database functions
// (founder_approve, client_record_sent, client_add_response, client_record_outcome); these
// checks only give a clear message before the request is sent.

import type { Classification } from '../domain/types';
import { caseErrorMessage } from './cases';

// ---------------------------------------------------------------- running an analysis (analyze-case)

/** States in which the founder may start an analysis (founder_start_analysis accepts exactly these). */
export const ANALYSABLE_STATES = ['SUBMITTED', 'PROSPECT_REPLIED', 'REANALYZING'] as const;
export const canRunAnalysis = (state: string) => (ANALYSABLE_STATES as readonly string[]).includes(state);

/** Plain-language result of one analyze-case call ({outcome, code} from the Edge Function). */
export function analysisRunMessage(outcome: string, code: string): { tone: 'info' | 'warn'; text: string } {
  if (outcome === 'COMPLETED' && code === 'RECOMMENDATION_REJECTED_BY_REVIEW') {
    return { tone: 'warn', text: 'Analysis complete. The independent review rejected the recommendation, so no message is proposed. Read the review below.' };
  }
  if (outcome === 'COMPLETED' && code === 'INSUFFICIENT_EVIDENCE') return { tone: 'warn', text: 'Analysis complete: there is not enough evidence for findings. See what is missing below.' };
  if (outcome === 'COMPLETED') return { tone: 'info', text: 'Analysis complete. Review it below before any decision.' };
  const known: Record<string, string> = {
    SPENDING_DISABLED: 'AI spending is switched off, so no analysis was started. (Paid analysis is enabled only for a founder-approved run.)',
    BUDGET_EXCEEDED: 'The AI budget limit is reached. No analysis was started.',
    RESERVATION_TOO_LARGE: 'This conversation is too long for the per-analysis cost limit. No analysis was started.',
    MODEL_NOT_PRICED: 'The AI model is not enabled for analysis. No analysis was started.',
    PROVIDER_NOT_CONFIGURED: 'The analysis service is not configured. No analysis was started.',
    MODEL_PRICE_NOT_CONFIGURED: 'The deployed analysis service has no price for this model. No analysis was started.',
    PAID_PROVIDER_TEXT_ONLY: 'The AI model can only analyse pasted text, not screenshots. No analysis was started.',
    CONTACT_RESTRICTED: 'Contact with this prospect is restricted. No analysis was started.',
    INSUFFICIENT_EVIDENCE: 'There is no usable evidence in this case. No analysis was started.',
    INVALID_STATE: 'This case cannot be analysed in its current state. Reload the page.',
    RATE_LIMITED: 'Too many analyses were started recently. Try again later.',
    ORIGIN_NOT_ALLOWED: 'The analysis service does not accept requests from this site.',
    FORBIDDEN: 'Only the founder can start an analysis.',
    TIMEOUT: 'The AI did not answer in time. The analysis failed and its cost is held for reconciliation.',
    CONTRACT_REJECTED: 'The AI output did not pass the evidence contract (for example a quote that is not in the conversation). Nothing was kept.',
  };
  if (outcome === 'LOCK_HELD') return { tone: 'warn', text: 'An analysis of this case is already running. Wait, then reload.' };
  const text = known[code] ?? known[code.replace(/_(ANALYST|REVIEWER)$/, '')];
  if (text) return { tone: 'warn', text };
  if (outcome === 'NOT_STARTED') return { tone: 'warn', text: `No analysis was started (${code}).` };
  return { tone: 'warn', text: `The analysis did not complete (${outcome} / ${code}). No findings were kept.` };
}

// ---------------------------------------------------------------- the founder's decision (founder_approve)

export type ApprovalType = 'UNCHANGED' | 'EDITED' | 'MARKED_RED';

/** What the business is told for each classification, until the founder edits it. Never analysis content. */
export const CLIENT_TEXT_DEFAULTS: Record<Classification, { deal: string; next: string }> = {
  GREEN: { deal: 'The prospect is worth one follow-up.', next: 'Send the message below once, then record here what happens.' },
  YELLOW: { deal: 'The prospect may still be interested, but it is not clear.', next: 'Send the message below once, then record here what happens.' },
  RED: { deal: 'Further contact with this prospect is not recommended.', next: 'Do not contact this prospect again about this enquiry.' },
};

export const DECISION_LIMITS = { message: 2000, deal: 500, next: 300 } as const;

export interface Decision { classification: Classification | null; message: string; deal: string; next: string }
export type DecisionErrors = Partial<Record<keyof Decision, string>>;

export function validateDecision(d: Decision, restricted: boolean): DecisionErrors {
  const e: DecisionErrors = {};
  const len = (s: string) => s.trim().length;
  if (!d.classification) e.classification = 'Choose GREEN, YELLOW or RED.';
  else if (restricted && d.classification !== 'RED') e.classification = 'Contact is restricted: only RED is possible.';
  if (d.classification && d.classification !== 'RED') {
    if (len(d.message) < 1) e.message = 'Write the message the business will send.';
    else if (len(d.message) > DECISION_LIMITS.message) e.message = `Use at most ${DECISION_LIMITS.message} characters.`;
  }
  if (len(d.deal) < 1 || len(d.deal) > DECISION_LIMITS.deal) e.deal = `Write 1–${DECISION_LIMITS.deal} characters.`;
  if (len(d.next) < 1 || len(d.next) > DECISION_LIMITS.next) e.next = `Write 1–${DECISION_LIMITS.next} characters.`;
  return e;
}

/** The approval type the database expects (founder_approve checks UNCHANGED against the AI proposal). */
export function approvalType(classification: Classification, message: string | null, aiClassification: string | null, aiMessage: string | null): ApprovalType {
  const msg = message?.trim() ? message.trim() : null;
  if (classification === aiClassification && msg === (aiMessage?.trim() || null)) return 'UNCHANGED';
  return classification === 'RED' ? 'MARKED_RED' : 'EDITED';
}

// ---------------------------------------------------------------- the business's follow-up

export const OUTCOME_STATES = ['WON', 'LOST', 'PAUSED', 'DISQUALIFIED'] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];
export const OUTCOME_LABELS: Record<OutcomeState, string> = {
  WON: 'Won — the prospect paid', LOST: 'Lost — the prospect said no or went elsewhere', PAUSED: 'Paused — try again later', DISQUALIFIED: 'Not a real prospect',
};

export interface OutcomeInput { state: OutcomeState | ''; dealValue: string; amountPaid: string; paymentDate: string; note: string }
export type OutcomeErrors = Partial<Record<keyof OutcomeInput, string>>;

const AMOUNT = /^\d+(\.\d{1,2})?$/;
export function validateOutcome(o: OutcomeInput, today: string): OutcomeErrors {
  const e: OutcomeErrors = {};
  if (!o.state) e.state = 'Choose what happened.';
  if (o.state === 'WON') {
    const paid = o.amountPaid.replace(/,/g, '').trim();
    if (!AMOUNT.test(paid) || Number(paid) <= 0) e.amountPaid = 'Enter the amount paid, in numbers only.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.paymentDate)) e.paymentDate = 'Choose the payment date.';
    else if (o.paymentDate > today) e.paymentDate = 'The payment date cannot be in the future.';
    const value = o.dealValue.replace(/,/g, '').trim();
    if (value && !AMOUNT.test(value)) e.dealValue = 'Enter numbers only, or leave it empty.';
  }
  if (o.note.length > 1000) e.note = 'Use at most 1000 characters.';
  return e;
}

/** A WhatsApp link that opens WhatsApp with the text filled in. The business still chooses the chat and presses send. */
export const whatsappLink = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

/** Plain-language messages for the workflow functions' refusals (database texts start with a code). */
export function actionErrorMessage(err: unknown): string {
  const msg = ((err ?? {}) as { message?: string }).message ?? '';
  if (/^STALE_ANALYSIS/.test(msg)) return 'The evidence or analysis changed while you were reviewing. Reload and review the latest analysis.';
  if (/^CONTACT_RESTRICTED/.test(msg)) return 'Contact with this prospect is restricted. Only a RED decision is possible, and nothing can be sent.';
  if (/^INVALID_STATE/.test(msg)) return 'This case has moved on since the page was loaded. Reload the page.';
  if (/^RATE_LIMITED/.test(msg)) return 'Too many replies were added today for this case. Try again tomorrow.';
  if (/^VALIDATION: a won deal/.test(msg)) return 'A won deal needs the amount paid and the payment date.';
  if (/^VALIDATION: (.+)/.test(msg)) return `Not accepted: ${msg.replace(/^VALIDATION: /, '')}.`;
  return caseErrorMessage(err);
}
