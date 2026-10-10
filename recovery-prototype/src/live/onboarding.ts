// Founder onboarding: input checks and error wording for the two existing
// database functions founder_create_business and founder_add_member.
// The database enforces every rule below; these checks only give faster,
// clearer feedback. Nothing here grants or decides access.

export const BUSINESS_NAME_MAX = 120;
export const INDUSTRY_MAX = 120;

export interface BusinessInput {
  name: string;
  industry: string;
  currency: string;
}

export interface CleanBusiness {
  name: string;
  industry: string;
  currency: string;
}

export type BusinessErrors = Partial<Record<keyof BusinessInput, string>>;

/** Mirrors the businesses table checks (name 1–120, industry ≤ 120, 3-letter currency). */
export function validateBusiness(input: BusinessInput): { value?: CleanBusiness; errors: BusinessErrors } {
  const name = input.name.trim();
  const industry = input.industry.trim();
  const currency = input.currency.trim().toUpperCase();
  const errors: BusinessErrors = {};
  if (!name) errors.name = 'Enter a business name.';
  else if (name.length > BUSINESS_NAME_MAX) errors.name = `Use at most ${BUSINESS_NAME_MAX} characters.`;
  if (industry.length > INDUSTRY_MAX) errors.industry = `Use at most ${INDUSTRY_MAX} characters.`;
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'Use a 3-letter currency code, for example NGN.';
  return Object.keys(errors).length ? { errors } : { value: { name, industry, currency }, errors };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateLink(businessId: string, userId: string): { value?: { businessId: string; userId: string }; errors: { business?: string; userId?: string } } {
  const errors: { business?: string; userId?: string } = {};
  const uid = userId.trim().toLowerCase();
  if (!businessId) errors.business = 'Choose a business.';
  if (!uid) errors.userId = 'Paste the client’s User ID.';
  else if (!UUID.test(uid)) errors.userId = 'That is not a valid User ID. Copy it from the client’s “Account not yet authorised” screen.';
  return Object.keys(errors).length ? { errors } : { value: { businessId, userId: uid }, errors };
}

interface RpcError {
  code?: string;
  message?: string;
  status?: number;
  name?: string;
}

export const ONBOARDING_MESSAGES = {
  FORBIDDEN: 'You do not have permission to do this. Only the founder can create businesses and link clients.',
  SESSION: 'Your session has expired. Sign out and sign in again.',
  OFFLINE: 'Could not reach the server. Check your connection and try again.',
  BUSINESS_NOT_FOUND: 'That business no longer exists. Reload the page and choose another.',
  USER_NOT_FOUND: 'No account has this User ID. Check that the client accepted their invitation and copy the ID again.',
  IS_FOUNDER: 'This User ID belongs to the founder account, which cannot be linked as a client.',
  ALREADY_LINKED: 'This account is already linked to a business. A client account can belong to one business only.',
  INVALID: 'The details were rejected. Check the business name, industry and currency.',
  UNKNOWN: 'Something went wrong. Nothing was changed. Please try again.',
} as const;

/** Maps errors from the two onboarding functions to plain messages. Unknown errors never claim success. */
export function onboardingErrorMessage(err: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return ONBOARDING_MESSAGES.OFFLINE;
  const e = (err ?? {}) as RpcError;
  const code = e.code ?? '';
  const msg = e.message ?? '';
  if (code === 'PGRST301' || code === 'PGRST302' || /jwt/i.test(msg)) return ONBOARDING_MESSAGES.SESSION;
  if (code === '42501' || /^FORBIDDEN\b/.test(msg) || /permission denied/i.test(msg)) return ONBOARDING_MESSAGES.FORBIDDEN;
  if (/^NOT_FOUND: business/.test(msg)) return ONBOARDING_MESSAGES.BUSINESS_NOT_FOUND;
  if (/^NOT_FOUND: user/.test(msg)) return ONBOARDING_MESSAGES.USER_NOT_FOUND;
  if (/^VALIDATION: a founder/.test(msg)) return ONBOARDING_MESSAGES.IS_FOUNDER;
  if (/^VALIDATION: user already/.test(msg)) return ONBOARDING_MESSAGES.ALREADY_LINKED;
  if (code === '23514' || code === '22001' || /check constraint/i.test(msg)) return ONBOARDING_MESSAGES.INVALID;
  if (e.name === 'TypeError' || /failed to fetch|network/i.test(msg)) return ONBOARDING_MESSAGES.OFFLINE;
  return ONBOARDING_MESSAGES.UNKNOWN;
}
