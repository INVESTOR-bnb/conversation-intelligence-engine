// Core domain types for the Revenue Recovery Engine, Stage 1.
// Everything here is local mock state; nothing is persisted server-side.

export const WORKFLOW_STATES = [
  'DRAFT',
  'SUBMITTED',
  'ANALYZING',
  'AWAITING_ADMIN_REVIEW',
  'CLIENT_ACTION_REQUIRED',
  'WAITING_FOR_PROSPECT',
  'PROSPECT_REPLIED',
  'REANALYZING',
  'PAUSED',
  'WON',
  'LOST',
  'DISQUALIFIED',
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export type TerminalState = Extract<WorkflowState, 'PAUSED' | 'WON' | 'LOST' | 'DISQUALIFIED'>;

/** Recovery classification is independent of workflow state. */
export type Classification = 'GREEN' | 'YELLOW' | 'RED';

export const LEAD_SOURCES = [
  'Facebook / Instagram Ads',
  'Google',
  'Referral',
  'Website',
  'Organic Social',
  'Walk-in',
  'Unknown',
  'Other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export type Speaker = 'PROSPECT' | 'BUSINESS' | 'RECOVERY_MESSAGE' | 'UNATTRIBUTED';

export interface ConversationMessage {
  id: string;
  speaker: Speaker;
  text: string;
  /** Free-form time label from the pasted history, or ISO timestamp for in-app events. */
  at?: string;
  /** Set on RECOVERY_MESSAGE entries. */
  attempt?: number;
  /** Set on PROSPECT entries added via the response loop. */
  isRecoveryResponse?: boolean;
}

/**
 * A conversation screenshot uploaded by the client. Stage 1 keeps a downscaled
 * copy locally (data URL) — no upload, storage service or OCR. Private case
 * evidence: admin only, never part of the client-facing view.
 */
export interface ConversationScreenshot {
  id: string;
  /** 1-based position in the order the client selected them (chronological). */
  order: number;
  fileName: string;
  originalType: string;
  originalSizeBytes: number;
  dataUrl: string;
  width: number;
  height: number;
}

export type Level = 'High' | 'Medium-High' | 'Medium' | 'Low-Medium' | 'Low' | 'Unknown';

/** Private forensic intelligence. ADMIN ONLY — never passed to client screens. */
export interface ForensicAnalysis {
  version: number;
  generatedAt: string;
  /** True for the generic Stage-1 placeholder generator (no case-specific reasoning). */
  isPlaceholder: boolean;
  /** Conversation length this analysis was based on; used to detect new information. */
  basedOnMessageCount: number;
  note?: string;

  classification: Classification;
  recoveryScore: number | null;
  confidence: number | null;

  buyingIntent: { level: Level; evidence: string };
  financialCapability: { level: Level; evidence: string };
  offerFit: { level: Level; evidence: string };

  lastStrongBuyingSignal: string;
  momentumBreakpoint: string;

  primaryFriction: string;
  secondaryFrictions: string[];

  statedObjection: string;
  underlyingFrictionHypothesis: string;
  structuralBlocker: string;

  confirmedFacts: string[];
  inferences: string[];
  unknowns: string[];
  alternativeHypotheses: string[];
  sellerSideFriction: string[];
  safetyFlags: string[];

  nextObjective: string;
  mockAiProposedMessage: string | null;
  proposedDealSituation: string;
  proposedNextAction: string;
}

export type ApprovalType = 'UNCHANGED' | 'EDITED' | 'MARKED_RED';

/** The admin decision. Both AI proposal and admin version are retained for later comparison. */
export interface Approval {
  id: string;
  approvedAt: string;
  approvalType: ApprovalType;
  analysisVersion: number;
  mockAiClassification: Classification;
  classification: Classification;
  dealSituation: string;
  nextAction: string;
  mockAiProposedMessage: string | null;
  adminApprovedMessage: string | null;
}

export interface SentRecord {
  attempt: number;
  approvalId: string;
  approvedMessage: string;
  actualSentMessage: string;
  sentExactly: boolean;
  sentAt: string;
}

export interface ProspectResponse {
  afterAttempt: number;
  text: string;
  addedAt: string;
}

export interface WonDetails {
  dealValue: number;
  amountPaid: number;
  paymentDate: string;
  notes?: string;
}

export interface Outcome {
  state: TerminalState;
  recordedAt: string;
  recordedBy: 'CLIENT' | 'ADMIN';
  won?: WonDetails;
  note?: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  /** Shown in the admin view. */
  adminLabel: string;
  /** Shown in the client view. Omit for events the client must not see. */
  clientLabel?: string;
}

export interface RecoveryCase {
  id: string;
  clientId: string;
  reference: string;
  productService: string;
  leadSource: LeadSource;
  estimatedDealValue: number | null;
  lastInteractionDate: string | null;
  clientContext: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the case most recently entered the review queue; queue is ordered oldest first. */
  queuedAt: string | null;
  reviewReason: 'NEW_SUBMISSION' | 'PROSPECT_RESPONSE' | 'REANALYSIS' | null;

  workflowState: WorkflowState;
  /** Optional so demo data saved before screenshots existed still loads. */
  conversationSource?: 'SCREENSHOTS' | 'TEXT';
  screenshots?: ConversationScreenshot[];
  conversation: ConversationMessage[];

  analysis: ForensicAnalysis | null;
  analysisHistory: ForensicAnalysis[];
  approvals: Approval[];
  sentRecords: SentRecord[];
  responses: ProspectResponse[];

  adminNotes: string;
  outcome: Outcome | null;
  timeline: TimelineEvent[];
}

export interface Client {
  id: string;
  businessName: string;
  industry: string;
  currency: string;
  userName: string;
  userEmail: string;
}

export interface AppData {
  schemaVersion: number;
  clients: Client[];
  cases: RecoveryCase[];
  /** Which fake client the Client Demo is viewing as. Prototype control only. */
  demoClientId: string;
}
