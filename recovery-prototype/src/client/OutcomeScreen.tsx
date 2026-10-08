// C12 — record a deal outcome. WON requires explicit confirmation of the payment event.

import { useState } from 'react';
import { Button, ConfirmBox, EmptyState, ErrorBanner, Field, ScreenHeader } from '../components/ui';
import { recordOutcome } from '../domain/transitions';
import type { TerminalState } from '../domain/types';
import { navigate } from '../router';
import { useClientCase, useStore } from '../state/store';
import { CaseIdentity } from './common';

const OTHER: { state: Exclude<TerminalState, 'WON'>; label: string; question: string }[] = [
  { state: 'LOST', label: 'Mark Lost', question: 'Close this case as lost? This ends the recovery workflow.' },
  { state: 'PAUSED', label: 'Pause Case', question: 'Pause this case? No further recommendations will be prepared.' },
  { state: 'DISQUALIFIED', label: 'Mark Disqualified', question: 'Mark this prospect as disqualified? This ends the recovery workflow.' },
];

export function OutcomeScreen({ id }: { id: string }) {
  const { apply } = useStore();
  const { view, currency } = useClientCase(id);
  const [mode, setMode] = useState<'choose' | 'won' | Exclude<TerminalState, 'WON'>>('choose');
  const [completed, setCompleted] = useState<'yes' | 'no' | ''>('');
  const [dealValue, setDealValue] = useState('');
  const [amountPaid, setAmountPaid] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const back = () => navigate({ name: 'client-case', id });

  if (!view || (view.status !== 'ACTION_REQUIRED' && view.status !== 'WAITING')) {
    return (
      <div className="screen narrow">
        <ScreenHeader title="Can’t record an outcome" onBack={back} backLabel="Case" />
        <EmptyState title="Outcomes can be recorded once a recommendation has been approved and the case is not under review." />
      </div>
    );
  }

  const finish = (state: TerminalState, extras: Parameters<typeof recordOutcome>[4]) => {
    const err = apply((d) => recordOutcome(d, id, state, 'CLIENT', extras));
    if (err) setError(err);
    else navigate({ name: 'client-case', id }, { replace: true });
  };

  const confirmWon = () => {
    const e: Record<string, string> = {};
    const dv = Number(dealValue.replace(/,/g, ''));
    const ap = Number(amountPaid.replace(/,/g, ''));
    if (!(dv > 0)) e.dealValue = 'Enter the deal value.';
    if (!(ap > 0)) e.amountPaid = 'Enter the amount actually paid.';
    if (!paymentDate) e.paymentDate = 'Enter the payment date.';
    setErrors(e);
    if (Object.keys(e).length) return;
    finish('WON', { won: { dealValue: dv, amountPaid: ap, paymentDate, notes: notes.trim() || undefined } });
  };

  return (
    <div className="screen narrow">
      <ScreenHeader title="Record Outcome" subtitle={<CaseIdentity view={view} />} onBack={mode === 'choose' ? back : () => setMode('choose')} backLabel={mode === 'choose' ? 'Case' : 'Outcome options'} />
      <ErrorBanner message={error} />

      {mode === 'choose' && (
        <section className="card">
          <div className="stack-sm">
            <Button block onClick={() => setMode('won')}>Mark Deal Won</Button>
            {OTHER.map((o) => (
              <Button key={o.state} block variant="secondary" onClick={() => setMode(o.state)}>{o.label}</Button>
            ))}
          </div>
        </section>
      )}

      {mode === 'won' && (
        <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); confirmWon(); }}>
          <fieldset className="question">
            <legend className="strong">Has this prospect actually completed the agreed purchase, registration, or payment event?</legend>
            <label className="radio"><input type="radio" name="completed" checked={completed === 'yes'} onChange={() => setCompleted('yes')} /> Yes, it is completed</label>
            <label className="radio"><input type="radio" name="completed" checked={completed === 'no'} onChange={() => setCompleted('no')} /> No, not yet</label>
          </fieldset>
          {completed === 'no' && <p className="banner banner-warn">Only mark a deal won once the purchase, registration or payment has actually happened.</p>}
          {completed === 'yes' && (
            <>
              <Field label={`Deal Value (${currency})`} error={errors.dealValue}>
                {(fid, d) => <input id={fid} aria-describedby={d} inputMode="decimal" value={dealValue} onChange={(e) => setDealValue(e.target.value)} />}
              </Field>
              <Field label={`Amount Paid (${currency})`} error={errors.amountPaid}>
                {(fid, d) => <input id={fid} aria-describedby={d} inputMode="decimal" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />}
              </Field>
              <Field label="Payment Date" error={errors.paymentDate}>
                {(fid, d) => <input id={fid} aria-describedby={d} type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />}
              </Field>
              <Field label="Notes" optional>
                {(fid) => <textarea id={fid} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
              </Field>
              <Button type="submit" block>Confirm Won</Button>
            </>
          )}
        </form>
      )}

      {OTHER.map((o) =>
        mode === o.state ? (
          <section key={o.state} className="card">
            <ConfirmBox
              title={o.question}
              body={
                <Field label="Note" optional>
                  {(fid) => <textarea id={fid} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
                </Field>
              }
              confirmLabel={o.label}
              danger={o.state !== 'PAUSED'}
              onConfirm={() => finish(o.state, { note: notes })}
              onCancel={() => setMode('choose')}
            />
          </section>
        ) : null,
      )}
    </div>
  );
}
