// Founder onboarding input checks and error wording (no browser, no network).

import { expect, test } from '@playwright/test';
import { ONBOARDING_MESSAGES as M, onboardingErrorMessage, validateBusiness, validateLink } from '../../src/live/onboarding';

test.describe('business input mirrors the database checks', () => {
  test('trims, upper-cases the currency and accepts valid input', () => {
    expect(validateBusiness({ name: '  Synthetic Autos A ', industry: ' Auto ', currency: ' ngn ' }).value).toEqual({ name: 'Synthetic Autos A', industry: 'Auto', currency: 'NGN' });
    expect(validateBusiness({ name: 'x'.repeat(120), industry: '', currency: 'USD' }).value).toBeDefined();
  });
  test('rejects blank or long names, long industry and bad currency codes', () => {
    expect(validateBusiness({ name: '   ', industry: '', currency: 'NGN' }).errors.name).toBe('Enter a business name.');
    expect(validateBusiness({ name: 'x'.repeat(121), industry: '', currency: 'NGN' }).errors.name).toMatch(/120/);
    expect(validateBusiness({ name: 'A', industry: 'y'.repeat(121), currency: 'NGN' }).errors.industry).toMatch(/120/);
    for (const c of ['', 'NG', 'NGNN', 'N1N', '₦']) expect(validateBusiness({ name: 'A', industry: '', currency: c }).errors.currency).toBeDefined();
  });
});

test.describe('link input', () => {
  const id = 'BA457AAB-444F-4306-98C3-0B6C600CB42C';
  test('normalises a pasted User ID', () => {
    expect(validateLink('b1', `  ${id} `).value).toEqual({ businessId: 'b1', userId: id.toLowerCase() });
  });
  test('requires a business and a well-formed User ID', () => {
    expect(validateLink('', id).errors.business).toBeDefined();
    expect(validateLink('b1', '').errors.userId).toMatch(/Paste/);
    for (const bad of ['abc', `${id}x`, id.replace(/-/g, ''), "'; drop table x; --"]) expect(validateLink('b1', bad).errors.userId).toMatch(/not a valid User ID/);
  });
});

test.describe('error messages', () => {
  test('database error codes map to specific, non-misleading messages', () => {
    expect(onboardingErrorMessage({ code: '42501', message: 'FORBIDDEN: founder access required' })).toBe(M.FORBIDDEN);
    expect(onboardingErrorMessage({ code: '42501', message: 'permission denied for function founder_add_member' })).toBe(M.FORBIDDEN);
    expect(onboardingErrorMessage({ code: 'P0002', message: 'NOT_FOUND: business not found' })).toBe(M.BUSINESS_NOT_FOUND);
    expect(onboardingErrorMessage({ code: 'P0002', message: 'NOT_FOUND: user not found' })).toBe(M.USER_NOT_FOUND);
    expect(onboardingErrorMessage({ code: 'P0001', message: 'VALIDATION: a founder cannot be a client member' })).toBe(M.IS_FOUNDER);
    expect(onboardingErrorMessage({ code: 'P0001', message: 'VALIDATION: user already belongs to a business' })).toBe(M.ALREADY_LINKED);
    expect(onboardingErrorMessage({ code: '23514', message: 'new row violates check constraint' })).toBe(M.INVALID);
    expect(onboardingErrorMessage({ code: 'PGRST301', message: 'JWT expired' })).toBe(M.SESSION);
    expect(onboardingErrorMessage({ message: 'TypeError: Failed to fetch' })).toBe(M.OFFLINE);
  });
  test('anything unrecognised says nothing changed rather than guessing', () => {
    for (const e of [null, undefined, {}, { code: 'XX000', message: 'internal error' }, 'boom']) expect(onboardingErrorMessage(e)).toBe(M.UNKNOWN);
  });
});
