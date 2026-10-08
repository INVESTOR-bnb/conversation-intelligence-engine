// Seed data for the Stage-1 prototype. All businesses, people and conversations
// are fictional. Analyses are hand-written MOCK intelligence — no AI was used.
//
// Required cases:
//   case-001  GREEN   Pasom Autos — 2018 Toyota Camry (awaiting admin review)
//   case-002  YELLOW  Fineez Designs Academy — fashion training (approved)
//   case-003  RED     Pasom Autos — 2019 Honda Accord, installment blocker (approved)
// Supporting cases cover the remaining workflow states.

import type { AppData, Approval, ConversationMessage, ForensicAnalysis, RecoveryCase, Speaker } from '../domain/types';

export const SCHEMA_VERSION = 1;

let mid = 0;
function convo(lines: [Speaker, string, string?][]): ConversationMessage[] {
  return lines.map(([speaker, text, at]) => ({ id: `seed-m${++mid}`, speaker, text, at }));
}

function baseCase(partial: Partial<RecoveryCase> & Pick<RecoveryCase, 'id' | 'clientId' | 'reference' | 'productService' | 'workflowState' | 'conversation' | 'createdAt'>): RecoveryCase {
  return {
    leadSource: 'Unknown',
    estimatedDealValue: null,
    lastInteractionDate: null,
    clientContext: null,
    updatedAt: partial.createdAt,
    queuedAt: null,
    reviewReason: null,
    analysis: null,
    analysisHistory: [],
    approvals: [],
    sentRecords: [],
    responses: [],
    adminNotes: '',
    outcome: null,
    timeline: [],
    ...partial,
  };
}

function approvalFrom(a: ForensicAnalysis, id: string, approvedAt: string, overrides: Partial<Approval> = {}): Approval {
  return {
    id,
    approvedAt,
    approvalType: 'UNCHANGED',
    analysisVersion: a.version,
    mockAiClassification: a.classification,
    classification: a.classification,
    dealSituation: a.proposedDealSituation,
    nextAction: a.proposedNextAction,
    mockAiProposedMessage: a.mockAiProposedMessage,
    adminApprovedMessage: a.mockAiProposedMessage,
    ...overrides,
  };
}

// ------------------------------------------------------------------ CASE 1 — GREEN

const camryConversation = convo([
  ['BUSINESS', 'Good afternoon, thanks for your enquiry about the 2018 Toyota Camry XLE. It is still available.', '14 Sep, 13:02'],
  ['PROSPECT', 'Good afternoon. What is the mileage, and is it foreign used or locally used?', '14 Sep, 13:10'],
  ['BUSINESS', 'Foreign used, 68,000 km, clean title. Asking price is ₦18.5m.', '14 Sep, 13:14'],
  ['PROSPECT', 'Any accident history? Can you send pictures of the engine bay and underside?', '14 Sep, 13:21'],
  ['BUSINESS', 'No accident history on the vehicle report. Sending the pictures now. [6 photos]', '14 Sep, 13:40'],
  ['PROSPECT', 'Okay, looks clean. What is your final price?', '14 Sep, 18:05'],
  ['BUSINESS', 'For you, ₦17.8m is final.', '14 Sep, 18:30'],
  ['PROSPECT', 'Alright. Can my mechanic come and inspect it on Saturday?', '14 Sep, 18:41'],
  ['BUSINESS', 'Yes, Saturday works. Our yard is on Admiralty Way, Lekki. What time is good for you?', '14 Sep, 18:45'],
  ['PROSPECT', 'Let me confirm with my mechanic and get back to you.', '14 Sep, 19:02'],
  ['BUSINESS', 'Good morning, just checking if Saturday still works for the inspection?', '17 Sep, 09:15'],
]);

const camryAnalysis: ForensicAnalysis = {
  version: 1,
  generatedAt: '2026-09-29T08:10:00.000Z',
  isPlaceholder: false,
  basedOnMessageCount: camryConversation.length,
  classification: 'GREEN',
  recoveryScore: 68,
  confidence: 0.62,
  buyingIntent: {
    level: 'Medium-High',
    evidence: 'Asked about mileage, import status and accident history, requested specific photos, asked for a final price, then proposed a mechanic inspection himself.',
  },
  financialCapability: {
    level: 'Unknown',
    evidence: 'No budget was stated. The prospect did not object to ₦17.8m. There is no evidence of an affordability problem, and also no confirmation of funds.',
  },
  offerFit: {
    level: 'Medium-High',
    evidence: 'All questions asked (mileage, history, condition) were answered and none surfaced a mismatch. Prospect said the car "looks clean".',
  },
  lastStrongBuyingSignal: '"Can my mechanic come and inspect it on Saturday?" (14 Sep, 18:41) — a prospect-initiated next step after the final price.',
  momentumBreakpoint: '"Let me confirm with my mechanic and get back to you." The next step became dependent on a third party, no time was fixed, and the prospect owned the follow-up.',
  primaryFriction: 'Inspection logistics were never finalised (no time agreed; depends on the mechanic).',
  secondaryFrictions: [
    'Seller follow-up on 17 Sep was not answered (one unanswered follow-up so far).',
    'Twelve days of silence since the last seller message.',
  ],
  statedObjection: 'None stated.',
  underlyingFrictionHypothesis: 'Coordination with the mechanic stalled the inspection. This is a hypothesis consistent with the breakpoint, not a confirmed fact.',
  structuralBlocker: 'None confirmed.',
  confirmedFacts: [
    'Prospect asked about mileage, import status and accident history.',
    'Business quoted ₦18.5m, then ₦17.8m as final.',
    'Prospect proposed a Saturday mechanic inspection.',
    'Prospect said they would confirm with the mechanic; no confirmation was received.',
    'One seller follow-up (17 Sep) received no reply.',
  ],
  inferences: [
    'Proposing an inspection after the final price suggests serious consideration at that point (inference).',
    'The inspection was likely blocked by scheduling rather than by the car itself (inference; weak).',
  ],
  unknowns: [
    'Whether the prospect has the funds or financing ready.',
    'Whether the prospect is still in the market or bought elsewhere.',
    'Whether ₦17.8m was acceptable or simply not rejected.',
    "Whether the mechanic's availability was the actual issue.",
    'Whether anyone else is involved in the decision.',
  ],
  alternativeHypotheses: [
    'Prospect bought another vehicle.',
    'Price was higher than hoped but the prospect did not say so.',
    'Personal circumstances or priorities changed.',
    'Prospect is still comparing other vehicles.',
  ],
  sellerSideFriction: [
    'The 17 Sep follow-up was a yes/no question that put the coordination burden back on the prospect; no concrete slot or low-effort alternative was offered.',
  ],
  safetyFlags: [
    'One follow-up is already unanswered. Recommend at most one further attempt before stopping if there is no reply.',
    'Do not imply urgency or scarcity that is not true.',
  ],
  nextObjective: 'Re-open the inspection step with a lower-effort option, without pressure.',
  mockAiProposedMessage:
    'Good afternoon. The 2018 Camry is still available. If an inspection is still of interest, we can hold a slot this Saturday or next for your mechanic. I can also send a short video of the engine running first if that helps. No pressure either way.',
  proposedDealSituation: 'This prospect previously showed meaningful buying interest and another conversation is justified.',
  proposedNextAction: 'Send the approved message below.',
};

const case1 = baseCase({
  id: 'case-001',
  clientId: 'client-pasom',
  reference: 'P-001',
  productService: '2018 Toyota Camry',
  leadSource: 'Facebook / Instagram Ads',
  estimatedDealValue: 17800000,
  lastInteractionDate: '2026-09-17',
  createdAt: '2026-09-29T08:00:00.000Z',
  updatedAt: '2026-09-29T08:10:00.000Z',
  queuedAt: '2026-09-29T08:00:00.000Z',
  reviewReason: 'NEW_SUBMISSION',
  workflowState: 'AWAITING_ADMIN_REVIEW',
  conversation: camryConversation,
  analysis: camryAnalysis,
  timeline: [
    { id: 'seed-e1', at: '2026-09-29T08:00:00.000Z', adminLabel: 'Case submitted by client', clientLabel: 'Case submitted' },
    { id: 'seed-e2', at: '2026-09-29T08:10:00.000Z', adminLabel: 'Mock analysis v1 generated (GREEN)' },
  ],
});

// ------------------------------------------------------------------ CASE 2 — YELLOW

const fineezConversation = convo([
  ['PROSPECT', 'Hello, how long is the fashion design training and how much is it?', '22 Sep, 10:12'],
  ['PROSPECT', 'Where are you located? And what do I need to start?', '22 Sep, 10:13'],
  [
    'BUSINESS',
    'Hello! Thank you for your interest. Our programmes:\n' +
      '• Basic Sewing (1 month) — ₦80,000\n' +
      '• Children’s Wear (1 month) — ₦90,000\n' +
      '• Bridal Wear Masterclass (2 months) — ₦180,000\n' +
      '• Advanced Pattern Drafting (3 months) — ₦220,000\n' +
      '• Fashion Design Diploma (6 months) — ₦350,000\n' +
      '• Online Starter Course — ₦45,000\n' +
      'Registration fee: ₦15,000. We are in Ikeja. Requirements: sketchbook, measuring tape, and your own sewing machine for advanced classes. Classes Mon–Fri 9am–2pm; weekend option for the Diploma.',
    '22 Sep, 11:47',
  ],
]);

const fineezAnalysis: ForensicAnalysis = {
  version: 1,
  generatedAt: '2026-10-01T09:00:00.000Z',
  isPlaceholder: false,
  basedOnMessageCount: fineezConversation.length,
  classification: 'YELLOW',
  recoveryScore: 41,
  confidence: 0.38,
  buyingIntent: {
    level: 'Low-Medium',
    evidence: 'General early-stage questions (duration, fees, location, requirements). No specific programme, start date or goal was mentioned.',
  },
  financialCapability: {
    level: 'Unknown',
    evidence: 'No budget was discussed. Silence after receiving prices does NOT indicate the prospect cannot afford the course.',
  },
  offerFit: {
    level: 'Unknown',
    evidence: 'The prospect did not state their goal or skill level, so which programme (if any) fits cannot be determined.',
  },
  lastStrongBuyingSignal: 'No strong signal. The most specific question was "What do I need to start?"',
  momentumBreakpoint: 'Silence began after the business sent a six-programme price list. This is timing only; it does not establish cause.',
  primaryFriction: 'Unclear — insufficient evidence to identify the primary friction.',
  secondaryFrictions: [
    'Possible information overload from six options at once (unconfirmed).',
    'The business reply did not ask the prospect a question, so there was no clear next step.',
  ],
  statedObjection: 'None stated.',
  underlyingFrictionHypothesis: 'Not determinable from the evidence. Several hypotheses are equally plausible (see alternatives).',
  structuralBlocker: 'None identified.',
  confirmedFacts: [
    'Prospect asked about duration, fees, location and requirements.',
    'Business sent six programmes with prices, the registration fee, location, requirements and schedule.',
    'Prospect has not replied for 9 days.',
  ],
  inferences: ['The questions are consistent with early information-gathering (inference).'],
  unknowns: [
    'Whether the prospect is still interested.',
    'Affordability / budget.',
    'Which programme, if any, matches their goal.',
    'Their goal (personal skill vs. starting a business).',
    'Preferred timing or schedule.',
    'Whether they are comparing other schools.',
  ],
  alternativeHypotheses: [
    'Overwhelmed by the number of options (unconfirmed).',
    'Prices higher than expected (unconfirmed — must not be presented as fact).',
    'Only gathering information; no immediate intention.',
    'Enrolled elsewhere.',
    'Location or weekday schedule does not suit them.',
  ],
  sellerSideFriction: [
    'Answered with the full catalogue instead of first asking about the prospect’s goal.',
    'Reply ended without a question or next step.',
  ],
  safetyFlags: [
    'Do not state or imply that the prospect cannot afford the course.',
    'Do not present a price objection as fact.',
    'Use a single low-pressure diagnostic message only.',
  ],
  nextObjective: 'Clarify whether interest remains and what the prospect wants to achieve.',
  mockAiProposedMessage:
    'Hello, thanks again for asking about our training. To point you to the right option: are you looking to learn for personal use, or to train for a fashion business? I’ll then share just the one programme that fits.',
  proposedDealSituation: "There isn't enough information yet to determine whether this opportunity is still active.",
  proposedNextAction: "Send this short message to clarify the prospect's current position.",
};

const case2 = baseCase({
  id: 'case-002',
  clientId: 'client-fineez',
  reference: 'P-002',
  productService: 'Fashion Design Training',
  leadSource: 'Organic Social',
  estimatedDealValue: null,
  lastInteractionDate: '2026-09-22',
  createdAt: '2026-10-01T08:30:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  workflowState: 'CLIENT_ACTION_REQUIRED',
  conversation: fineezConversation,
  analysis: fineezAnalysis,
  approvals: [approvalFrom(fineezAnalysis, 'seed-ap2', '2026-10-01T10:00:00.000Z')],
  adminNotes: 'Agree with YELLOW. Kept it to one diagnostic question.',
  timeline: [
    { id: 'seed-e3', at: '2026-10-01T08:30:00.000Z', adminLabel: 'Case submitted by client', clientLabel: 'Case submitted' },
    { id: 'seed-e4', at: '2026-10-01T09:00:00.000Z', adminLabel: 'Mock analysis v1 generated (YELLOW)' },
    { id: 'seed-e5', at: '2026-10-01T10:00:00.000Z', adminLabel: 'Admin approved: YELLOW (unchanged; mock AI said YELLOW)', clientLabel: 'Recommendation ready' },
  ],
});

// ------------------------------------------------------------------ CASE 3 — RED

const accordConversation = convo([
  ['PROSPECT', 'Is the 2019 Honda Accord still available? Do you do installment payment?', '20 Sep, 15:30'],
  ['BUSINESS', 'Yes, it is available at ₦16.2m. Sorry, we do not offer installments — full payment only. Financing through your own bank is possible.', '20 Sep, 15:41'],
  ['PROSPECT', 'I can’t pay at once. My bank loan was declined, so I can only do monthly installments over 12 months.', '20 Sep, 16:02'],
  ['BUSINESS', 'Understood. Unfortunately we can only accept full payment.', '20 Sep, 16:10'],
  ['PROSPECT', 'Okay then, I can’t proceed without installments. Thanks.', '20 Sep, 16:15'],
]);

const accordAnalysis: ForensicAnalysis = {
  version: 1,
  generatedAt: '2026-09-30T11:20:00.000Z',
  isPlaceholder: false,
  basedOnMessageCount: accordConversation.length,
  classification: 'RED',
  recoveryScore: 8,
  confidence: 0.9,
  buyingIntent: {
    level: 'Medium',
    evidence: 'Genuine interest in the vehicle, but explicitly conditional on 12-month installments.',
  },
  financialCapability: {
    level: 'Low',
    evidence: 'Prospect stated directly that they cannot pay in full and that their bank loan was declined. This is the prospect’s own statement, not an inference from silence.',
  },
  offerFit: {
    level: 'Low',
    evidence: 'The offer requires full payment; the prospect requires installments. Confirmed mismatch on payment terms.',
  },
  lastStrongBuyingSignal: '"Do you do installment payment?" — interest was conditional from the first message.',
  momentumBreakpoint: '"Okay then, I can’t proceed without installments." The prospect closed the conversation.',
  primaryFriction: 'Payment-terms mismatch: installments required, not offered.',
  secondaryFrictions: ['Bank financing route already declined for the prospect.'],
  statedObjection: 'Cannot pay at once; needs 12-month installments.',
  underlyingFrictionHypothesis: 'None needed — the stated reason is explicit and consistent across three messages.',
  structuralBlocker: 'CONFIRMED. The business does not offer installments, and the prospect confirmed they cannot proceed without them. This is a structural mismatch, not an objection to overcome.',
  confirmedFacts: [
    'Business offers full payment only.',
    'Prospect requires 12-month installments.',
    'Prospect’s bank loan was declined (prospect’s statement).',
    'Prospect said: "I can’t proceed without installments."',
  ],
  inferences: [],
  unknowns: ['Whether the prospect’s financial position will change in future.'],
  alternativeHypotheses: ['None that change the recommendation while payment terms remain full-payment only.'],
  sellerSideFriction: ['None material. The business was clear and honest about its terms.'],
  safetyFlags: [
    'Further recovery attempts would pressure a prospect who has stated they cannot proceed.',
    'Do not generate a recovery message.',
  ],
  nextObjective: 'Stop pursuit.',
  mockAiProposedMessage: null,
  proposedDealSituation: 'This prospect is not currently recommended for further recovery attempts.',
  proposedNextAction: 'No further contact is recommended.',
};

const case3 = baseCase({
  id: 'case-003',
  clientId: 'client-pasom',
  reference: 'P-003',
  productService: '2019 Honda Accord',
  leadSource: 'Website',
  estimatedDealValue: 16200000,
  lastInteractionDate: '2026-09-20',
  createdAt: '2026-09-30T11:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  workflowState: 'CLIENT_ACTION_REQUIRED',
  conversation: accordConversation,
  analysis: accordAnalysis,
  approvals: [approvalFrom(accordAnalysis, 'seed-ap3', '2026-09-30T12:00:00.000Z', { approvalType: 'MARKED_RED' })],
  adminNotes: 'Revisit only if Pasom ever introduces installment terms.',
  timeline: [
    { id: 'seed-e6', at: '2026-09-30T11:00:00.000Z', adminLabel: 'Case submitted by client', clientLabel: 'Case submitted' },
    { id: 'seed-e7', at: '2026-09-30T11:20:00.000Z', adminLabel: 'Mock analysis v1 generated (RED)' },
    { id: 'seed-e8', at: '2026-09-30T12:00:00.000Z', adminLabel: 'Admin approved: RED (marked red; mock AI said RED)', clientLabel: 'Recommendation ready' },
  ],
});

// ------------------------------------------------------------------ SUPPORTING CASES

const lexusConversation = convo([
  ['PROSPECT', 'Hi, is the 2017 Lexus RX 350 available? I saw it on Google.', '25 Sep, 09:00'],
  ['BUSINESS', 'Yes, available. ₦24m, foreign used, 74,000 km.', '25 Sep, 09:20'],
  ['PROSPECT', 'Does it have the full service history? I want something I can use for long trips.', '25 Sep, 09:31'],
  ['BUSINESS', 'Yes, full service history from the dealer. Can you come by this week?', '25 Sep, 09:45'],
  ['PROSPECT', 'Possibly Thursday. My wife also needs to see it.', '25 Sep, 10:02'],
]);

const lexusAnalysis: ForensicAnalysis = {
  version: 1,
  generatedAt: '2026-10-03T09:30:00.000Z',
  isPlaceholder: false,
  basedOnMessageCount: lexusConversation.length,
  classification: 'GREEN',
  recoveryScore: 64,
  confidence: 0.58,
  buyingIntent: { level: 'Medium-High', evidence: 'Asked about service history for a stated use case and proposed a viewing day.' },
  financialCapability: { level: 'Unknown', evidence: 'No budget discussed; no reaction to the ₦24m price either way.' },
  offerFit: { level: 'Medium-High', evidence: 'Stated need (long trips, service history) matches the vehicle.' },
  lastStrongBuyingSignal: '"Possibly Thursday."',
  momentumBreakpoint: '"My wife also needs to see it." A second decision maker was introduced and no visit was confirmed.',
  primaryFriction: 'Viewing not scheduled; second decision maker involved.',
  secondaryFrictions: [],
  statedObjection: 'None.',
  underlyingFrictionHypothesis: 'Coordinating a joint visit (hypothesis).',
  structuralBlocker: 'None confirmed.',
  confirmedFacts: ['Prospect wants a vehicle for long trips.', 'Full service history confirmed.', 'Spouse involved in decision.'],
  inferences: ['Joint decision may slow scheduling (inference).'],
  unknowns: ['Budget.', 'Spouse’s view.', 'Whether still looking.'],
  alternativeHypotheses: ['Bought elsewhere.', 'Price above expectations (unconfirmed).'],
  sellerSideFriction: ['No specific time offered for Thursday.'],
  safetyFlags: [],
  nextObjective: 'Offer a concrete viewing slot that suits both decision makers.',
  mockAiProposedMessage:
    'Good morning. The RX 350 is still here. Would Thursday or Saturday suit you and your wife for a viewing? We can also do an evening slot if that is easier.',
  proposedDealSituation: 'This prospect previously showed meaningful buying interest and another conversation is justified.',
  proposedNextAction: 'Send the approved message below.',
};

const case4 = baseCase({
  id: 'case-004',
  clientId: 'client-pasom',
  reference: 'P-004',
  productService: '2017 Lexus RX 350',
  leadSource: 'Google',
  estimatedDealValue: 24000000,
  lastInteractionDate: '2026-09-25',
  createdAt: '2026-10-03T09:00:00.000Z',
  updatedAt: '2026-10-03T10:15:00.000Z',
  workflowState: 'CLIENT_ACTION_REQUIRED',
  conversation: lexusConversation,
  analysis: lexusAnalysis,
  approvals: [
    approvalFrom(lexusAnalysis, 'seed-ap4', '2026-10-03T10:15:00.000Z', {
      approvalType: 'EDITED',
      adminApprovedMessage:
        'Good morning. The RX 350 is still available. Would Thursday or Saturday suit you and your wife for a viewing? An evening slot is also possible.',
    }),
  ],
  adminNotes: 'Softened slightly: removed "still here".',
  timeline: [
    { id: 'seed-e9', at: '2026-10-03T09:00:00.000Z', adminLabel: 'Case submitted by client', clientLabel: 'Case submitted' },
    { id: 'seed-e10', at: '2026-10-03T09:30:00.000Z', adminLabel: 'Mock analysis v1 generated (GREEN)' },
    { id: 'seed-e11', at: '2026-10-03T10:15:00.000Z', adminLabel: 'Admin approved: GREEN (edited; mock AI said GREEN)', clientLabel: 'Recommendation ready' },
  ],
});

// Vee Culinary — response loop already in progress (queued before P-001).
const pastryMsg1 =
  'Hello Kemi, thanks for your interest in our Professional Pastry Course. Are you still hoping to start this year? Happy to answer any questions.';
const pastryConversation = [
  ...convo([
    ['PROSPECT', 'Good evening, I want to register for the pastry course. When is the next intake?', '10 Sep, 19:20'],
    ['BUSINESS', 'Next intake is 6 October. Fee is ₦250,000. Shall I send the registration form?', '11 Sep, 08:05'],
    ['PROSPECT', 'Yes please.', '11 Sep, 08:30'],
    ['BUSINESS', '[Registration form sent]', '11 Sep, 08:32'],
  ]),
  { id: 'seed-m-rm1', speaker: 'RECOVERY_MESSAGE' as const, text: pastryMsg1, at: '2026-09-24T10:00:00.000Z', attempt: 1 },
  {
    id: 'seed-m-rp1',
    speaker: 'PROSPECT' as const,
    text: 'Thanks for checking. I’m still interested but I can’t start in October. Do you have a weekend class or a January intake?',
    at: '2026-09-27T18:40:00.000Z',
    isRecoveryResponse: true,
  },
];

const pastryAnalysisV1: ForensicAnalysis = {
  version: 1,
  generatedAt: '2026-09-23T09:00:00.000Z',
  isPlaceholder: false,
  basedOnMessageCount: 4,
  classification: 'GREEN',
  recoveryScore: 66,
  confidence: 0.6,
  buyingIntent: { level: 'High', evidence: '"I want to register" and accepted the registration form.' },
  financialCapability: { level: 'Unknown', evidence: 'Fee was stated; no reaction either way.' },
  offerFit: { level: 'Medium', evidence: 'Course matches the request; timing fit unknown.' },
  lastStrongBuyingSignal: '"Yes please." (to the registration form)',
  momentumBreakpoint: 'After the form was sent; it was never returned.',
  primaryFriction: 'Registration form not returned.',
  secondaryFrictions: [],
  statedObjection: 'None.',
  underlyingFrictionHypothesis: 'Timing or a practical barrier to completing registration (hypothesis).',
  structuralBlocker: 'None confirmed.',
  confirmedFacts: ['Prospect said they want to register.', 'Form sent 11 Sep; not returned.'],
  inferences: [],
  unknowns: ['Why the form was not returned.', 'Affordability.'],
  alternativeHypotheses: ['Timing does not suit.', 'Enrolled elsewhere.'],
  sellerSideFriction: [],
  safetyFlags: [],
  nextObjective: 'Re-open without pressure and learn what stopped registration.',
  mockAiProposedMessage: pastryMsg1,
  proposedDealSituation: 'This prospect previously showed meaningful buying interest and another conversation is justified.',
  proposedNextAction: 'Send the approved message below.',
};

const pastryAnalysisV2: ForensicAnalysis = {
  ...pastryAnalysisV1,
  version: 2,
  generatedAt: '2026-09-28T07:30:00.000Z',
  basedOnMessageCount: pastryConversation.length,
  classification: 'GREEN',
  recoveryScore: 74,
  confidence: 0.7,
  buyingIntent: { level: 'High', evidence: 'Replied to the recovery message stating continued interest and asked about alternative schedules.' },
  offerFit: { level: 'Unknown', evidence: 'Depends on whether a weekend class or January intake exists. The business has not confirmed either.' },
  lastStrongBuyingSignal: '"I’m still interested … Do you have a weekend class or a January intake?"',
  momentumBreakpoint: 'Resolved: the barrier was timing (October start), now stated by the prospect.',
  primaryFriction: 'Start date: prospect cannot start in October.',
  secondaryFrictions: [],
  statedObjection: 'Cannot start in October.',
  underlyingFrictionHypothesis: 'Timing only — stated directly.',
  structuralBlocker: 'Possible, if the business has neither a weekend class nor a January intake. UNKNOWN until the business confirms.',
  confirmedFacts: [
    'Prospect is still interested (own words).',
    'Prospect cannot start in October.',
    'Prospect asked about a weekend class or January intake.',
  ],
  inferences: [],
  unknowns: ['Whether Vee Culinary runs a weekend class or January intake.', 'Affordability.'],
  alternativeHypotheses: [],
  sellerSideFriction: [],
  safetyFlags: ['Do not invent a schedule. The client must confirm availability before the message is sent.'],
  nextObjective: 'Answer the schedule question accurately and offer the next available option.',
  mockAiProposedMessage:
    'Thanks for getting back to me, Kemi. Our next intake after October is in January, and we also run a Saturday class. Would either of those work for you? I can hold a place while you decide.',
};

const case5 = baseCase({
  id: 'case-005',
  clientId: 'client-vee',
  reference: 'P-005',
  productService: 'Professional Pastry Course',
  leadSource: 'Referral',
  estimatedDealValue: 250000,
  lastInteractionDate: '2026-09-11',
  createdAt: '2026-09-23T08:40:00.000Z',
  updatedAt: '2026-09-28T07:30:00.000Z',
  queuedAt: '2026-09-27T18:45:00.000Z',
  reviewReason: 'PROSPECT_RESPONSE',
  workflowState: 'AWAITING_ADMIN_REVIEW',
  conversation: pastryConversation,
  analysis: pastryAnalysisV2,
  analysisHistory: [pastryAnalysisV1],
  approvals: [approvalFrom(pastryAnalysisV1, 'seed-ap5', '2026-09-23T10:00:00.000Z')],
  sentRecords: [
    { attempt: 1, approvalId: 'seed-ap5', approvedMessage: pastryMsg1, actualSentMessage: pastryMsg1, sentExactly: true, sentAt: '2026-09-24T10:00:00.000Z' },
  ],
  responses: [{ afterAttempt: 1, text: pastryConversation[pastryConversation.length - 1].text, addedAt: '2026-09-27T18:45:00.000Z' }],
  adminNotes: 'Check with Vee whether a January intake actually exists before approving — the mock message asserts it.',
  timeline: [
    { id: 'seed-e12', at: '2026-09-23T08:40:00.000Z', adminLabel: 'Case submitted by client', clientLabel: 'Case submitted' },
    { id: 'seed-e13', at: '2026-09-23T09:00:00.000Z', adminLabel: 'Mock analysis v1 generated (GREEN)' },
    { id: 'seed-e14', at: '2026-09-23T10:00:00.000Z', adminLabel: 'Admin approved: GREEN (unchanged; mock AI said GREEN)', clientLabel: 'Recommendation ready' },
    { id: 'seed-e15', at: '2026-09-24T10:00:00.000Z', adminLabel: 'Recovery message 1 sent by client (exactly as approved)', clientLabel: 'Message sent (attempt 1)' },
    { id: 'seed-e16', at: '2026-09-27T18:45:00.000Z', adminLabel: 'Prospect response added by client; returned to review queue', clientLabel: 'Prospect response added — under review' },
    { id: 'seed-e17', at: '2026-09-28T07:30:00.000Z', adminLabel: 'Mock analysis v2 generated (GREEN)' },
  ],
});

// Vee Culinary — waiting for prospect, client changed the message before sending.
const baking = {
  approved: 'Hi Tola, just checking whether the Saturday Baking Masterclass is still something you’d like to attend. Happy to answer any questions.',
  actual: 'Hi Tola, just checking whether the Saturday Baking Masterclass is still something you’d like to attend? We have 3 seats left.',
};
const bakingAnalysis: ForensicAnalysis = {
  ...lexusAnalysis,
  generatedAt: '2026-09-30T09:00:00.000Z',
  basedOnMessageCount: 3,
  classification: 'YELLOW',
  recoveryScore: 45,
  confidence: 0.4,
  buyingIntent: { level: 'Low-Medium', evidence: 'Asked the date and price only.' },
  financialCapability: { level: 'Unknown', evidence: 'Not discussed.' },
  offerFit: { level: 'Unknown', evidence: 'Not discussed.' },
  lastStrongBuyingSignal: 'None strong.',
  momentumBreakpoint: 'After price was shared. Timing only; cause unknown.',
  primaryFriction: 'Unknown.',
  secondaryFrictions: [],
  statedObjection: 'None.',
  underlyingFrictionHypothesis: 'Not determinable.',
  structuralBlocker: 'None identified.',
  confirmedFacts: ['Prospect asked about the date and price of the Saturday masterclass.'],
  inferences: [],
  unknowns: ['Current interest.', 'Affordability.', 'Availability on the date.'],
  alternativeHypotheses: ['Just browsing.', 'Date does not suit.', 'Price above expectations (unconfirmed).'],
  sellerSideFriction: ['No question asked back to the prospect.'],
  safetyFlags: ['Do not add scarcity claims that are not verified.'],
  nextObjective: 'Learn whether interest remains.',
  mockAiProposedMessage: baking.approved,
  proposedDealSituation: "There isn't enough information yet to determine whether this opportunity is still active.",
  proposedNextAction: "Send this short message to clarify the prospect's current position.",
};
const case6 = baseCase({
  id: 'case-006',
  clientId: 'client-vee',
  reference: 'P-006',
  productService: 'Saturday Baking Masterclass',
  leadSource: 'Facebook / Instagram Ads',
  estimatedDealValue: 60000,
  lastInteractionDate: '2026-09-26',
  createdAt: '2026-09-30T08:30:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
  workflowState: 'WAITING_FOR_PROSPECT',
  conversation: [
    ...convo([
      ['PROSPECT', 'When is the next baking masterclass and how much?', '26 Sep, 12:10'],
      ['BUSINESS', 'Saturday 18 October, 10am–4pm. ₦60,000 including ingredients.', '26 Sep, 12:30'],
      ['PROSPECT', 'Ok', '26 Sep, 12:41'],
    ]),
    { id: 'seed-m-rm6', speaker: 'RECOVERY_MESSAGE', text: baking.actual, at: '2026-10-02T12:00:00.000Z', attempt: 1 },
  ],
  analysis: bakingAnalysis,
  approvals: [approvalFrom(bakingAnalysis, 'seed-ap6', '2026-10-01T15:00:00.000Z')],
  sentRecords: [
    { attempt: 1, approvalId: 'seed-ap6', approvedMessage: baking.approved, actualSentMessage: baking.actual, sentExactly: false, sentAt: '2026-10-02T12:00:00.000Z' },
  ],
  timeline: [
    { id: 'seed-e18', at: '2026-09-30T08:30:00.000Z', adminLabel: 'Case submitted by client', clientLabel: 'Case submitted' },
    { id: 'seed-e19', at: '2026-09-30T09:00:00.000Z', adminLabel: 'Mock analysis v1 generated (YELLOW)' },
    { id: 'seed-e20', at: '2026-10-01T15:00:00.000Z', adminLabel: 'Admin approved: YELLOW (unchanged; mock AI said YELLOW)', clientLabel: 'Recommendation ready' },
    { id: 'seed-e21', at: '2026-10-02T12:00:00.000Z', adminLabel: 'Recovery message 1 sent by client (CHANGED by client)', clientLabel: 'Message sent (attempt 1)' },
  ],
});

// Pasom Autos — already recovered.
const highlanderMsg = 'Good afternoon. The Highlander is still available if you would like to view it this week. Let me know a day that suits you.';
const highlanderMsg2 = 'Great, see you Thursday afternoon. Our address is Admiralty Way, Lekki.';
const highlanderAnalysisV1: ForensicAnalysis = {
  ...lexusAnalysis,
  generatedAt: '2026-09-08T10:00:00.000Z',
  basedOnMessageCount: 3,
  recoveryScore: 60,
  confidence: 0.55,
  buyingIntent: { level: 'Medium', evidence: 'Referred prospect; asked about availability; deferred viewing.' },
  financialCapability: { level: 'Unknown', evidence: 'Not discussed.' },
  offerFit: { level: 'Unknown', evidence: 'No requirements stated.' },
  lastStrongBuyingSignal: 'Referral plus direct availability question.',
  momentumBreakpoint: '"I will let you know when I am free." Next step owned by the prospect with no date.',
  primaryFriction: 'Viewing not scheduled.',
  secondaryFrictions: [],
  statedObjection: 'None.',
  underlyingFrictionHypothesis: 'Availability / scheduling (hypothesis).',
  structuralBlocker: 'None confirmed.',
  confirmedFacts: ['Referred by a family member.', 'Price ₦14.5m shared.', 'Prospect deferred the viewing.'],
  inferences: [],
  unknowns: ['Budget.', 'Timing.', 'Whether still looking.'],
  alternativeHypotheses: ['Bought elsewhere.', 'Lower priority than stated.'],
  sellerSideFriction: ['No specific viewing time offered.'],
  safetyFlags: [],
  nextObjective: 'Offer a viewing without pressure.',
  mockAiProposedMessage: highlanderMsg,
};
const highlanderAnalysisV2: ForensicAnalysis = {
  ...highlanderAnalysisV1,
  version: 2,
  generatedAt: '2026-09-11T09:00:00.000Z',
  basedOnMessageCount: 5,
  recoveryScore: 82,
  confidence: 0.75,
  buyingIntent: { level: 'High', evidence: 'Proposed a viewing day and said they would bring a mechanic.' },
  lastStrongBuyingSignal: '"Thursday afternoon works. I will bring my mechanic."',
  momentumBreakpoint: 'None — momentum restored.',
  primaryFriction: 'None current.',
  confirmedFacts: [...highlanderAnalysisV1.confirmedFacts, 'Prospect agreed to view Thursday afternoon with a mechanic.'],
  nextObjective: 'Confirm the viewing logistics.',
  mockAiProposedMessage: highlanderMsg2,
};
const case7 = baseCase({
  id: 'case-007',
  clientId: 'client-pasom',
  reference: 'P-007',
  productService: '2015 Toyota Highlander',
  leadSource: 'Referral',
  estimatedDealValue: 14500000,
  lastInteractionDate: '2026-09-05',
  createdAt: '2026-09-08T09:00:00.000Z',
  updatedAt: '2026-09-19T16:00:00.000Z',
  workflowState: 'WON',
  conversation: [
    ...convo([
      ['PROSPECT', 'Is the 2015 Highlander still available? My brother referred me.', '3 Sep, 11:00'],
      ['BUSINESS', 'Yes, ₦14.5m. Happy to arrange a viewing.', '3 Sep, 11:20'],
      ['PROSPECT', 'I will let you know when I am free.', '5 Sep, 17:00'],
    ]),
    { id: 'seed-m-rm7', speaker: 'RECOVERY_MESSAGE', text: highlanderMsg, at: '2026-09-10T13:00:00.000Z', attempt: 1 },
    { id: 'seed-m-rp7', speaker: 'PROSPECT', text: 'Thursday afternoon works. I will bring my mechanic.', at: '2026-09-10T15:30:00.000Z', isRecoveryResponse: true },
    { id: 'seed-m-rm7b', speaker: 'RECOVERY_MESSAGE', text: highlanderMsg2, at: '2026-09-11T10:30:00.000Z', attempt: 2 },
  ],
  analysis: highlanderAnalysisV2,
  analysisHistory: [highlanderAnalysisV1],
  approvals: [
    approvalFrom(highlanderAnalysisV1, 'seed-ap7a', '2026-09-08T11:00:00.000Z'),
    approvalFrom(highlanderAnalysisV2, 'seed-ap7b', '2026-09-11T10:00:00.000Z'),
  ],
  sentRecords: [
    { attempt: 1, approvalId: 'seed-ap7a', approvedMessage: highlanderMsg, actualSentMessage: highlanderMsg, sentExactly: true, sentAt: '2026-09-10T13:00:00.000Z' },
    { attempt: 2, approvalId: 'seed-ap7b', approvedMessage: highlanderMsg2, actualSentMessage: highlanderMsg2, sentExactly: true, sentAt: '2026-09-11T10:30:00.000Z' },
  ],
  responses: [{ afterAttempt: 1, text: 'Thursday afternoon works. I will bring my mechanic.', addedAt: '2026-09-10T15:35:00.000Z' }],
  outcome: {
    state: 'WON',
    recordedAt: '2026-09-19T16:00:00.000Z',
    recordedBy: 'CLIENT',
    won: { dealValue: 14500000, amountPaid: 14200000, paymentDate: '2026-09-19', notes: 'Paid by bank transfer after inspection.' },
  },
  timeline: [
    { id: 'seed-e22', at: '2026-09-08T09:00:00.000Z', adminLabel: 'Case submitted by client', clientLabel: 'Case submitted' },
    { id: 'seed-e23', at: '2026-09-08T11:00:00.000Z', adminLabel: 'Admin approved: GREEN (unchanged)', clientLabel: 'Recommendation ready' },
    { id: 'seed-e24', at: '2026-09-10T13:00:00.000Z', adminLabel: 'Recovery message 1 sent', clientLabel: 'Message sent (attempt 1)' },
    { id: 'seed-e25', at: '2026-09-10T15:35:00.000Z', adminLabel: 'Prospect response added', clientLabel: 'Prospect response added — under review' },
    { id: 'seed-e26', at: '2026-09-11T10:00:00.000Z', adminLabel: 'Admin approved: GREEN (unchanged)', clientLabel: 'Recommendation ready' },
    { id: 'seed-e27', at: '2026-09-11T10:30:00.000Z', adminLabel: 'Recovery message 2 sent', clientLabel: 'Message sent (attempt 2)' },
    { id: 'seed-e28', at: '2026-09-19T16:00:00.000Z', adminLabel: 'Deal won — recovered (recorded by client)', clientLabel: 'Deal won — recovered' },
  ],
});

export function createSeedData(): AppData {
  return {
    schemaVersion: SCHEMA_VERSION,
    demoClientId: 'client-pasom',
    clients: [
      { id: 'client-pasom', businessName: 'Pasom Autos', industry: 'Automotive dealership', currency: 'NGN', userName: 'Demo User (Pasom)', userEmail: 'demo@pasomautos.example' },
      { id: 'client-fineez', businessName: 'Fineez Designs Academy', industry: 'Fashion design training', currency: 'NGN', userName: 'Demo User (Fineez)', userEmail: 'demo@fineez.example' },
      { id: 'client-vee', businessName: 'Vee Culinary Arts', industry: 'Culinary school', currency: 'NGN', userName: 'Demo User (Vee)', userEmail: 'demo@veeculinary.example' },
    ],
    // structuredClone keeps the seed constants pristine across resets.
    cases: structuredClone([case1, case2, case3, case4, case5, case6, case7]),
  };
}
