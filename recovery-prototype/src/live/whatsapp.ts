// WhatsApp integration (PREVIEW, isolated environment only): pure helpers for the owner and
// founder screens. Every rule here is ALSO enforced by the database (supabase/whatsapp/wa_integration.sql);
// these only give clear messages before a request is sent.

/** The current prototype's project: the WhatsApp preview is never shown against it. */
export const PROTOTYPE_SUPABASE_HOST = 'aqwdwswpmbnzmkvyuqil.supabase.co';
export const WA_TERMS_VERSION = 'v1';

export function whatsappPreviewEnabled(env: { VITE_WHATSAPP_PREVIEW?: string; VITE_SUPABASE_URL?: string }): boolean {
  if (env.VITE_WHATSAPP_PREVIEW !== '1') return false;
  try { return new URL(env.VITE_SUPABASE_URL ?? '').host !== PROTOTYPE_SUPABASE_HOST; } catch { return false; }
}

export type WaStatus = 'DISCONNECTED' | 'CONNECTING' | 'SYNCING' | 'CONNECTED' | 'PAUSED' | 'ACTION_REQUIRED';
export const STATUS_LABEL: Record<WaStatus, string> = {
  DISCONNECTED: 'Not connected',
  CONNECTING: 'Connecting…',
  SYNCING: 'Connected — importing your recent chats',
  CONNECTED: 'Connected',
  PAUSED: 'Paused — RRE sends nothing',
  ACTION_REQUIRED: 'Action required',
};

/** What the owner should do for each action code (unknown codes get a safe generic message). */
export function actionMessage(code: string | null | undefined): string {
  const known: Record<string, string> = {
    AUTHORIZATION_FAILED: 'Meta did not complete the authorization. Press “Connect WhatsApp” again.',
    NUMBER_NOT_ACCESSIBLE: 'RRE could not access this WhatsApp number. Check that you chose your WhatsApp Business app number and try again.',
    WEBHOOK_SUBSCRIPTION_FAILED: 'RRE could not start receiving your messages. Try connecting again; if it repeats, contact RRE.',
    TOKEN_REVOKED: 'RRE’s access to your WhatsApp was removed or expired. Connect again to continue.',
    PARTNER_REMOVED: 'RRE was removed from your WhatsApp account. Connect again to continue.',
    ACCOUNT_RESTRICTION: 'Meta restricted this WhatsApp account. Check WhatsApp Manager; RRE sends nothing meanwhile.',
  };
  if (code && known[code]) return known[code];
  if (code?.startsWith('HISTORY_SYNC_')) {
    return 'Meta did not accept the chat-history request. This number may not be eligible (for example its country, its app version — 2.24.17 or later is required — or the 24-hour window after connecting passed). RRE sends nothing.';
  }
  return 'Something needs attention before RRE can continue. RRE sends nothing meanwhile.';
}

/** The authorization the owner gives (validated again by the database). */
export interface WaAuthorization {
  historyMonths: number; sendMode: 'AUTOMATIC' | 'OWNER_SENDS'; maxSendsPerDay: number; maxFollowupsPerContact: number; spendLimitUsd: number;
  reopenTemplate: string; reopenTemplateLang: string; reopenTemplateText: string;
}
export type WaAuthorizationErrors = Partial<Record<keyof WaAuthorization, string>>;
export function validateAuthorization(a: WaAuthorization): WaAuthorizationErrors {
  const e: WaAuthorizationErrors = {};
  if (!Number.isInteger(a.historyMonths) || a.historyMonths < 1 || a.historyMonths > 6) e.historyMonths = 'Choose 1 to 6 months.';
  if (!Number.isInteger(a.maxSendsPerDay) || a.maxSendsPerDay < 1 || a.maxSendsPerDay > 50) e.maxSendsPerDay = 'Choose 1 to 50 a day.';
  if (!Number.isInteger(a.maxFollowupsPerContact) || a.maxFollowupsPerContact < 1 || a.maxFollowupsPerContact > 2) e.maxFollowupsPerContact = 'Choose 1 or 2.';
  if (!Number.isFinite(a.spendLimitUsd) || a.spendLimitUsd < 0 || a.spendLimitUsd > 50) e.spendLimitUsd = 'Choose USD 0 to 50.';
  const anyTemplate = a.reopenTemplate || a.reopenTemplateLang || a.reopenTemplateText;
  if (anyTemplate) {
    if (!/^[a-z0-9_]{1,200}$/.test(a.reopenTemplate)) e.reopenTemplate = 'Use the template’s exact name as approved by Meta (lower case, digits, _).';
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(a.reopenTemplateLang)) e.reopenTemplateLang = 'Use the template’s language code, for example en or en_US.';
    if (a.reopenTemplateText.trim().length < 10 || a.reopenTemplateText.length > 1024) e.reopenTemplateText = 'Paste the approved template’s exact text.';
  }
  return e;
}

/** What the owner agrees to, shown before connecting/authorizing (kept short and factual). */
export const WA_SCOPE_POINTS = [
  'History: Meta shares at most your last 6 months of one-to-one chats, once, shortly after you connect. Group chats are not shared with RRE (they stay in your app). Voice notes, images and deleted messages are not read; conversations with them are not followed up automatically.',
  'Who RRE may message: only prospects you confirm agreed to hear from you on WhatsApp. Anyone who replies STOP is never messaged again.',
  'How RRE sends: for an older chat, one reopening message using your Meta-approved template; if the customer replies, a personal reply approved by the RRE team. At most 2 follow-ups per person.',
  'What you see: messages RRE sends and customer replies appear in your normal WhatsApp Business app. If you write to a customer yourself, RRE stops for that conversation.',
  'Charges: Meta charges per message (template messages always; RRE uses your limit below and stops when it is reached). Analysis by RRE is billed separately.',
  'You can pause or disconnect at any time; pausing stops sending immediately.',
] as const;

/** Opens a chat with a customer in WhatsApp (the owner continues there). */
export const continueInWhatsApp = (number: string) => `https://wa.me/${number.replace(/\D/g, '')}`;
