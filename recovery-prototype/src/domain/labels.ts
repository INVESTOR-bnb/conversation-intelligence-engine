import type { Classification, WorkflowState } from './types';

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  GREEN: 'Worth Following Up',
  YELLOW: 'Needs Clarification',
  RED: 'Do Not Follow Up',
};

export const WORKFLOW_LABEL: Record<WorkflowState, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  ANALYZING: 'Analyzing',
  AWAITING_ADMIN_REVIEW: 'Awaiting admin review',
  CLIENT_ACTION_REQUIRED: 'Client action required',
  WAITING_FOR_PROSPECT: 'Waiting for prospect',
  PROSPECT_REPLIED: 'Prospect replied',
  REANALYZING: 'Reanalyzing',
  PAUSED: 'Paused',
  WON: 'Won',
  LOST: 'Lost',
  DISQUALIFIED: 'Disqualified',
};

/** States in which the case sits with the admin and the client sees UNDER REVIEW. */
export const REVIEW_STATES: WorkflowState[] = [
  'SUBMITTED',
  'ANALYZING',
  'AWAITING_ADMIN_REVIEW',
  'PROSPECT_REPLIED',
  'REANALYZING',
];

/** States where the mock analysis has not been (re)run yet. */
export const NEEDS_ANALYSIS_STATES: WorkflowState[] = ['SUBMITTED', 'ANALYZING', 'PROSPECT_REPLIED', 'REANALYZING'];

export const TERMINAL_STATES: WorkflowState[] = ['PAUSED', 'WON', 'LOST', 'DISQUALIFIED'];

export function isInReview(s: WorkflowState) {
  return REVIEW_STATES.includes(s);
}

export function isTerminal(s: WorkflowState) {
  return TERMINAL_STATES.includes(s);
}
