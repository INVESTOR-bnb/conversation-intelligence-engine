// The client-safe projection is the privacy boundary of Stage 1 and the
// contract Stage 2's server-side projection must reproduce.

import { expect, test } from '@playwright/test';
import { createSeedData } from '../../src/data/mockData';
import { toClientView } from '../../src/domain/clientView';
import { adminApprove, adminRequestReanalysis, adminRunMockAnalysis } from '../../src/domain/transitions';

const ALLOWED_KEYS = [
  'id', 'reference', 'productService', 'status', 'classification', 'dealSituation', 'nextAction',
  'approvedMessage', 'recoveryAttempts', 'lastSentMessage', 'responsesAdded', 'history', 'won', 'closedAt', 'updatedAt',
].sort();

const caseById = (d: ReturnType<typeof createSeedData>, id: string) => d.cases.find((c) => c.id === id)!;

test('projection exposes exactly the allowed client fields for every seed case', () => {
  for (const c of createSeedData().cases) {
    expect(Object.keys(toClientView(c)).sort(), c.id).toEqual(ALLOWED_KEYS);
  }
});

test('no private analysis content, notes or AI proposals leak into any projection', () => {
  const d = createSeedData();
  for (const c of d.cases) {
    const json = JSON.stringify(toClientView(c));
    if (c.adminNotes) expect(json, `${c.id} admin notes`).not.toContain(c.adminNotes);
    for (const a of [c.analysis, ...c.analysisHistory]) {
      if (!a) continue;
      for (const s of [a.primaryFriction, a.momentumBreakpoint, a.structuralBlocker, ...a.confirmedFacts, ...a.unknowns, ...a.safetyFlags]) {
        if (s.length > 25) expect(json, `${c.id} leaked analysis text`).not.toContain(s);
      }
    }
    for (const ap of c.approvals) {
      if (ap.mockAiProposedMessage && ap.mockAiProposedMessage !== ap.adminApprovedMessage) {
        expect(json, `${c.id} leaked mock AI message`).not.toContain(ap.mockAiProposedMessage);
      }
    }
  }
});

test('a case under review shows no classification, situation or message', () => {
  const v = toClientView(caseById(createSeedData(), 'case-001'));
  expect(v.status).toBe('UNDER_REVIEW');
  expect([v.classification, v.dealSituation, v.nextAction, v.approvedMessage]).toEqual([null, null, null, null]);
});

test('client receives the admin-edited message, never the mock AI original', () => {
  const v = toClientView(caseById(createSeedData(), 'case-004'));
  expect(v.approvedMessage).toContain('An evening slot is also possible.');
  expect(v.approvedMessage).not.toContain('still here');
});

test('RED never carries a message, even if one is passed at approval', () => {
  let d = createSeedData();
  d = adminApprove(d, 'case-001', {
    approvalType: 'EDITED', classification: 'RED', dealSituation: 'Stop.', nextAction: 'No further contact is recommended.',
    approvedMessage: 'This must never reach the client', adminNotes: '',
  });
  const v = toClientView(caseById(d, 'case-001'));
  expect(v.classification).toBe('RED');
  expect(v.approvedMessage).toBeNull();
});

test('requesting reanalysis hides the previous recommendation again', () => {
  let d = createSeedData();
  d = adminRequestReanalysis(d, 'case-001');
  expect(toClientView(caseById(d, 'case-001')).status).toBe('UNDER_REVIEW');
  d = adminRunMockAnalysis(d, 'case-001');
  expect(toClientView(caseById(d, 'case-001')).classification).toBeNull();
});

test('screenshots are not part of the client projection', () => {
  const c = { ...caseById(createSeedData(), 'case-001'), screenshots: [{ id: 's1', order: 1, fileName: 'secret-chat.png', originalType: 'image/png', originalSizeBytes: 1, dataUrl: 'data:image/jpeg;base64,AAAA', width: 1, height: 1 }] };
  const json = JSON.stringify(toClientView(c));
  expect(json).not.toContain('secret-chat.png');
  expect(json).not.toContain('data:image');
});
