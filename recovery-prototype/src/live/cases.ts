// Stage 2A-4b case logic: input checks mirroring the database, error wording,
// and status labels. The database enforces every rule; nothing here grants access.

export const LEAD_SOURCES = [
  'Facebook / Instagram Ads', 'Google', 'Referral', 'Website', 'Organic Social', 'Walk-in', 'Unknown', 'Other',
] as const;

export const LIMITS = { reference: 40, product: 200, context: 2000, conversationMin: 20, conversationMax: 20000 } as const;

export interface CaseInput {
  reference: string;
  productService: string;
  leadSource: string;
  estimatedValue: string;
  lastInteractionDate: string;
  clientContext: string;
  conversation: string;
}

export interface CleanCase {
  reference: string;
  productService: string;
  leadSource: string;
  estimatedValue: number | null;
  lastInteractionDate: string | null;
  clientContext: string | null;
  conversation: string;
}

export type CaseErrors = Partial<Record<keyof CaseInput, string>>;

export function validateCase(
  input: CaseInput,
  today: string = new Date().toISOString().slice(0, 10),
  source: 'TEXT' | 'SCREENSHOTS' = 'TEXT',
): { value?: CleanCase; errors: CaseErrors } {
  const errors: CaseErrors = {};
  const reference = input.reference.trim();
  const productService = input.productService.trim();
  const clientContext = input.clientContext.trim();
  const conversation = input.conversation.trim();
  const valueText = input.estimatedValue.trim().replace(/,/g, '');

  if (!reference) errors.reference = 'Enter a reference, for example TEST-001.';
  else if (reference.length > LIMITS.reference) errors.reference = `Use at most ${LIMITS.reference} characters.`;
  if (!productService) errors.productService = 'Enter the product or service.';
  else if (productService.length > LIMITS.product) errors.productService = `Use at most ${LIMITS.product} characters.`;
  if (!(LEAD_SOURCES as readonly string[]).includes(input.leadSource)) errors.leadSource = 'Choose a lead source.';

  let estimatedValue: number | null = null;
  if (valueText) {
    if (!/^\d+(\.\d{1,2})?$/.test(valueText) || Number(valueText) > 999_999_999_999) errors.estimatedValue = 'Enter an amount in numbers only, for example 450000.';
    else estimatedValue = Number(valueText);
  }
  const date = input.lastInteractionDate.trim();
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) errors.lastInteractionDate = 'Choose a valid date.';
  else if (date && date > today) errors.lastInteractionDate = 'The last contact cannot be in the future.';
  if (clientContext.length > LIMITS.context) errors.clientContext = `Use at most ${LIMITS.context} characters.`;
  if (source === 'SCREENSHOTS') {
    // Screenshots replace the pasted conversation; nothing to check here.
  } else if (conversation.length < LIMITS.conversationMin) errors.conversation = `Paste the conversation (at least ${LIMITS.conversationMin} characters).`;
  else if (conversation.length > LIMITS.conversationMax) errors.conversation = `The conversation is too long (maximum ${LIMITS.conversationMax.toLocaleString('en')} characters).`;

  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    value: { reference, productService, leadSource: input.leadSource, estimatedValue, lastInteractionDate: date || null, clientContext: clientContext || null, conversation: source === 'SCREENSHOTS' ? '' : conversation },
  };
}

export const CASE_MESSAGES = {
  FORBIDDEN: 'You do not have permission to do this. Your account may not be linked to a business.',
  SESSION: 'Your session has expired. Sign out and sign in again.',
  OFFLINE: 'Could not reach the server. Check your connection and try again — nothing will be duplicated.',
  RATE_LIMITED: 'Your business has reached today’s limit of 20 new cases. Try again tomorrow.',
  TOO_SHORT: 'The pasted conversation is too short.',
  NOT_FOUND: 'That case was not found.',
  INVALID: 'Some details were rejected. Check the fields and try again.',
  UNKNOWN: 'Something went wrong. Please try again.',
} as const;

interface RpcError { code?: string; message?: string; name?: string }

export function caseErrorMessage(err: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return CASE_MESSAGES.OFFLINE;
  const e = (err ?? {}) as RpcError;
  const code = e.code ?? '';
  const msg = e.message ?? '';
  if (code === 'PGRST301' || code === 'PGRST302' || /jwt/i.test(msg)) return CASE_MESSAGES.SESSION;
  if (code === '42501' || /^FORBIDDEN\b/.test(msg) || /permission denied/i.test(msg)) return CASE_MESSAGES.FORBIDDEN;
  if (/^RATE_LIMITED/.test(msg)) return CASE_MESSAGES.RATE_LIMITED;
  if (/^VALIDATION: pasted conversation is too short/.test(msg)) return CASE_MESSAGES.TOO_SHORT;
  if (/^NOT_FOUND/.test(msg)) return CASE_MESSAGES.NOT_FOUND;
  if (/^VALIDATION/.test(msg) || code === '23514' || code === '22001' || code === '22P02' || /check constraint/i.test(msg)) return CASE_MESSAGES.INVALID;
  if (e.name === 'TypeError' || /failed to fetch|network/i.test(msg)) return CASE_MESSAGES.OFFLINE;
  return CASE_MESSAGES.UNKNOWN;
}

/** A submit that fails because the case is no longer a draft means an earlier attempt already succeeded. */
export function isAlreadySubmitted(err: unknown): boolean {
  return /^INVALID_STATE: only draft cases can be submitted/.test(((err ?? {}) as RpcError).message ?? '');
}

/** Labels for the client-safe status returned by client_list_cases. */
export const CLIENT_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft — not submitted',
  UNDER_REVIEW: 'Under review',
  ACTION_REQUIRED: 'Action required',
  WAITING: 'Waiting for prospect',
  WON: 'Won',
  LOST: 'Lost',
  PAUSED: 'Paused',
  DISQUALIFIED: 'Disqualified',
};

export const clientStatusLabel = (s: string) => CLIENT_STATUS_LABELS[s] ?? 'In progress';

/** Founder-facing labels for the internal workflow state. */
export const FOUNDER_STATE_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted — awaiting analysis',
  ANALYZING: 'Analysing',
  AWAITING_ADMIN_REVIEW: 'Awaiting your review',
  CLIENT_ACTION_REQUIRED: 'With client',
  WAITING_FOR_PROSPECT: 'Waiting for prospect',
  PROSPECT_REPLIED: 'Prospect replied',
  REANALYZING: 'Re-analysis needed',
  PAUSED: 'Paused',
  WON: 'Won',
  LOST: 'Lost',
  DISQUALIFIED: 'Disqualified',
};

export const founderStateLabel = (s: string) => FOUNDER_STATE_LABELS[s] ?? s;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The case ID in /app/founder/case/<uuid>, or null. */
export function founderCaseIdFromPath(path: string): string | null {
  const m = /^\/app\/founder\/case\/([^/]+)$/.exec(path);
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}

/** A new request ID for client_create_case (lets network retries return the same case). */
export function newRequestId(): string {
  return crypto.randomUUID();
}
