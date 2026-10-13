// Stage 2A-5c — founder-only analysis workspace (read-only).
//
// Rendered only inside FounderCasePage, which the router shows only to a
// server-verified FOUNDER. That is convenience, not the security boundary: the
// reads below go to public.analyses / public.contact_restrictions, whose RLS
// returns rows only to the founder. All text is rendered as plain text (React
// escapes it). Nothing here sends a message to anyone.

import { useEffect, useState } from 'react';
import { Card, EmptyState, ErrorBanner, formatDate, Notice } from '../components/ui';
import { useAuth } from './auth';
import {
  analysisState, CATEGORY_LABELS, CATEGORY_ORDER, challenges, describeRef, excludedScreenshots, parseAnalysisOutput, proposedMessage,
  showsFindings, STATE_TEXT, type AdversarialReview, type AnalysisRow, type EvidenceRef, type Hypothesis, type RestrictionRow,
} from './analysis';

const ACTOR = { PROSPECT: 'Prospect', SELLER: 'Seller', UNCLEAR: 'Unclear who' } as const;
const PURSUE = { PURSUE: 'Pursue recovery', DO_NOT_PURSUE: 'Do not pursue', UNKNOWN: 'Unknown — not enough to decide' } as const;
const NEXT = { SEND_MESSAGE: 'Message (draft)', ASK_DIAGNOSTIC_QUESTION: 'Diagnostic question', WAIT: 'Wait', STOP_CONTACT: 'Stop contact' } as const;
const VERDICT = {
  UPHOLD: { label: 'Recommendation upheld', cls: 'pill-won' },
  UPHOLD_WITH_CONCERNS: { label: 'Upheld with concerns', cls: 'pill-info' },
  REJECT_RECOMMENDATION: { label: 'Recommendation rejected', cls: 'badge-red' },
} as const;
const TARGET = { OBSERVATION: 'Observation', HYPOTHESIS: 'Hypothesis', RECOMMENDATION: 'Recommendation' } as const;
const CHALLENGE = {
  RESTRICTION: 'Contact restriction', CONTRADICTION: 'Contradicting evidence', COMPETING: 'Competing explanation',
  LOW_CONFIDENCE: 'Weak support', REASON_NOT_TO_PURSUE: 'Reason not to pursue', UNKNOWN: 'Open question',
} as const;

function Refs({ refs, kinds }: { refs: EvidenceRef[]; kinds: Record<string, string> }) {
  if (refs.length === 0) return null;
  return (
    <ul className="muted small" data-testid="evidence-refs">
      {refs.map((r, i) => <li key={i}>{describeRef(r, kinds)}</li>)}
    </ul>
  );
}

function HypothesisItem({ h }: { h: Hypothesis }) {
  const stated = h.basis === 'STATED_BY_PROSPECT';
  return (
    <li data-testid="hypothesis" data-basis={h.basis}>
      <p>
        <span className={`pill ${stated ? 'pill-won' : 'pill-info'}`}>{stated ? 'Stated by prospect' : 'Hypothesis — interpretation, not fact'}</span>{' '}
        <span className="pill" data-testid="confidence">Confidence: {h.confidence}</span>{' '}
        <span className="muted small">{h.id}</span>
      </p>
      <p>{h.statement}</p>
      <p className="muted small">Uncertainty: {h.uncertainty || '—'}</p>
      <p className="muted small">
        Supported by {h.supporting.join(', ') || '—'}
        {h.contradicting.length > 0 && <> · Contradicted by {h.contradicting.join(', ')}</>}
        {h.competing.length > 0 && <> · Competes with {h.competing.join(', ')}</>}
      </p>
    </li>
  );
}

/** The independent adversarial review (rre-analysis/2), or a note that there is none. */
function IndependentReview({ review, kinds }: { review: AdversarialReview | null; kinds: Record<string, string> }) {
  if (!review) {
    return (
      <Card title="Independent review">
        <p className="muted" data-testid="review-none">No independent review: this analysis uses contract rre-analysis/1, which has none.</p>
      </Card>
    );
  }
  const v = VERDICT[review.verdict];
  return (
    <Card title="Independent review" className={review.verdict === 'REJECT_RECOMMENDATION' ? 'card-stop' : undefined}>
      <div data-testid="independent-review">
        <p className="muted small">A separate adversarial pass that tried to break this analysis. Its evidence citations were checked against the case evidence.</p>
        <p><span className={`pill ${v.cls}`} data-testid="review-verdict" data-verdict={review.verdict}>{v.label}</span></p>
        {review.rationale && <p data-testid="review-rationale">{review.rationale}</p>}
        {review.challenges.length === 0 ? <p className="muted">No challenges raised.</p> : (
          <ul>
            {review.challenges.map((c) => (
              <li key={c.id} data-testid="review-challenge" data-severity={c.severity}>
                <p>
                  <span className={`pill ${c.severity === 'HIGH' ? 'badge-red' : c.severity === 'MEDIUM' ? 'pill-info' : ''}`}>{c.severity}</span>{' '}
                  <span className="muted small">{c.id} · {TARGET[c.target]}{c.targetId ? ` ${c.targetId}` : ''}</span>
                </p>
                <p>{c.challenge}</p>
                <Refs refs={c.evidence} kinds={kinds} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** The founder-only analysis section of a case. */
export function FounderAnalysis({ caseId, evidenceVersion }: { caseId: string; evidenceVersion: number }) {
  const { supabase } = useAuth();
  const [rows, setRows] = useState<AnalysisRow[] | null>(null);
  const [restrictions, setRestrictions] = useState<RestrictionRow[]>([]);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [a, r, m] = await Promise.all([
        supabase.from('analyses')
          .select('id, version, status, evidence_version, evidence_manifest, output, ai_classification, ai_proposed_message, error, model, prompt_version, created_at, completed_at')
          .eq('case_id', caseId).order('version', { ascending: false }),
        supabase.from('contact_restrictions').select('id, kind, source, status, note, created_at').eq('case_id', caseId).order('created_at'),
        supabase.from('case_messages').select('id, kind').eq('case_id', caseId),
      ]);
      if (!active) return;
      if (a.error || r.error) {
        setError('Could not load the analysis.');
        return;
      }
      setRows((a.data ?? []) as AnalysisRow[]);
      setRestrictions((r.data ?? []) as RestrictionRow[]);
      setKinds(Object.fromEntries(((m.data ?? []) as { id?: string; kind: string }[]).filter((x) => x.id).map((x) => [x.id!, x.kind])));
    })();
    return () => {
      active = false;
    };
  }, [supabase, caseId]);

  if (error) return <ErrorBanner message={error} />;
  if (rows === null) return <p className="muted" role="status">Loading analysis…</p>;

  const { state, latest } = analysisState(rows, evidenceVersion);
  const info = STATE_TEXT[state];
  const output = latest && showsFindings(state) ? parseAnalysisOutput(latest.output) : null;
  const activeRestrictions = restrictions.filter((x) => x.status === 'ACTIVE');
  const message = proposedMessage(state, latest, output, restrictions);
  const excluded = latest ? excludedScreenshots(latest.evidence_manifest) : [];

  return (
    <section data-testid="founder-analysis" aria-label="Analysis (founder only)">
      <Notice tone="private">Founder only. This analysis is never shown to the business. Nothing on this page sends a message.</Notice>

      {activeRestrictions.length > 0 && (
        <Card title="Contact restricted — do not contact" className="card-stop">
          <ul data-testid="active-restrictions">
            {activeRestrictions.map((x) => (
              <li key={x.id}><strong>{x.kind}</strong> ({x.source}){x.note ? ` — ${x.note}` : ''}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={info.title}>
        <div data-testid="analysis-state" data-state={state}>
          <Notice tone={info.tone}>{info.body}</Notice>
          {latest && (
            <p className="muted small">
              Analysis v{latest.version} · {latest.status} · evidence version {latest.evidence_version} (case is at {evidenceVersion})
              {latest.completed_at ? ` · ${formatDate(latest.completed_at, true)}` : ''}
              {latest.prompt_version ? ` · prompt ${latest.prompt_version}` : ''}
            </p>
          )}
          {(state === 'REJECTED' || state === 'FAILED' || (state === 'STALE' && latest?.status === 'ERROR')) && latest?.error && (
            <pre className="message-card faded" data-testid="analysis-error">{latest.error}</pre>
          )}
          {excluded.length > 0 && (
            <p className="muted small" data-testid="excluded-screenshots">
              Not analysed: screenshot{excluded.length > 1 ? 's' : ''} {excluded.join(', ')} (file deleted under retention).
            </p>
          )}
        </div>
      </Card>

      {state === 'NONE' && <EmptyState title="Nothing to review yet." />}

      {output && (
        <>
          <Card title="Evidence assessment">
            <p data-testid="sufficiency"><strong>{output.sufficiency}</strong> — {output.summary}</p>
            {output.missingEvidence.length > 0 && (
              <ul data-testid="missing-evidence">{output.missingEvidence.map((x, i) => <li key={i}>Missing: {x}</li>)}</ul>
            )}
          </Card>

          <Card title="Observed behaviour (evidence-backed)">
            {output.observations.length === 0 ? <EmptyState title="No observations." /> : (
              <ul data-testid="observations">
                {output.observations.map((o) => (
                  <li key={o.id} data-testid="observation">
                    <p><span className="muted small">{o.id} · {ACTOR[o.actor]}</span></p>
                    <p>{o.behavior}</p>
                    <Refs refs={o.evidence} kinds={kinds} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Interpretations (hypotheses, not facts)">
            <div data-testid="hypotheses">
              {output.hypotheses.length === 0 && <EmptyState title="No interpretations were made." />}
              {CATEGORY_ORDER.map((cat) => {
                const items = output.hypotheses.filter((h) => h.category === cat);
                return (
                  <div key={cat} data-testid={`category-${cat}`}>
                    <h3>{CATEGORY_LABELS[cat]}</h3>
                    {items.length === 0
                      ? <p className="muted small">Not supported by the evidence in this analysis.</p>
                      : <ul>{items.map((h) => <HypothesisItem key={h.id} h={h} />)}</ul>}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Unknowns">
            {output.unknowns.length === 0 ? <p className="muted">None recorded.</p> : (
              <ul data-testid="unknowns">{output.unknowns.map((u, i) => <li key={i}>{u.question}{u.whyItMatters ? ` — ${u.whyItMatters}` : ''}</li>)}</ul>
            )}
          </Card>

          <IndependentReview review={output.review} kinds={kinds} />

          <Card title="Weak points recorded by the analysis itself">
            <p className="muted small">Reasons this analysis or its recommendation could be wrong, taken from the analysis itself.</p>
            {(() => {
              const list = challenges(output, restrictions);
              return list.length === 0 ? <p className="muted">None recorded — treat that with caution.</p> : (
                <ul data-testid="challenges">{list.map((c, i) => <li key={i} data-kind={c.kind}><strong>{CHALLENGE[c.kind]}:</strong> {c.text}</li>)}</ul>
              );
            })()}
          </Card>

          <Card title="Recommendation (internal)">
            <dl className="kv" data-testid="recommendation">
              <div><dt>Decision</dt><dd>{PURSUE[output.recommendation.pursue]}</dd></div>
              <div><dt>Strategy</dt><dd>{output.recommendation.strategy}</dd></div>
              <div><dt>Psychological rationale</dt><dd>{output.recommendation.rationale}</dd></div>
              <div><dt>Based on</dt><dd>{output.recommendation.basedOn.join(', ') || '—'}</dd></div>
              <div><dt>Next action</dt><dd>{output.recommendation.nextAction ? `${NEXT[output.recommendation.nextAction.type]}: ${output.recommendation.nextAction.text}` : '—'}</dd></div>
            </dl>
            {output.reasonsNotToPursue.length > 0 && (
              <ul data-testid="reasons-not-to-pursue">{output.reasonsNotToPursue.map((r, i) => <li key={i}>Reason not to pursue: {r.reason}</li>)}</ul>
            )}
            {message.text && (
              <div data-testid="proposed-message">
                <p className="muted small">Draft for your review — not sent. Nothing on this page sends it.</p>
                <pre className="message-card">{message.text}</pre>
              </div>
            )}
            {message.withheld && <Notice tone="warn"><span data-testid="message-withheld">{message.withheld}</span></Notice>}
          </Card>
        </>
      )}
    </section>
  );
}
