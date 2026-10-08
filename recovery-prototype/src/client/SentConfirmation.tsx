// C09 — sent-message integrity check.

import { useState } from 'react';
import { Button, EmptyState, ErrorBanner, Field, ScreenHeader } from '../components/ui';
import { recordSent } from '../domain/transitions';
import { navigate } from '../router';
import { useClientCase, useStore } from '../state/store';
import { CaseIdentity } from './common';

export function SentConfirmationScreen({ id }: { id: string }) {
  const { apply } = useStore();
  const { view } = useClientCase(id);
  const [mode, setMode] = useState<'ask' | 'changed'>('ask');
  const [actual, setActual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const back = () => navigate({ name: 'client-case', id });

  if (!view || view.status !== 'ACTION_REQUIRED' || !view.approvedMessage) {
    return (
      <div className="screen narrow">
        <ScreenHeader title="Nothing to confirm" onBack={back} backLabel="Case" />
        <EmptyState title="There is no approved message waiting to be sent for this case." />
      </div>
    );
  }

  const confirm = (message: string | null) => {
    const err = apply((d) => recordSent(d, id, message));
    if (err) setError(err);
    else navigate({ name: 'client-case', id }, { replace: true });
  };

  return (
    <div className="screen narrow">
      <ScreenHeader title={<CaseIdentity view={view} />} onBack={back} backLabel="Case" />
      <section className="card">
        <h1 className="card-title">Did you send the message exactly as shown?</h1>
        <blockquote className="message-card">{view.approvedMessage}</blockquote>
        {mode === 'ask' ? (
          <div className="stack-sm">
            <Button block onClick={() => confirm(null)}>Yes, Exactly</Button>
            <Button block variant="secondary" onClick={() => setMode('changed')}>I Changed It</Button>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (!actual.trim()) { setError('Paste the exact message you sent.'); return; } confirm(actual); }} noValidate>
            <Field label="Paste the exact message you sent." error={error}>
              {(fid, d) => <textarea id={fid} aria-describedby={d} rows={7} value={actual} onChange={(e) => { setActual(e.target.value); setError(null); }} />}
            </Field>
            <div className="stack-sm">
              <Button type="submit" block disabled={!actual.trim()}>Confirm Sent</Button>
              <Button block variant="ghost" onClick={() => { setMode('ask'); setError(null); }}>Cancel</Button>
            </div>
          </form>
        )}
        {mode === 'ask' && <ErrorBanner message={error} />}
      </section>
    </div>
  );
}
