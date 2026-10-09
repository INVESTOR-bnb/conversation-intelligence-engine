// State-machine guards. Stage 2A-1 database functions must enforce the same
// rules server-side; these tests document the approved behaviour.

import { expect, test } from '@playwright/test';
import { createSeedData } from '../../src/data/mockData';
import {
  addProspectResponse,
  adminApprove,
  adminRequestReanalysis,
  adminRunMockAnalysis,
  createCase,
  recordOutcome,
  recordSent,
  type NewCaseInput,
} from '../../src/domain/transitions';
import type { ConversationScreenshot } from '../../src/domain/types';

const get = (d: ReturnType<typeof createSeedData>, id: string) => d.cases.find((c) => c.id === id)!;
const shot = (name: string): ConversationScreenshot => ({ id: name, order: 0, fileName: name, originalType: 'image/png', originalSizeBytes: 10, dataUrl: 'data:image/jpeg;base64,AA', width: 1, height: 1 });
const baseInput: NewCaseInput = {
  clientId: 'client-pasom', reference: 'P-100', productService: 'Test car', leadSource: 'Referral',
  estimatedDealValue: null, lastInteractionDate: null, conversationSource: 'SCREENSHOTS', conversationText: '', screenshots: [], clientContext: null,
};
const approveGreen = { approvalType: 'EDITED' as const, classification: 'GREEN' as const, dealSituation: 'ok', nextAction: 'Send it', approvedMessage: 'Hello', adminNotes: '' };

test('screenshot submission requires at least one screenshot and keeps order', () => {
  expect(() => createCase(createSeedData(), baseInput)).toThrow(/at least one/);
  const { data, caseId } = createCase(createSeedData(), { ...baseInput, screenshots: [shot('a.png'), shot('b.png'), shot('c.png')] });
  const c = get(data, caseId);
  expect(c.workflowState).toBe('ANALYZING');
  expect(c.screenshots!.map((s) => [s.fileName, s.order])).toEqual([['a.png', 1], ['b.png', 2], ['c.png', 3]]);
  expect(c.conversation).toEqual([]);
});

test('pasted-text submission requires text', () => {
  expect(() => createCase(createSeedData(), { ...baseInput, conversationSource: 'TEXT', conversationText: '  ' })).toThrow();
});

test('approval is only possible while awaiting admin review, and needs an analysis', () => {
  expect(() => adminApprove(createSeedData(), 'case-004', approveGreen)).toThrow(/Cannot approve/);
  const { data, caseId } = createCase(createSeedData(), { ...baseInput, screenshots: [shot('a.png')] });
  expect(() => adminApprove(data, caseId, approveGreen)).toThrow(/Cannot approve/);
  const analysed = adminRunMockAnalysis(data, caseId);
  expect(get(adminApprove(analysed, caseId, approveGreen), caseId).workflowState).toBe('CLIENT_ACTION_REQUIRED');
});

test('GREEN/YELLOW approval requires a message; approval keeps AI and admin versions', () => {
  const d = createSeedData();
  expect(() => adminApprove(d, 'case-001', { ...approveGreen, approvedMessage: ' ' })).toThrow(/approved message is required/);
  const ap = get(adminApprove(d, 'case-001', { ...approveGreen, approvedMessage: 'Edited text' }), 'case-001').approvals.at(-1)!;
  expect(ap.adminApprovedMessage).toBe('Edited text');
  expect(ap.mockAiProposedMessage).toContain('2018 Camry is still available');
  expect(ap.mockAiClassification).toBe('GREEN');
});

test('a RED recommendation cannot be marked as sent', () => {
  expect(() => recordSent(createSeedData(), 'case-003', null)).toThrow(/no approved message/);
});

test('sent record keeps both approved and actual text; changed text must be non-empty', () => {
  const d = createSeedData();
  expect(() => recordSent(d, 'case-004', '   ')).toThrow(/exact message/);
  const changed = get(recordSent(d, 'case-004', 'My own words'), 'case-004');
  expect(changed.workflowState).toBe('WAITING_FOR_PROSPECT');
  expect(changed.sentRecords.at(-1)).toMatchObject({ sentExactly: false, actualSentMessage: 'My own words', attempt: 1 });
  expect(changed.sentRecords.at(-1)!.approvedMessage).toContain('An evening slot is also possible.');
  const exact = get(recordSent(d, 'case-004', null), 'case-004');
  expect(exact.sentRecords.at(-1)!.sentExactly).toBe(true);
});

test('prospect responses are only accepted while waiting, and re-queue the case', () => {
  expect(() => addProspectResponse(createSeedData(), 'case-004', 'hi')).toThrow(/Cannot add a prospect response/);
  const d = addProspectResponse(createSeedData(), 'case-006', '  Still interested  ');
  const c = get(d, 'case-006');
  expect(c.workflowState).toBe('PROSPECT_REPLIED');
  expect(c.reviewReason).toBe('PROSPECT_RESPONSE');
  expect(c.responses.at(-1)!.text).toBe('Still interested');
  expect(() => addProspectResponse(createSeedData(), 'case-006', '   ')).toThrow();
});

test('reanalysis is only possible from awaiting review', () => {
  expect(() => adminRequestReanalysis(createSeedData(), 'case-004')).toThrow(/Cannot request reanalysis/);
});

test('WON requires amount paid and payment date; closed cases cannot be closed again', () => {
  const d = createSeedData();
  expect(() => recordOutcome(d, 'case-004', 'WON', 'CLIENT', {})).toThrow(/amount paid/);
  expect(() => recordOutcome(d, 'case-004', 'WON', 'CLIENT', { won: { dealValue: 1, amountPaid: 0, paymentDate: '2026-10-01' } })).toThrow();
  const won = recordOutcome(d, 'case-004', 'WON', 'CLIENT', { won: { dealValue: 10, amountPaid: 9, paymentDate: '2026-10-01' } });
  expect(get(won, 'case-004').workflowState).toBe('WON');
  expect(() => recordOutcome(won, 'case-004', 'LOST', 'CLIENT')).toThrow(/already closed/);
});
