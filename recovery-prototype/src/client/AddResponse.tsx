// C11 — add prospect response. Returns the case to review; no analysis runs here.

import { useState } from 'react';
import { Button, EmptyState, Field, ScreenHeader } from '../components/ui';
import { addProspectResponse } from '../domain/transitions';
import { navigate } from '../router';
import { useClientCase, useStore } from '../state/store';
import { CaseIdentity } from './common';

export function AddResponseScreen({ id }: { id: string }) {
  const { apply } = useStore();
  const { view } = useClientCase(id);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const back = () => navigate({ name: 'client-case', id });

  if (!view || view.status !== 'WAITING') {
    return (
      <div className="screen narrow">
        <ScreenHeader title="Can’t add a response" onBack={back} backLabel="Case" />
        <EmptyState title="Responses can be added only while a case is waiting for the prospect." />
      </div>
    );
  }

  return (
    <div className="screen narrow">
      <ScreenHeader title="Add Prospect Response" subtitle={<CaseIdentity view={view} />} onBack={back} backLabel="Case" />
      {view.lastSentMessage && (
        <section className="card">
          <h2 className="card-title">Message You Sent</h2>
          <blockquote className="message-card">{view.lastSentMessage}</blockquote>
        </section>
      )}
      <form
        className="card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const err = apply((d) => addProspectResponse(d, id, text));
          if (err) setError(err);
          else navigate({ name: 'client-case', id }, { replace: true });
        }}
      >
        <Field label="Paste the prospect's exact response." hint="Copy it word for word; don’t summarise." error={error}>
          {(fid, d) => <textarea id={fid} aria-describedby={d} rows={8} value={text} onChange={(e) => { setText(e.target.value); setError(null); }} />}
        </Field>
        <Button type="submit" block disabled={!text.trim()}>Submit Response</Button>
      </form>
    </div>
  );
}
