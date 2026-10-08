// Workflow state transitions. Pure functions: (data, args) -> new data.
// Each transition guards its allowed source states so the UI cannot push a case
// into an inconsistent state.

import { NEEDS_ANALYSIS_STATES, isTerminal } from './labels';
import { newId, parseConversation, runMockAnalysis } from './mockAnalysis';
import type {
  AppData,
  ApprovalType,
  Classification,
  Client,
  LeadSource,
  RecoveryCase,
  TerminalState,
  TimelineEvent,
  WonDetails,
  WorkflowState,
} from './types';

const now = () => new Date().toISOString();

function event(adminLabel: string, clientLabel?: string): TimelineEvent {
  return { id: newId('ev'), at: now(), adminLabel, clientLabel };
}

function updateCase(data: AppData, id: string, fn: (c: RecoveryCase) => RecoveryCase): AppData {
  return { ...data, cases: data.cases.map((c) => (c.id === id ? { ...fn(c), updatedAt: now() } : c)) };
}

function assertState(c: RecoveryCase, allowed: WorkflowState[], action: string) {
  if (!allowed.includes(c.workflowState)) {
    throw new Error(`Cannot ${action} while case ${c.reference} is ${c.workflowState}.`);
  }
}

// ---------------------------------------------------------------- client

export interface NewCaseInput {
  clientId: string;
  reference: string;
  productService: string;
  leadSource: LeadSource;
  estimatedDealValue: number | null;
  lastInteractionDate: string | null;
  conversationText: string;
  clientContext: string | null;
}

export function createCase(data: AppData, input: NewCaseInput): { data: AppData; caseId: string } {
  const client = data.clients.find((cl) => cl.id === input.clientId);
  const id = newId('case');
  const t = now();
  const c: RecoveryCase = {
    id,
    clientId: input.clientId,
    reference: input.reference.trim(),
    productService: input.productService.trim(),
    leadSource: input.leadSource,
    estimatedDealValue: input.estimatedDealValue,
    lastInteractionDate: input.lastInteractionDate,
    clientContext: input.clientContext?.trim() || null,
    createdAt: t,
    updatedAt: t,
    queuedAt: t,
    reviewReason: 'NEW_SUBMISSION',
    // Submission goes straight to ANALYZING; the admin runs the (mock) analysis.
    workflowState: 'ANALYZING',
    conversation: parseConversation(input.conversationText, client?.businessName),
    analysis: null,
    analysisHistory: [],
    approvals: [],
    sentRecords: [],
    responses: [],
    adminNotes: '',
    outcome: null,
    timeline: [event('Case submitted by client', 'Case submitted'), event('Queued for mock analysis')],
  };
  return { data: { ...data, cases: [c, ...data.cases] }, caseId: id };
}

export function recordSent(data: AppData, caseId: string, actualMessage: string | null): AppData {
  return updateCase(data, caseId, (c) => {
    assertState(c, ['CLIENT_ACTION_REQUIRED'], 'record a sent message');
    const approval = c.approvals[c.approvals.length - 1];
    if (!approval || approval.classification === 'RED' || !approval.adminApprovedMessage) {
      throw new Error('There is no approved message to send for this case.');
    }
    const sentExactly = actualMessage === null;
    const actual = sentExactly ? approval.adminApprovedMessage : actualMessage.trim();
    if (!actual) throw new Error('Paste the exact message you sent.');
    const attempt = c.sentRecords.length + 1;
    return {
      ...c,
      workflowState: 'WAITING_FOR_PROSPECT',
      sentRecords: [
        ...c.sentRecords,
        { attempt, approvalId: approval.id, approvedMessage: approval.adminApprovedMessage, actualSentMessage: actual, sentExactly, sentAt: now() },
      ],
      conversation: [
        ...c.conversation,
        { id: newId('m'), speaker: 'RECOVERY_MESSAGE', text: actual, at: now(), attempt },
      ],
      timeline: [
        ...c.timeline,
        event(
          `Recovery message ${attempt} sent by client (${sentExactly ? 'exactly as approved' : 'CHANGED by client'})`,
          `Message sent (attempt ${attempt})`,
        ),
      ],
    };
  });
}

export function addProspectResponse(data: AppData, caseId: string, text: string): AppData {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste the prospect's exact response.");
  return updateCase(data, caseId, (c) => {
    assertState(c, ['WAITING_FOR_PROSPECT'], 'add a prospect response');
    const t = now();
    return {
      ...c,
      workflowState: 'PROSPECT_REPLIED',
      queuedAt: t,
      reviewReason: 'PROSPECT_RESPONSE',
      responses: [...c.responses, { afterAttempt: c.sentRecords.length, text: trimmed, addedAt: t }],
      conversation: [
        ...c.conversation,
        { id: newId('m'), speaker: 'PROSPECT', text: trimmed, at: t, isRecoveryResponse: true },
      ],
      timeline: [...c.timeline, event('Prospect response added by client; returned to review queue', 'Prospect response added — under review')],
    };
  });
}

export function recordOutcome(
  data: AppData,
  caseId: string,
  state: TerminalState,
  by: 'CLIENT' | 'ADMIN',
  extras: { won?: WonDetails; note?: string } = {},
): AppData {
  return updateCase(data, caseId, (c) => {
    if (isTerminal(c.workflowState)) throw new Error('This case is already closed.');
    if (state === 'WON') {
      const w = extras.won;
      if (!w || !(w.amountPaid > 0) || !w.paymentDate) {
        throw new Error('A won deal requires the amount paid and payment date.');
      }
    }
    const labels: Record<TerminalState, string> = {
      WON: 'Deal won — recovered',
      LOST: 'Closed — lost',
      PAUSED: 'Case paused',
      DISQUALIFIED: 'Disqualified',
    };
    return {
      ...c,
      workflowState: state,
      queuedAt: null,
      reviewReason: null,
      outcome: { state, recordedAt: now(), recordedBy: by, won: extras.won, note: extras.note?.trim() || undefined },
      timeline: [...c.timeline, event(`${labels[state]} (recorded by ${by.toLowerCase()})`, labels[state])],
    };
  });
}

// ---------------------------------------------------------------- admin

export function adminRunMockAnalysis(data: AppData, caseId: string): AppData {
  return updateCase(data, caseId, (c) => {
    assertState(c, NEEDS_ANALYSIS_STATES, 'run analysis');
    const analysis = runMockAnalysis(c);
    return {
      ...c,
      workflowState: 'AWAITING_ADMIN_REVIEW',
      analysisHistory: c.analysis ? [...c.analysisHistory, c.analysis] : c.analysisHistory,
      analysis,
      timeline: [...c.timeline, event(`Mock analysis v${analysis.version} generated (${analysis.classification})`)],
    };
  });
}

export function adminRequestReanalysis(data: AppData, caseId: string): AppData {
  return updateCase(data, caseId, (c) => {
    assertState(c, ['AWAITING_ADMIN_REVIEW'], 'request reanalysis');
    return {
      ...c,
      workflowState: 'REANALYZING',
      reviewReason: c.reviewReason ?? 'REANALYSIS',
      timeline: [...c.timeline, event('Admin requested reanalysis')],
    };
  });
}

export interface ApprovalInput {
  approvalType: ApprovalType;
  classification: Classification;
  dealSituation: string;
  nextAction: string;
  approvedMessage: string | null;
  adminNotes: string;
}

export function adminApprove(data: AppData, caseId: string, input: ApprovalInput): AppData {
  return updateCase(data, caseId, (c) => {
    assertState(c, ['AWAITING_ADMIN_REVIEW'], 'approve');
    const a = c.analysis;
    if (!a) throw new Error('Run the analysis before approving.');
    const isRed = input.classification === 'RED';
    const message = isRed ? null : input.approvedMessage?.trim() || null;
    if (!input.dealSituation.trim() || !input.nextAction.trim()) {
      throw new Error('Deal Situation and Next Action are required.');
    }
    if (!isRed && !message) throw new Error('An approved message is required for GREEN and YELLOW.');
    return {
      ...c,
      workflowState: 'CLIENT_ACTION_REQUIRED',
      queuedAt: null,
      reviewReason: null,
      adminNotes: input.adminNotes,
      approvals: [
        ...c.approvals,
        {
          id: newId('ap'),
          approvedAt: now(),
          approvalType: input.approvalType,
          analysisVersion: a.version,
          mockAiClassification: a.classification,
          classification: input.classification,
          dealSituation: input.dealSituation.trim(),
          nextAction: input.nextAction.trim(),
          mockAiProposedMessage: a.mockAiProposedMessage,
          adminApprovedMessage: message,
        },
      ],
      timeline: [
        ...c.timeline,
        event(
          `Admin approved: ${input.classification} (${input.approvalType.toLowerCase().replace('_', ' ')}; mock AI said ${a.classification})`,
          'Recommendation ready',
        ),
      ],
    };
  });
}

export function adminSaveNotes(data: AppData, caseId: string, notes: string): AppData {
  return updateCase(data, caseId, (c) => ({ ...c, adminNotes: notes }));
}

export function addClient(data: AppData, input: Omit<Client, 'id'>): AppData {
  return { ...data, clients: [...data.clients, { ...input, id: newId('client') }] };
}

export function nextReference(data: AppData): string {
  const nums = data.cases
    .map((c) => /^P-(\d+)$/.exec(c.reference)?.[1])
    .filter((n): n is string => !!n)
    .map(Number);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `P-${String(n).padStart(3, '0')}`;
}
