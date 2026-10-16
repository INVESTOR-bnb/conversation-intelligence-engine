// What the page header says about this deployment. The only deployment is the staging project,
// which may hold synthetic (sample) data only; that restriction is the same for every viewer.
// The founder sees the technical staging label; everyone else (businesses, signed-out visitors,
// accounts not yet authorised) sees the product name with a DEMO label and the sample-only rule.
// Wording only: what a business can read or do is decided by the database, not by this header.

export type HeaderView = 'founder' | 'demo';

/** Founder header only for a signed-in founder; anything else (including still loading) gets the demo header. */
export function headerView(role: string | null | undefined): HeaderView {
  return role === 'FOUNDER' ? 'founder' : 'demo';
}

export const PRODUCT_NAME = 'Revenue Recovery Engine';
export const FOUNDER_ENVIRONMENT_LABEL = 'Staging · synthetic data only';
export const DEMO_RULE_SHORT = 'Demo workspace · sample conversations only';
export const DEMO_RULE_SUBMIT = 'This is a demo. Use sample conversations only: never paste or upload a real customer’s name, phone number or chat.';
