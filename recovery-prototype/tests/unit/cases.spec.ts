// Stage 2A-4b case logic (no browser, no network).

import { expect, test } from '@playwright/test';
import {
  CASE_MESSAGES as M, caseErrorMessage, CLIENT_STATUS_LABELS, clientStatusLabel, founderCaseIdFromPath, founderStateLabel,
  isAlreadySubmitted, LEAD_SOURCES, newRequestId, validateCase, type CaseInput,
} from '../../src/live/cases';
import { safeNext } from '../../src/live/router';

const ok: CaseInput = {
  reference: ' TEST-001 ', productService: ' Synthetic Corolla ', leadSource: 'Referral', estimatedValue: '4,500,000.50',
  lastInteractionDate: '2026-10-01', clientContext: '  ', conversation: '  Prospect: is it available? Business: yes.  ',
};

test.describe('case input mirrors the database checks', () => {
  test('valid input is trimmed and normalised', () => {
    expect(validateCase(ok, '2026-10-11').value).toEqual({
      reference: 'TEST-001', productService: 'Synthetic Corolla', leadSource: 'Referral', estimatedValue: 4500000.5,
      lastInteractionDate: '2026-10-01', clientContext: null, conversation: 'Prospect: is it available? Business: yes.',
    });
  });
  test('lead sources match the database list exactly', () => {
    expect([...LEAD_SOURCES]).toEqual(['Facebook / Instagram Ads', 'Google', 'Referral', 'Website', 'Organic Social', 'Walk-in', 'Unknown', 'Other']);
    expect(validateCase({ ...ok, leadSource: 'Billboard' }).errors.leadSource).toBeDefined();
  });
  test('length limits: reference 40, product 200, context 2000, conversation 20–20000', () => {
    const e = (p: Partial<CaseInput>) => validateCase({ ...ok, ...p }, '2026-10-11').errors;
    expect(e({ reference: '' }).reference).toBeDefined();
    expect(e({ reference: 'x'.repeat(41) }).reference).toMatch(/40/);
    expect(e({ productService: 'x'.repeat(201) }).productService).toMatch(/200/);
    expect(e({ clientContext: 'x'.repeat(2001) }).clientContext).toMatch(/2000/);
    expect(e({ conversation: 'x'.repeat(19) }).conversation).toMatch(/at least 20/);
    expect(e({ conversation: 'x'.repeat(20001) }).conversation).toMatch(/too long/);
    expect(validateCase({ ...ok, conversation: 'x'.repeat(20) }, '2026-10-11').value).toBeDefined();
  });
  test('value and date', () => {
    const e = (p: Partial<CaseInput>) => validateCase({ ...ok, ...p }, '2026-10-11').errors;
    for (const v of ['-5', 'abc', '1.234', '1e6']) expect(e({ estimatedValue: v }).estimatedValue).toBeDefined();
    expect(validateCase({ ...ok, estimatedValue: '' }, '2026-10-11').value?.estimatedValue).toBeNull();
    expect(e({ lastInteractionDate: '2026-10-12' }).lastInteractionDate).toMatch(/future/);
    expect(e({ lastInteractionDate: '2026-13-45' }).lastInteractionDate).toBeDefined();
  });
});

test.describe('errors', () => {
  test('database errors map to specific messages', () => {
    expect(caseErrorMessage({ code: 'P0001', message: 'RATE_LIMITED: daily case limit reached' })).toBe(M.RATE_LIMITED);
    expect(caseErrorMessage({ code: 'P0001', message: 'VALIDATION: pasted conversation is too short' })).toBe(M.TOO_SHORT);
    expect(caseErrorMessage({ code: '42501', message: 'FORBIDDEN: client access required' })).toBe(M.FORBIDDEN);
    expect(caseErrorMessage({ code: 'P0002', message: 'NOT_FOUND: case not found' })).toBe(M.NOT_FOUND);
    expect(caseErrorMessage({ code: '23514', message: 'violates check constraint "cases_reference_check"' })).toBe(M.INVALID);
    expect(caseErrorMessage({ code: 'PGRST301', message: 'JWT expired' })).toBe(M.SESSION);
    expect(caseErrorMessage({ message: 'TypeError: Failed to fetch' })).toBe(M.OFFLINE);
    for (const x of [null, {}, { code: 'XX000', message: 'internal error' }]) expect(caseErrorMessage(x)).toBe(M.UNKNOWN);
  });
  test('"already submitted" is recognised only from the exact database message', () => {
    expect(isAlreadySubmitted({ message: 'INVALID_STATE: only draft cases can be submitted' })).toBe(true);
    expect(isAlreadySubmitted({ message: 'INVALID_STATE: case is already closed' })).toBe(false);
    expect(isAlreadySubmitted(null)).toBe(false);
  });
});

test.describe('labels, routes and request IDs', () => {
  test('every client status has a label; unknown values never show internal names', () => {
    for (const s of ['DRAFT', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'WAITING', 'WON', 'LOST', 'PAUSED', 'DISQUALIFIED']) expect(CLIENT_STATUS_LABELS[s]).toBeDefined();
    expect(clientStatusLabel('REANALYZING')).toBe('In progress');
    expect(founderStateLabel('AWAITING_ADMIN_REVIEW')).toBe('Awaiting your review');
  });
  test('founder case paths accept only a UUID', () => {
    const id = 'A0000000-0000-4000-8000-000000000101';
    expect(founderCaseIdFromPath(`/app/founder/case/${id}`)).toBe(id.toLowerCase());
    for (const bad of ['/app/founder/case/', '/app/founder/case/x', `/app/founder/case/${id}/more`, `/app/client/case/${id}`]) expect(founderCaseIdFromPath(bad)).toBeNull();
    expect(safeNext(`/app/founder/case/${id}`)).toBe(`/app/founder/case/${id.toLowerCase()}`);
    expect(safeNext('/app/founder/case/javascript:alert(1)')).toBe('/app');
  });
  test('request IDs are unique UUIDs', () => {
    const a = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newRequestId()).not.toBe(a);
  });
});
