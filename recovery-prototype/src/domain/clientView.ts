// Client-safe projection of a case.
//
// This is the ONLY shape client screens receive. It is built field by field from
// the full RecoveryCase so that private forensic intelligence (analysis, scores,
// admin notes, mock AI proposals, AI/admin disagreements) can never leak into the
// client interface by accident.

import { isInReview } from './labels';
import type { Classification, RecoveryCase, TerminalState, WonDetails } from './types';

export type ClientStatus = 'UNDER_REVIEW' | 'ACTION_REQUIRED' | 'WAITING' | TerminalState;

export interface ClientCaseView {
  id: string;
  reference: string;
  productService: string;
  status: ClientStatus;
  /** Present only after admin approval and only while the recommendation is current. */
  classification: Classification | null;
  dealSituation: string | null;
  nextAction: string | null;
  /** Admin-approved message only. Never the mock AI proposal. Null for RED. */
  approvedMessage: string | null;
  recoveryAttempts: number;
  lastSentMessage: string | null;
  responsesAdded: number;
  history: { id: string; at: string; label: string }[];
  won: WonDetails | null;
  closedAt: string | null;
  updatedAt: string;
}

export function toClientView(c: RecoveryCase): ClientCaseView {
  let status: ClientStatus;
  if (isInReview(c.workflowState)) status = 'UNDER_REVIEW';
  else if (c.workflowState === 'CLIENT_ACTION_REQUIRED') status = 'ACTION_REQUIRED';
  else if (c.workflowState === 'WAITING_FOR_PROSPECT') status = 'WAITING';
  else if (c.workflowState === 'DRAFT') status = 'UNDER_REVIEW';
  else status = c.workflowState as TerminalState;

  const latest = c.approvals[c.approvals.length - 1];
  const showRecommendation = status === 'ACTION_REQUIRED' && latest !== undefined;
  const lastSent = c.sentRecords[c.sentRecords.length - 1];

  return {
    id: c.id,
    reference: c.reference,
    productService: c.productService,
    status,
    classification: showRecommendation ? latest.classification : null,
    dealSituation: showRecommendation ? latest.dealSituation : null,
    nextAction: showRecommendation ? latest.nextAction : null,
    approvedMessage: showRecommendation && latest.classification !== 'RED' ? latest.adminApprovedMessage : null,
    recoveryAttempts: c.sentRecords.length,
    lastSentMessage: lastSent ? lastSent.actualSentMessage : null,
    responsesAdded: c.responses.length,
    history: c.timeline
      .filter((e) => e.clientLabel)
      .map((e) => ({ id: e.id, at: e.at, label: e.clientLabel as string })),
    won: c.outcome?.won ?? null,
    closedAt: c.outcome?.recordedAt ?? null,
    updatedAt: c.updatedAt,
  };
}
