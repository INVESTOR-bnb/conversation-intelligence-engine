// V0 commercial workflow screens (live mode). Each action calls one existing, server-checked
// database function or the founder-only analyze-case Edge Function; nothing here decides access.
// Founder: run analysis → decide (approve / edit / RED) → follow the case. Business: read the
// approved message only → send it themselves → record replies and the outcome.

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ClassificationBadge, ConfirmBox, CopyButton, EmptyState, ErrorBanner, Field, formatDate, formatMoney, Notice, ScreenHeader } from '../components/ui';
import type { Classification } from '../domain/types';
import { analysisState, parseAnalysisOutput, proposedMessage, type AnalysisRow, type AnalysisState, type RestrictionRow } from './analysis';
import { useAuth } from './auth';
import { clientStatusLabel } from './cases';
import { navigate } from './router';
import {
  actionErrorMessage, analysisRunMessage, approvalType, canRunAnalysis, CLIENT_TEXT_DEFAULTS, DECISION_LIMITS, OUTCOME_LABELS, OUTCOME_STATES,
  validateDecision, validateOutcome, whatsappLink, type Decision, type DecisionErrors, type OutcomeErrors, type OutcomeInput, type OutcomeState,
} from './workflow';

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- founder: run the analysis

/** Starts ONE analysis through the analyze-case Edge Function, with the founder's own session. */
export function FounderRunAnalysis({ caseId, workflowState, onDone }: { caseId: string; workflowState: string; onDone: () => void }) {
  const { supabase } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  if (!canRunAnalysis(workflowState) && !result) return null;

  const run = async () => {
    setConfirming(false);
    setRunning(true);
    setResult(null);
    let body: { outcome?: string; code?: string } | null = null;
    const { data, error } = await supabase.functions.invoke('analyze-case', { body: { case_id: caseId } });
    if (!error) body = data as typeof body;
    else {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') {
        try { body = await ctx.json(); } catch { body = null; }
      }
    }
    setRunning(false);
    setResult(body?.outcome && body.code ? analysisRunMessage(body.outcome, body.code)
      : { tone: 'warn', text: 'Could not reach the analysis service. Check your connection; if this persists, the case state shows whether anything started.' });
    onDone();
  };

  return (
    <Card title="Analysis">
      <div data-testid="run-analysis">
        {result && <Notice tone={result.tone}><span data-testid="run-analysis-result">{result.text}</span></Notice>}
        {canRunAnalysis(workflowState) && !running && !confirming && (
          <Button block onClick={() => setConfirming(true)}>Run analysis</Button>
        )}
        {confirming && (
          <ConfirmBox title="Run one analysis of this case?"
            body={<p className="muted small">The conversation is sent to the configured AI model for one analysis and one independent review. On staging the AI provider is normally the free fake; a paid provider is enabled only for a founder-approved run, and each analysis is capped at USD 1. Nothing is sent to the prospect.</p>}
            confirmLabel="Run analysis" onConfirm={() => void run()} onCancel={() => setConfirming(false)} />
        )}
        {running && <p className="muted" role="status" data-testid="analysis-running">Analysing… this can take up to two minutes. Keep this page open.</p>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- founder: the decision

interface DecisionData { latest: AnalysisRow | null; state: AnalysisState; restrictions: RestrictionRow[] }

/** Approve, edit or mark RED (founder_approve), or request a re-analysis. Only while the case awaits review. */
export function FounderDecision({ caseId, evidenceVersion, onDone }: { caseId: string; evidenceVersion: number; onDone: () => void }) {
  const { supabase } = useAuth();
  const [data, setData] = useState<DecisionData | null>(null);
  const [form, setForm] = useState<Decision | null>(null);
  const [errors, setErrors] = useState<DecisionErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const [a, r] = await Promise.all([
        supabase.from('analyses').select('id, version, status, evidence_version, evidence_manifest, output, ai_classification, ai_proposed_message, error, model, prompt_version, created_at, completed_at')
          .eq('case_id', caseId).order('version', { ascending: false }),
        supabase.from('contact_restrictions').select('id, kind, source, status, note, created_at').eq('case_id', caseId),
      ]);
      if (!active) return;
      if (a.error || r.error) { setError('Could not load the analysis for a decision.'); return; }
      const rows = (a.data ?? []) as AnalysisRow[];
      const restrictions = (r.data ?? []) as RestrictionRow[];
      const { state, latest } = analysisState(rows, evidenceVersion);
      setData({ latest, state, restrictions });
      const restricted = restrictions.some((x) => x.status === 'ACTIVE');
      const output = latest ? parseAnalysisOutput(latest.output) : null;
      const proposal = proposedMessage(state, latest, output, restrictions).text;
      const ai = (latest?.ai_classification ?? null) as Classification | null;
      const cls: Classification = restricted || !proposal ? 'RED' : ai ?? 'YELLOW';
      setForm({ classification: cls, message: cls === 'RED' ? '' : proposal ?? '', deal: CLIENT_TEXT_DEFAULTS[cls].deal, next: CLIENT_TEXT_DEFAULTS[cls].next });
    })();
    return () => { active = false; };
  }, [supabase, caseId, evidenceVersion]);

  if (error) return <ErrorBanner message={error} />;
  if (!data || !form) return null;
  const decidable = data.latest && (data.state === 'READY' || data.state === 'INSUFFICIENT');
  const restricted = data.restrictions.some((x) => x.status === 'ACTIVE');

  const setCls = (c: Classification) => setForm((f) => f && ({ ...f, classification: c, deal: CLIENT_TEXT_DEFAULTS[c].deal, next: CLIENT_TEXT_DEFAULTS[c].next,
    message: c === 'RED' ? '' : f.message || (data.latest?.ai_proposed_message ?? '') }));

  const review = () => {
    const e = validateDecision(form, restricted);
    setErrors(e);
    if (Object.keys(e).length === 0) setConfirming(true);
  };

  const approve = async () => {
    if (!data.latest || !form.classification) return;
    setBusy(true);
    setError(null);
    const message = form.classification === 'RED' ? null : form.message.trim();
    const { error: err } = await supabase.rpc('founder_approve', {
      p_case_id: caseId, p_analysis_id: data.latest.id, p_expected_evidence_version: evidenceVersion,
      p_classification: form.classification, p_deal_situation: form.deal.trim(), p_next_action: form.next.trim(), p_approved_message: message,
      p_approval_type: approvalType(form.classification, message, data.latest.ai_classification, data.latest.ai_proposed_message),
    });
    setBusy(false);
    setConfirming(false);
    if (err) setError(actionErrorMessage(err));
    else onDone();
  };

  const reanalyse = async () => {
    setBusy(true);
    const { error: err } = await supabase.rpc('founder_request_reanalysis', { p_case_id: caseId });
    setBusy(false);
    if (err) setError(actionErrorMessage(err));
    else onDone();
  };

  return (
    <Card title="Your decision">
      <div data-testid="founder-decision">
        <ErrorBanner message={error} />
        {!decidable ? (
          <>
            <p className="muted">There is no current analysis to decide on. Request a re-analysis to analyse the latest evidence.</p>
            <Button variant="secondary" block disabled={busy} onClick={() => void reanalyse()}>Request re-analysis</Button>
          </>
        ) : (
          <>
            <p className="muted small">Only what you approve here reaches the business: the classification, the two short texts and the message. Never the analysis.</p>
            <fieldset className="field">
              <legend className="field-label">Classification</legend>
              <div className="btn-row" role="radiogroup" aria-label="Classification">
                {(['GREEN', 'YELLOW', 'RED'] as Classification[]).map((c) => (
                  <label key={c} className="radio">
                    <input type="radio" name="classification" value={c} checked={form.classification === c} disabled={restricted && c !== 'RED'} onChange={() => setCls(c)} />
                    <ClassificationBadge value={c} />
                  </label>
                ))}
              </div>
              {errors.classification && <p className="field-err" role="alert">{errors.classification}</p>}
              {restricted && <Notice tone="warn">Contact is restricted: only RED is possible.</Notice>}
            </fieldset>
            {form.classification !== 'RED' && (
              <Field label="Message the business will send" hint={`Edit freely. At most ${DECISION_LIMITS.message} characters.`} error={errors.message}>
                {(id, d) => <textarea id={id} aria-describedby={d} rows={6} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />}
              </Field>
            )}
            <Field label="Situation (shown to the business)" error={errors.deal}>
              {(id, d) => <textarea id={id} aria-describedby={d} rows={2} value={form.deal} onChange={(e) => setForm({ ...form, deal: e.target.value })} />}
            </Field>
            <Field label="Next step (shown to the business)" error={errors.next}>
              {(id, d) => <textarea id={id} aria-describedby={d} rows={2} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />}
            </Field>
            {!confirming && (
              <div className="btn-row">
                <Button disabled={busy} onClick={review}>{form.classification === 'RED' ? 'Mark RED' : 'Approve'}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => void reanalyse()}>Request re-analysis</Button>
              </div>
            )}
            {confirming && form.classification && (
              <ConfirmBox title="Release this to the business?" confirmLabel={busy ? 'Releasing…' : 'Release'} onConfirm={() => void approve()} onCancel={() => setConfirming(false)}
                body={(
                  <div data-testid="decision-preview">
                    <p className="muted small">The business will see exactly this:</p>
                    <ClassificationBadge value={form.classification} />
                    <p><strong>Situation:</strong> {form.deal.trim()}</p>
                    <p><strong>Next step:</strong> {form.next.trim()}</p>
                    {form.classification !== 'RED' && <pre className="message-card">{form.message.trim()}</pre>}
                  </div>
                )} />
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- founder: what happened after release

interface TimelineData {
  messages: { kind: string; body: string; attempt: number | null; sent_exactly: boolean | null; created_at: string }[];
  released: { classification: Classification; approved_message: string | null; published_at: string } | null;
  outcome: { state: string; deal_value: number | null; amount_paid: number | null; payment_date: string | null; note: string | null; recorded_by_role: string; created_at: string } | null;
}

/** The released recommendation, what the business sent, the prospect's replies and the outcome (founder-only tables). */
export function FounderCaseTimeline({ caseId, currency }: { caseId: string; currency: string }) {
  const { supabase } = useAuth();
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [m, r, o] = await Promise.all([
        supabase.from('case_messages').select('kind, body, attempt, sent_exactly, created_at').eq('case_id', caseId).neq('kind', 'PASTED_CONVERSATION').order('created_at'),
        supabase.from('client_recommendations').select('classification, approved_message, published_at').eq('case_id', caseId).maybeSingle(),
        supabase.from('outcomes').select('state, deal_value, amount_paid, payment_date, note, recorded_by_role, created_at').eq('case_id', caseId).maybeSingle(),
      ]);
      if (!active) return;
      if (m.error || r.error || o.error) { setError('Could not load the case history.'); return; }
      setData({ messages: (m.data ?? []) as TimelineData['messages'], released: (r.data ?? null) as TimelineData['released'], outcome: (o.data ?? null) as TimelineData['outcome'] });
    })();
    return () => { active = false; };
  }, [supabase, caseId]);

  if (error) return <ErrorBanner message={error} />;
  if (!data || (!data.released && data.messages.length === 0 && !data.outcome)) return null;
  return (
    <Card title="After your decision">
      <div data-testid="founder-timeline">
        {data.released && (
          <div data-testid="released">
            <p className="muted small">Released to the business {formatDate(data.released.published_at, true)}</p>
            <ClassificationBadge value={data.released.classification} />
            {data.released.approved_message && <pre className="message-card">{data.released.approved_message}</pre>}
          </div>
        )}
        {data.messages.map((x, i) => (
          <div key={i} data-testid={x.kind === 'RECOVERY_SENT' ? 'timeline-sent' : 'timeline-reply'}>
            <p className="muted small">
              {x.kind === 'RECOVERY_SENT' ? `Business sent the message (attempt ${x.attempt ?? '?'}${x.sent_exactly === false ? ', with changes' : ''})` : 'Prospect replied'} · {formatDate(x.created_at, true)}
            </p>
            <pre className={`message-card ${x.kind === 'PROSPECT_RESPONSE' ? 'prospect' : ''}`}>{x.body}</pre>
          </div>
        ))}
        {data.outcome && (
          <p data-testid="timeline-outcome">
            <strong>Outcome: {data.outcome.state}</strong> (reported by {data.outcome.recorded_by_role === 'CLIENT' ? 'the business' : 'you'}, {formatDate(data.outcome.created_at)})
            {data.outcome.state === 'WON' && ` · paid ${formatMoney(Number(data.outcome.amount_paid), currency)} on ${formatDate(data.outcome.payment_date)}`}
            {data.outcome.note ? ` · ${data.outcome.note}` : ''}
          </p>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- business: one case

interface ClientCase {
  id: string; reference: string; product_service: string; status: string;
  classification: Classification | null; deal_situation: string | null; next_action: string | null; approved_message: string | null;
  recovery_attempts: number; last_sent_message: string | null; responses_added: number;
  won_amount_paid: number | null; won_payment_date: string | null; closed_at: string | null;
  history: { at: string; label: string }[];
}

/** The business's view of one case: only the client-safe projection (client_get_case). */
export function ClientCasePage({ caseId }: { caseId: string }) {
  const { supabase, profile } = useAuth();
  const [row, setRow] = useState<ClientCase | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<null | 'sent' | 'reply' | 'outcome' | 'optout'>(null);
  const [changed, setChanged] = useState(false);
  const [actualText, setActualText] = useState('');
  const [reply, setReply] = useState('');
  const [optNote, setOptNote] = useState('');
  const [outcome, setOutcome] = useState<OutcomeInput>({ state: '', dealValue: '', amountPaid: '', paymentDate: '', note: '' });
  const [outcomeErrors, setOutcomeErrors] = useState<OutcomeErrors>({});

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('client_get_case', { p_case_id: caseId });
    if (err) { setRow(/^NOT_FOUND/.test(err.message ?? '') ? null : undefined); setError(/^NOT_FOUND/.test(err.message ?? '') ? null : actionErrorMessage(err)); return; }
    setRow(data as ClientCase);
  }, [supabase, caseId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc(fn, { p_case_id: caseId, ...args });
    setBusy(false);
    if (err) { setError(actionErrorMessage(err)); return; }
    setPanel(null);
    setNotice(done);
    await load();
  };

  const saveOutcome = () => {
    const e = validateOutcome(outcome, today());
    setOutcomeErrors(e);
    if (Object.keys(e).length) return;
    const num = (s: string) => (s.trim() ? Number(s.replace(/,/g, '')) : null);
    void act('client_record_outcome', {
      p_state: outcome.state, p_deal_value: outcome.state === 'WON' ? num(outcome.dealValue) : null, p_amount_paid: outcome.state === 'WON' ? num(outcome.amountPaid) : null,
      p_payment_date: outcome.state === 'WON' ? outcome.paymentDate : null, p_note: outcome.note.trim() || null,
    }, 'Outcome recorded. Thank you.');
  };

  const back = () => navigate('/app/client');
  const currency = profile?.currency ?? 'NGN';
  const terminal = row && ['WON', 'LOST', 'PAUSED', 'DISQUALIFIED'].includes(row.status);

  return (
    <>
      <ScreenHeader title={row ? `${row.reference} — ${row.product_service}` : 'Case'} subtitle={row ? clientStatusLabel(row.status) : undefined} onBack={back} backLabel="Your cases" />
      <ErrorBanner message={error} />
      {notice && <Notice><span data-testid="client-notice">{notice}</span></Notice>}
      {row === undefined && !error && <p className="muted" role="status">Loading…</p>}
      {row === null && <EmptyState title="Case not found." />}
      {row && (
        <div data-testid="client-case">
          {row.status === 'UNDER_REVIEW' && <Card><p>We are reviewing this conversation. You will see a recommendation here when it is ready.</p></Card>}

          {row.status === 'ACTION_REQUIRED' && row.classification && (
            <Card title="Our recommendation">
              <div data-testid="client-recommendation">
                <ClassificationBadge value={row.classification} />
                <p><strong>Situation:</strong> {row.deal_situation}</p>
                <p><strong>Next step:</strong> {row.next_action}</p>
                {row.approved_message && (
                  <>
                    <pre className="message-card" data-testid="approved-message">{row.approved_message}</pre>
                    <CopyButton text={row.approved_message} />
                    <a className="btn btn-secondary btn-block" href={whatsappLink(row.approved_message)} target="_blank" rel="noopener noreferrer">Open in WhatsApp</a>
                    <p className="muted small">You choose the chat and press send yourself. We never message your customers.</p>
                    {panel !== 'sent' && <Button block onClick={() => setPanel('sent')}>I sent it</Button>}
                    {panel === 'sent' && (
                      <ConfirmBox title="Did you send this message to the prospect?" confirmLabel={busy ? 'Saving…' : 'Yes, I sent it'} onCancel={() => setPanel(null)}
                        onConfirm={() => void act('client_record_sent', { p_actual_text: changed && actualText.trim() ? actualText : null }, 'Recorded as sent. Add the prospect’s reply here when they answer.')}
                        body={(
                          <>
                            <label className="radio"><input type="checkbox" checked={changed} onChange={(e) => setChanged(e.target.checked)} /> I changed the wording</label>
                            {changed && (
                              <Field label="Paste exactly what you sent">
                                {(id) => <textarea id={id} rows={4} value={actualText} onChange={(e) => setActualText(e.target.value)} />}
                              </Field>
                            )}
                          </>
                        )} />
                    )}
                  </>
                )}
              </div>
            </Card>
          )}

          {row.status === 'WAITING' && (
            <Card title="Waiting for the prospect">
              <p className="muted small">Message sent {row.recovery_attempts} time{row.recovery_attempts === 1 ? '' : 's'}.</p>
              {row.last_sent_message && <pre className="message-card faded">{row.last_sent_message}</pre>}
              {panel !== 'reply' && <Button block onClick={() => setPanel('reply')}>The prospect replied</Button>}
              {panel === 'reply' && (
                <>
                  <Field label="Paste the prospect’s reply" hint="Only the prospect’s words. We review it and update the recommendation.">
                    {(id, d) => <textarea id={id} aria-describedby={d} rows={5} value={reply} onChange={(e) => setReply(e.target.value)} />}
                  </Field>
                  <div className="btn-row">
                    <Button disabled={busy || !reply.trim()} onClick={() => void act('client_add_response', { p_text: reply }, 'Reply added. We will review it.')}>Add reply</Button>
                    <Button variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
                  </div>
                </>
              )}
            </Card>
          )}

          {(row.status === 'ACTION_REQUIRED' || row.status === 'WAITING') && (
            <Card title="Close this case">
              {panel !== 'outcome' && <Button variant="secondary" block onClick={() => setPanel('outcome')}>Record the outcome</Button>}
              {panel === 'outcome' && (
                <div data-testid="outcome-form">
                  <Field label="What happened?" error={outcomeErrors.state}>
                    {(id, d) => (
                      <select id={id} aria-describedby={d} value={outcome.state} onChange={(e) => setOutcome({ ...outcome, state: e.target.value as OutcomeState })}>
                        <option value="">Choose…</option>
                        {OUTCOME_STATES.map((s) => <option key={s} value={s}>{OUTCOME_LABELS[s]}</option>)}
                      </select>
                    )}
                  </Field>
                  {outcome.state === 'WON' && (
                    <>
                      <Field label={`Amount paid (${currency})`} error={outcomeErrors.amountPaid}>
                        {(id, d) => <input id={id} aria-describedby={d} inputMode="decimal" value={outcome.amountPaid} onChange={(e) => setOutcome({ ...outcome, amountPaid: e.target.value })} />}
                      </Field>
                      <Field label="Payment date" error={outcomeErrors.paymentDate}>
                        {(id, d) => <input id={id} aria-describedby={d} type="date" max={today()} value={outcome.paymentDate} onChange={(e) => setOutcome({ ...outcome, paymentDate: e.target.value })} />}
                      </Field>
                      <Field label={`Total deal value (${currency})`} optional error={outcomeErrors.dealValue}>
                        {(id, d) => <input id={id} aria-describedby={d} inputMode="decimal" value={outcome.dealValue} onChange={(e) => setOutcome({ ...outcome, dealValue: e.target.value })} />}
                      </Field>
                    </>
                  )}
                  <Field label="Note" optional error={outcomeErrors.note}>
                    {(id, d) => <textarea id={id} aria-describedby={d} rows={2} value={outcome.note} onChange={(e) => setOutcome({ ...outcome, note: e.target.value })} />}
                  </Field>
                  <div className="btn-row">
                    <Button disabled={busy} onClick={saveOutcome}>Save outcome</Button>
                    <Button variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {!terminal && row.status !== 'DRAFT' && (
            <Card>
              {panel !== 'optout' && <Button variant="ghost" block onClick={() => setPanel('optout')}>The prospect asked not to be contacted</Button>}
              {panel === 'optout' && (
                <ConfirmBox danger title="Record that the prospect asked not to be contacted?" confirmLabel={busy ? 'Saving…' : 'Record'} onCancel={() => setPanel(null)}
                  onConfirm={() => void act('client_report_opt_out', { p_note: optNote.trim() || null }, 'Recorded. No further messages will be recommended for this prospect.')}
                  body={<Field label="What did they say?" optional>{(id) => <textarea id={id} rows={2} value={optNote} onChange={(e) => setOptNote(e.target.value)} />}</Field>} />
              )}
            </Card>
          )}

          {terminal && (
            <Card title="Closed">
              <p data-testid="client-outcome">{clientStatusLabel(row.status)}{row.status === 'WON' && row.won_amount_paid ? ` · paid ${formatMoney(Number(row.won_amount_paid), currency)} on ${formatDate(row.won_payment_date)}` : ''}</p>
            </Card>
          )}

          {row.history.length > 0 && (
            <Card title="History">
              <ul className="list" data-testid="client-history">
                {row.history.map((h, i) => <li key={i} className="list-row"><span>{h.label}</span><span className="muted small">{formatDate(h.at, true)}</span></li>)}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
