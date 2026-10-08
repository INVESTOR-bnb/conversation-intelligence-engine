// Stage-1 MOCK analysis. No AI is called anywhere in this prototype.
//
// Seeded demo cases carry hand-written analyses (see data/mockData.ts). Cases
// created or updated during the demo get a generic placeholder from this file.
// The placeholder deliberately does not pretend to understand the conversation:
// it records what is mechanically known and leaves everything else UNKNOWN.

import type { ConversationMessage, ForensicAnalysis, RecoveryCase, Speaker } from './types';

const SPEAKER_PREFIXES: [RegExp, Speaker][] = [
  [/^(prospect|customer|client|lead|buyer|them|they)\s*[:\-–]\s*/i, 'PROSPECT'],
  [/^(business|seller|me|us|we|agent|sales|staff|admin)\s*[:\-–]\s*/i, 'BUSINESS'],
];

let idCounter = 0;
export function newId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Splits pasted conversation text into messages. Lines starting with a known
 * speaker prefix (e.g. "Prospect:" / "Business:") start a new message; other
 * lines continue the previous message. Text with no recognised prefix is kept
 * as UNATTRIBUTED rather than guessed.
 */
export function parseConversation(raw: string, businessName?: string): ConversationMessage[] {
  const prefixes = [...SPEAKER_PREFIXES];
  if (businessName) {
    const escaped = businessName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    prefixes.push([new RegExp(`^${escaped}\\s*[:\\-–]\\s*`, 'i'), 'BUSINESS']);
  }
  const out: ConversationMessage[] = [];
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = prefixes.find(([re]) => re.test(trimmed));
    if (match) {
      out.push({ id: newId('m'), speaker: match[1], text: trimmed.replace(match[0], '') });
    } else if (out.length > 0) {
      out[out.length - 1].text += `\n${trimmed}`;
    } else {
      out.push({ id: newId('m'), speaker: 'UNATTRIBUTED', text: trimmed });
    }
  }
  return out;
}

const OPT_OUT_PATTERNS = [
  /don'?t (contact|message|call|text) me/i,
  /do not (contact|message|call|text) me/i,
  /stop (messaging|contacting|calling|texting)/i,
  /remove me/i,
  /leave me alone/i,
  /unsubscribe/i,
];

function detectOptOut(text: string) {
  return OPT_OUT_PATTERNS.some((re) => re.test(text));
}

/**
 * Generic placeholder analysis for cases created/updated during the demo.
 * Default classification is YELLOW (insufficient information) with no proposed
 * message: the admin must write one. Explicit opt-out language forces RED.
 */
export function placeholderAnalysis(c: RecoveryCase, version: number): ForensicAnalysis {
  const prospectMsgs = c.conversation.filter((m) => m.speaker === 'PROSPECT');
  const lastProspect = prospectMsgs[prospectMsgs.length - 1];
  const last = c.conversation[c.conversation.length - 1];
  const latestResponse = c.responses[c.responses.length - 1];
  const optOut = c.conversation.some((m) => m.speaker === 'PROSPECT' && detectOptOut(m.text));
  const shots = c.screenshots?.length ?? 0;

  const confirmedFacts = [
    `Product / service: ${c.productService}.`,
    `Lead source: ${c.leadSource}.`,
  ];
  if (shots > 0) {
    confirmedFacts.push(`Historical conversation submitted as ${shots} screenshot(s). Their contents were NOT read (no OCR in Stage 1).`);
  }
  confirmedFacts.push(`${c.conversation.length} text message(s) on record; ${prospectMsgs.length} attributed to the prospect.`);
  if (last) confirmedFacts.push(`Last recorded message was from: ${last.speaker.replace('_', ' ').toLowerCase()}.`);
  if (c.sentRecords.length > 0) confirmedFacts.push(`${c.sentRecords.length} recovery message(s) recorded as sent.`);
  if (latestResponse) confirmedFacts.push(`Latest prospect response (verbatim): "${latestResponse.text}"`);
  if (c.conversation.some((m) => m.speaker === 'UNATTRIBUTED'))
    confirmedFacts.push('Some pasted text could not be attributed to a speaker.');

  const safetyFlags = optOut
    ? ['Possible explicit opt-out language detected in a prospect message. Do not send a sales message.']
    : [];

  return {
    version,
    generatedAt: new Date().toISOString(),
    isPlaceholder: true,
    basedOnMessageCount: c.conversation.length,
    note:
      'Stage-1 placeholder. No real analysis was performed; only mechanically observable facts are listed. ' +
      (shots > 0
        ? 'Screenshot contents are not read in Stage 1: open the screenshots, read the conversation and apply your own judgement before approving.'
        : 'Read the conversation and apply your own judgement before approving.'),
    classification: optOut ? 'RED' : 'YELLOW',
    recoveryScore: null,
    confidence: null,
    buyingIntent: { level: 'Unknown', evidence: 'Not assessed by placeholder.' },
    financialCapability: { level: 'Unknown', evidence: 'Not assessed. Silence or price discussion alone does not establish affordability either way.' },
    offerFit: { level: 'Unknown', evidence: 'Not assessed by placeholder.' },
    lastStrongBuyingSignal: 'Not assessed.',
    momentumBreakpoint: lastProspect
      ? `Last prospect message: "${truncate(lastProspect.text, 140)}"`
      : shots > 0
        ? 'Not determinable — screenshots are not read in Stage 1.'
        : 'No prospect message identified.',
    primaryFriction: 'Unknown.',
    secondaryFrictions: [],
    statedObjection: 'Not assessed.',
    underlyingFrictionHypothesis: 'None proposed. Placeholder does not generate hypotheses.',
    structuralBlocker: optOut ? 'Possible explicit opt-out (verify in conversation).' : 'None identified (not assessed).',
    confirmedFacts,
    inferences: [],
    unknowns: [
      'Current interest level',
      'Affordability / budget',
      'Reason the conversation stalled',
      'Whether the prospect has bought elsewhere',
    ],
    alternativeHypotheses: [],
    sellerSideFriction: [],
    safetyFlags,
    nextObjective: optOut ? 'Respect the opt-out. No further contact.' : 'Admin to determine.',
    mockAiProposedMessage: null,
    proposedDealSituation: optOut
      ? 'This prospect is not currently recommended for further recovery attempts.'
      : "There isn't enough information yet to determine whether this opportunity is still active.",
    proposedNextAction: optOut
      ? 'No further contact is recommended.'
      : "Send this short message to clarify the prospect's current position.",
  };
}

/**
 * Simulated (re)analysis. If nothing new has been added since the last analysis,
 * the existing analysis is re-issued unchanged under a new version number.
 */
export function runMockAnalysis(c: RecoveryCase): ForensicAnalysis {
  const nextVersion = (c.analysis?.version ?? 0) + 1;
  if (c.analysis && c.analysis.basedOnMessageCount === c.conversation.length) {
    return {
      ...c.analysis,
      version: nextVersion,
      generatedAt: new Date().toISOString(),
      note: 'Mock reanalysis: no new information since the previous analysis, so conclusions are unchanged.',
    };
  }
  return placeholderAnalysis(c, nextVersion);
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
