import { expect, test } from '@playwright/test';
import { actionMessage, continueInWhatsApp, validateAuthorization, whatsappPreviewEnabled, WA_SCOPE_POINTS } from '../../src/live/whatsapp';

test('the preview is enabled only by its flag, and never against the prototype\'s project', () => {
  expect(whatsappPreviewEnabled({ VITE_WHATSAPP_PREVIEW: '1', VITE_SUPABASE_URL: 'https://isolatedwa0000000000.supabase.co' })).toBe(true);
  expect(whatsappPreviewEnabled({ VITE_WHATSAPP_PREVIEW: '1', VITE_SUPABASE_URL: 'https://aqwdwswpmbnzmkvyuqil.supabase.co' })).toBe(false);
  expect(whatsappPreviewEnabled({ VITE_SUPABASE_URL: 'https://isolatedwa0000000000.supabase.co' })).toBe(false);
  expect(whatsappPreviewEnabled({ VITE_WHATSAPP_PREVIEW: 'true', VITE_SUPABASE_URL: 'https://x.supabase.co' })).toBe(false);
});

test('authorization limits are validated before sending (the database enforces them again)', () => {
  const ok = { historyMonths: 3, sendMode: 'AUTOMATIC' as const, maxSendsPerDay: 10, maxFollowupsPerContact: 2, spendLimitUsd: 2, reopenTemplate: '', reopenTemplateLang: '', reopenTemplateText: '' };
  expect(validateAuthorization(ok)).toEqual({});
  expect(Object.keys(validateAuthorization({ ...ok, historyMonths: 12, maxFollowupsPerContact: 5, spendLimitUsd: 999, maxSendsPerDay: 0 })).sort())
    .toEqual(['historyMonths', 'maxFollowupsPerContact', 'maxSendsPerDay', 'spendLimitUsd']);
  expect(Object.keys(validateAuthorization({ ...ok, reopenTemplate: 'Bad Name', reopenTemplateLang: 'english', reopenTemplateText: 'hi' })).sort())
    .toEqual(['reopenTemplate', 'reopenTemplateLang', 'reopenTemplateText']);
});

test('plain action messages; honest scope; continue-in-WhatsApp link', () => {
  expect(actionMessage('TOKEN_REVOKED')).toContain('Connect again');
  expect(actionMessage('HISTORY_SYNC_META_131000')).toContain('may not be eligible');
  expect(actionMessage('SOMETHING_NEW')).toContain('RRE sends nothing meanwhile');
  expect(WA_SCOPE_POINTS.join(' ')).not.toMatch(/all (your )?chats|every chat|unlimited|free/i);
  expect(continueInWhatsApp('+234 800 000 0011')).toBe('https://wa.me/2348000000011');
});
