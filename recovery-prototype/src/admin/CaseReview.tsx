// A03 — full case review (admin only).

import { useState } from 'react';
import { Button, Card, ClassificationBadge, ConfirmBox, EmptyState, ErrorBanner, Field, Notice, ScreenHeader, StatusPill, formatDate, formatMoney } from '../components/ui';
import { NEEDS_ANALYSIS_STATES, WORKFLOW_LABEL, isTerminal } from '../domain/labels';
import { adminRunMockAnalysis, adminSaveNotes, recordOutcome } from '../domain/transitions';
import type { RecoveryCase } from '../domain/types';
import { navigate } from '../router';
import { useStore } from '../state/store';
import { AdminDecision } from './AdminDecision';
import { clientName } from './ControlRoom';
import { ConversationView } from './ConversationView';
import { ForensicAnalysisView, StrategyView } from './ForensicAnalysisView';

export function CaseReviewScreen({ id }: { id: string }) {
  const { data, apply } = useStore();
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = data.cases.find((x) => x.id === id);
  const back = () => navigate({ name: 'admin-home' });

  if (!c) {
    return (
      <div className="screen wide">
        <ScreenHeader title="Case not found" onBack={back} backLabel="Control Room" />
        <EmptyState title="This case doesn’t exist. Demo data may have been reset." />
      </div>
    );
  }

  const client = data.clients.find((cl) => cl.id === c.clientId);
  const currency = client?.currency ?? 'NGN';
  const needsAnalysis = NEEDS_ANALYSIS_STATES.includes(c.workflowState);

  return (
    <div className="screen wide">
      <ScreenHeader
        title={`${c.reference} — ${c.productService}`}
        subtitle={clientName(data, c.clientId)}
        onBack={back}
        backLabel="Control Room"
      />
      {flash && <Notice tone="info">{flash}</Notice>}
      <ErrorBanner message={error} />

      <Card title="Case">
        <dl className="kv">
          <div><dt>Client</dt><dd>{clientName(data, c.clientId)}</dd></div>
          <div><dt>Case Reference</dt><dd>{c.reference}</dd></div>
          <div><dt>Product / Service</dt><dd>{c.productService}</dd></div>
          <div><dt>Lead Source</dt><dd>{c.leadSource}</dd></div>
          <div><dt>Estimated Deal Value</dt><dd>{formatMoney(c.estimatedDealValue, currency)}</dd></div>
          <div><dt>Last Interaction</dt><dd>{formatDate(c.lastInteractionDate)}</dd></div>
          <div><dt>Workflow State</dt><dd><StatusPill tone="neutral">{WORKFLOW_LABEL[c.workflowState]}</StatusPill></dd></div>
          <div><dt>Recovery Attempt Count</dt><dd>{c.sentRecords.length}</dd></div>
        </dl>
        {c.clientContext && (
          <div className="client-context">
            <p className="field-label">Client note</p>
            <p>{c.clientContext}</p>
          </div>
        )}
      </Card>

      <Card title="Complete Conversation" aside={<span className="muted small">{c.conversation.length} messages</span>}>
        <ConversationView messages={c.conversation} />
      </Card>

      {(c.approvals.length > 0 || c.sentRecords.length > 0) && <RecoveryHistory c={c} />}

      {needsAnalysis ? (
        <Card title="Private Forensic Analysis" tone="private" aside={<span className="private-tag">Admin only · Mock</span>}>
          <p>
            {c.workflowState === 'PROSPECT_REPLIED'
              ? 'A new prospect response has arrived. The mock analysis has not been rerun yet.'
              : c.workflowState === 'REANALYZING'
                ? 'Reanalysis was requested.'
                : 'This case has not been analyzed yet.'}
          </p>
          <p className="muted small">Stage 1 has no AI. This button simulates analysis with local mock logic.</p>
          <Button
            block
            onClick={() => {
              const err = apply((d) => adminRunMockAnalysis(d, c.id));
              setError(err);
              setFlash(err ? null : 'Mock analysis generated.');
            }}
          >
            Run Mock Analysis
          </Button>
        </Card>
      ) : (
        c.analysis && (
          <>
            <ForensicAnalysisView a={c.analysis} history={c.analysisHistory} />
            <StrategyView a={c.analysis} />
          </>
        )
      )}

      {c.workflowState === 'AWAITING_ADMIN_REVIEW' && c.analysis && (
        <AdminDecision
          key={`${c.id}-v${c.analysis.version}`}
          c={c}
          onDone={(msg) => {
            setError(null);
            setFlash(msg);
            window.scrollTo(0, 0);
          }}
        />
      )}

      {c.workflowState !== 'AWAITING_ADMIN_REVIEW' && <NotesAndActions key={c.id + c.workflowState} c={c} currency={currency} onError={setError} onDone={setFlash} />}

      <Card title="Case Timeline">
        <ol className="timeline">
          {[...c.timeline].reverse().map((e) => (
            <li key={e.id}>
              <span className="timeline-label">{e.adminLabel}</span>
              <span className="timeline-date">{formatDate(e.at, true)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function RecoveryHistory({ c }: { c: RecoveryCase }) {
  return (
    <Card title="Recovery History" tone="private" aside={<span className="private-tag">Admin only</span>}>
      <ol className="attempts">
        {c.approvals.map((ap, i) => {
          const sent = c.sentRecords.find((s) => s.approvalId === ap.id);
          const response = sent ? c.responses.find((r) => r.afterAttempt === sent.attempt) : undefined;
          const disagreed = ap.classification !== ap.mockAiClassification || (ap.adminApprovedMessage ?? '') !== (ap.mockAiProposedMessage ?? '');
          return (
            <li key={ap.id} className="attempt">
              <p className="attempt-head">
                Approval {i + 1} · {formatDate(ap.approvedAt, true)} <ClassificationBadge value={ap.classification} showLabel={false} />
                {disagreed && <StatusPill tone="info">Admin changed mock AI</StatusPill>}
              </p>
              {ap.classification !== ap.mockAiClassification && <p className="small">Mock AI classification: {ap.mockAiClassification}</p>}
              {ap.mockAiProposedMessage && ap.mockAiProposedMessage !== ap.adminApprovedMessage && (
                <div className="cmp"><span className="cmp-label">Mock AI proposed</span><blockquote className="message-card faded">{ap.mockAiProposedMessage}</blockquote></div>
              )}
              {ap.adminApprovedMessage && (
                <div className="cmp"><span className="cmp-label">Admin approved</span><blockquote className="message-card">{ap.adminApprovedMessage}</blockquote></div>
              )}
              {sent ? (
                <div className="cmp">
                  <span className="cmp-label">
                    Actually sent (attempt {sent.attempt}) · {sent.sentExactly ? 'exactly as approved' : <strong className="warn-text">changed by client</strong>}
                  </span>
                  {!sent.sentExactly && <blockquote className="message-card">{sent.actualSentMessage}</blockquote>}
                </div>
              ) : (
                ap.adminApprovedMessage && <p className="muted small">Not yet marked as sent.</p>
              )}
              {response && (
                <div className="cmp"><span className="cmp-label">Prospect response</span><blockquote className="message-card prospect">{response.text}</blockquote></div>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function NotesAndActions({ c, currency, onError, onDone }: { c: RecoveryCase; currency: string; onError: (e: string | null) => void; onDone: (m: string) => void }) {
  const { apply } = useStore();
  const [notes, setNotes] = useState(c.adminNotes);
  const [confirmPause, setConfirmPause] = useState(false);
  const terminal = isTerminal(c.workflowState);
  return (
    <Card title={terminal ? 'Outcome & Notes' : 'Admin Notes'}>
      {c.outcome && (
        <dl className="kv">
          <div><dt>Outcome</dt><dd>{WORKFLOW_LABEL[c.outcome.state]} (by {c.outcome.recordedBy.toLowerCase()})</dd></div>
          <div><dt>Recorded</dt><dd>{formatDate(c.outcome.recordedAt, true)}</dd></div>
          {c.outcome.won && (
            <>
              <div><dt>Deal Value</dt><dd>{formatMoney(c.outcome.won.dealValue, currency)}</dd></div>
              <div><dt>Amount Paid</dt><dd>{formatMoney(c.outcome.won.amountPaid, currency)}</dd></div>
              <div><dt>Payment Date</dt><dd>{formatDate(c.outcome.won.paymentDate)}</dd></div>
              {c.outcome.won.notes && <div><dt>Notes</dt><dd>{c.outcome.won.notes}</dd></div>}
            </>
          )}
          {c.outcome.note && <div><dt>Note</dt><dd>{c.outcome.note}</dd></div>}
        </dl>
      )}
      {c.workflowState === 'CLIENT_ACTION_REQUIRED' && <p className="muted small">Approved recommendation is with the client.</p>}
      {c.workflowState === 'WAITING_FOR_PROSPECT' && <p className="muted small">Client sent the message; waiting for the prospect’s response.</p>}
      <Field label="Admin Notes" hint="Private. Never shown to the client.">
        {(id, d) => <textarea id={id} aria-describedby={d} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>
      <div className="btn-row">
        <Button variant="secondary" small onClick={() => { const err = apply((d) => adminSaveNotes(d, c.id, notes)); onError(err); if (!err) onDone('Notes saved.'); }}>Save Notes</Button>
        {!terminal && !confirmPause && <Button variant="ghost" small onClick={() => setConfirmPause(true)}>Pause Case</Button>}
      </div>
      {confirmPause && (
        <ConfirmBox
          title="Pause this case?"
          body="The client will see PAUSED."
          confirmLabel="Pause Case"
          onConfirm={() => { const err = apply((d) => recordOutcome(d, c.id, 'PAUSED', 'ADMIN', { note: notes })); onError(err); if (!err) onDone('Case paused.'); setConfirmPause(false); }}
          onCancel={() => setConfirmPause(false)}
        />
      )}
    </Card>
  );
}
