// Section 5 — admin decision. The client sees only what is approved here.

import { useState } from 'react';
import { Button, Card, ClassificationBadge, ConfirmBox, ErrorBanner, Field, Notice } from '../components/ui';
import { CLASSIFICATION_LABEL } from '../domain/labels';
import { adminApprove, adminRequestReanalysis, recordOutcome, type ApprovalInput } from '../domain/transitions';
import type { Classification, RecoveryCase } from '../domain/types';
import { useStore } from '../state/store';

/** Standard client-facing wording per classification (from the Stage-1 spec). */
export const CLIENT_COPY: Record<Classification, { situation: string; next: string }> = {
  GREEN: {
    situation: 'This prospect previously showed meaningful buying interest and another conversation is justified.',
    next: 'Send the approved message below.',
  },
  YELLOW: {
    situation: "There isn't enough information yet to determine whether this opportunity is still active.",
    next: "Send this short message to clarify the prospect's current position.",
  },
  RED: {
    situation: 'This prospect is not currently recommended for further recovery attempts.',
    next: 'No further contact is recommended.',
  },
};

const STANDARD_SITUATIONS = Object.values(CLIENT_COPY).map((c) => c.situation);
const STANDARD_NEXT = Object.values(CLIENT_COPY).map((c) => c.next);

type Pending = null | 'red' | 'pause';

export function AdminDecision({ c, onDone }: { c: RecoveryCase; onDone: (msg: string) => void }) {
  const { apply } = useStore();
  const a = c.analysis!;
  const [classification, setClassification] = useState<Classification>(a.classification);
  const [situation, setSituation] = useState(a.proposedDealSituation);
  const [nextAction, setNextAction] = useState(a.proposedNextAction);
  const [message, setMessage] = useState(a.mockAiProposedMessage ?? '');
  const [notes, setNotes] = useState(c.adminNotes);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);

  const isRed = classification === 'RED';
  const messageEdited = !isRed && message.trim() !== (a.mockAiProposedMessage ?? '').trim();
  const edited =
    classification !== a.classification ||
    situation.trim() !== a.proposedDealSituation.trim() ||
    nextAction.trim() !== a.proposedNextAction.trim() ||
    messageEdited;
  const canApproveUnchanged = !edited && (a.classification === 'RED' || !!a.mockAiProposedMessage);

  const changeClassification = (next: Classification) => {
    // Swap in standard wording only where the admin hasn't written their own.
    if (situation === a.proposedDealSituation || STANDARD_SITUATIONS.includes(situation)) setSituation(CLIENT_COPY[next].situation);
    if (nextAction === a.proposedNextAction || STANDARD_NEXT.includes(nextAction)) setNextAction(CLIENT_COPY[next].next);
    setClassification(next);
    setError(null);
  };

  const approve = (input: ApprovalInput, doneMsg: string) => {
    const err = apply((d) => adminApprove(d, c.id, input));
    if (err) setError(err);
    else onDone(doneMsg);
  };

  const approveUnchanged = () =>
    approve(
      { approvalType: 'UNCHANGED', classification: a.classification, dealSituation: a.proposedDealSituation, nextAction: a.proposedNextAction, approvedMessage: a.mockAiProposedMessage, adminNotes: notes },
      'Approved unchanged. The client now sees the recommendation.',
    );

  const editAndApprove = () => {
    if (!situation.trim() || !nextAction.trim()) return setError('Client Deal Situation and Next Action are required.');
    if (!isRed && !message.trim()) return setError('Write the approved message, or select RED if no message should be sent.');
    approve(
      { approvalType: 'EDITED', classification, dealSituation: situation, nextAction, approvedMessage: isRed ? null : message, adminNotes: notes },
      'Edited recommendation approved. The client sees your version only.',
    );
  };

  const markRed = () =>
    approve(
      {
        approvalType: 'MARKED_RED',
        classification: 'RED',
        dealSituation: isRed ? situation : CLIENT_COPY.RED.situation,
        nextAction: isRed ? nextAction : CLIENT_COPY.RED.next,
        approvedMessage: null,
        adminNotes: notes,
      },
      'Marked RED. The client is told not to follow up; no message is provided.',
    );

  const reanalyse = () => {
    const err = apply((d) => adminRequestReanalysis(d, c.id));
    if (err) setError(err);
    else onDone('Reanalysis requested. Run the mock analysis to continue.');
  };

  const pause = () => {
    const err = apply((d) => recordOutcome(d, c.id, 'PAUSED', 'ADMIN', { note: notes }));
    if (err) setError(err);
    else onDone('Case paused.');
  };

  return (
    <Card title="Admin Decision">
      <fieldset className="classify">
        <legend className="field-label">Classification</legend>
        <div className="classify-options">
          {(['GREEN', 'YELLOW', 'RED'] as Classification[]).map((k) => (
            <label key={k} className={`classify-opt opt-${k.toLowerCase()} ${classification === k ? 'on' : ''}`}>
              <input type="radio" name={`cls-${c.id}`} value={k} checked={classification === k} onChange={() => changeClassification(k)} />
              <ClassificationBadge value={k} showLabel={false} />
              <span className="classify-text">{CLASSIFICATION_LABEL[k]}</span>
              {k === a.classification && <span className="muted small">mock AI</span>}
            </label>
          ))}
        </div>
      </fieldset>

      <Field label="Client Deal Situation" hint="Client-visible. Keep it short and free of private analysis.">
        {(id, d) => <textarea id={id} aria-describedby={d} rows={3} value={situation} onChange={(e) => setSituation(e.target.value)} />}
      </Field>
      <Field label="Next Action" hint="Client-visible.">
        {(id, d) => <textarea id={id} aria-describedby={d} rows={2} value={nextAction} onChange={(e) => setNextAction(e.target.value)} />}
      </Field>

      {isRed ? (
        <Notice tone="info">RED selected: the client will not receive a recovery message and will not see “I Sent It”.</Notice>
      ) : (
        <Field label="Approved Message" hint="Client-visible. This exact text is what the client copies and sends.">
          {(id, d) => <textarea id={id} aria-describedby={d} rows={6} value={message} onChange={(e) => setMessage(e.target.value)} />}
        </Field>
      )}
      {messageEdited && a.mockAiProposedMessage && (
        <p className="muted small">Edited. The client will receive your version only; the original mock AI message is kept privately for comparison.</p>
      )}

      <Field label="Admin Notes" hint="Private. Never shown to the client.">
        {(id, d) => <textarea id={id} aria-describedby={d} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>

      <ErrorBanner message={error} />

      {pending === 'red' && (
        <ConfirmBox title="Mark this case RED?" body="The client will be told not to follow up. No recovery message will be provided." confirmLabel="Mark Red" danger onConfirm={markRed} onCancel={() => setPending(null)} />
      )}
      {pending === 'pause' && (
        <ConfirmBox title="Pause this case?" body="It leaves the review queue and the client sees PAUSED." confirmLabel="Pause Case" onConfirm={pause} onCancel={() => setPending(null)} />
      )}

      {pending === null && (
        <div className="decision-actions">
          <Button block onClick={approveUnchanged} disabled={!canApproveUnchanged}>Approve Unchanged</Button>
          {!canApproveUnchanged && !edited && <p className="muted small">The mock analysis proposed no message. Write one and use Edit & Approve.</p>}
          <Button block variant="secondary" onClick={editAndApprove} disabled={!edited}>Edit & Approve</Button>
          <div className="btn-grid">
            <Button variant="secondary" onClick={reanalyse}>Request Reanalysis</Button>
            <Button variant="danger" onClick={() => setPending('red')}>Mark Red</Button>
            <Button variant="ghost" onClick={() => setPending('pause')}>Pause Case</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
