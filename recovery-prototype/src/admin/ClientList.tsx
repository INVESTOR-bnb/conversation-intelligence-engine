// A02 — client list, client detail and frontend-only Add Client form.

import { useState } from 'react';
import { Button, EmptyState, ErrorBanner, Field, Notice, ScreenHeader } from '../components/ui';
import { WORKFLOW_LABEL, isTerminal } from '../domain/labels';
import { addClient } from '../domain/transitions';
import { navigate } from '../router';
import { useStore } from '../state/store';
import { AdminNav } from './AdminNav';

export function ClientListScreen() {
  const { data } = useStore();
  return (
    <div className="screen wide">
      <ScreenHeader title="Clients" subtitle="Admin" />
      <AdminNav active="clients" />
      <Button block onClick={() => navigate({ name: 'admin-client-new' })}>Add Client</Button>
      <div className="stack top-gap">
        {data.clients.map((cl) => {
          const cases = data.cases.filter((c) => c.clientId === cl.id);
          return (
            <article key={cl.id} className="case-card">
              <p className="list-title">{cl.businessName}</p>
              <p className="muted small">{cl.industry} · {cl.currency}</p>
              <dl className="kv kv-inline">
                <div><dt>Active Cases</dt><dd>{cases.filter((c) => !isTerminal(c.workflowState)).length}</dd></div>
                <div><dt>Recovered Cases</dt><dd>{cases.filter((c) => c.workflowState === 'WON').length}</dd></div>
              </dl>
              <Button variant="secondary" block onClick={() => navigate({ name: 'admin-client', id: cl.id })}>View Client</Button>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function AdminClientDetail({ id }: { id: string }) {
  const { data } = useStore();
  const client = data.clients.find((c) => c.id === id);
  const back = () => navigate({ name: 'admin-clients' });
  if (!client) {
    return (
      <div className="screen wide">
        <ScreenHeader title="Client not found" onBack={back} backLabel="Clients" />
      </div>
    );
  }
  const cases = data.cases.filter((c) => c.clientId === id);
  return (
    <div className="screen wide">
      <ScreenHeader title={client.businessName} subtitle={`${client.industry} · ${client.currency}`} onBack={back} backLabel="Clients" />
      <section className="card">
        <h2 className="card-title">Client User</h2>
        <dl className="kv">
          <div><dt>Name</dt><dd>{client.userName}</dd></div>
          <div><dt>Email</dt><dd>{client.userEmail}</dd></div>
        </dl>
      </section>
      <h2 className="section-title">Cases</h2>
      {cases.length === 0 ? (
        <EmptyState title="No cases for this client yet." />
      ) : (
        <ul className="list">
          {cases.map((c) => (
            <li key={c.id}>
              <button type="button" className="list-row" onClick={() => navigate({ name: 'admin-case', id: c.id })}>
                <span>
                  <span className="list-title">{c.reference} — {c.productService}</span>
                  <span className="muted small">{WORKFLOW_LABEL[c.workflowState]}</span>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR', 'USD', 'GBP', 'EUR'];

export function AddClientScreen() {
  const { apply } = useStore();
  const [f, setF] = useState({ businessName: '', industry: '', currency: 'NGN', userName: '', userEmail: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = () => {
    const e: Record<string, string> = {};
    if (!f.businessName.trim()) e.businessName = 'Required.';
    if (!f.industry.trim()) e.industry = 'Required.';
    if (!f.userName.trim()) e.userName = 'Required.';
    if (!/^\S+@\S+\.\S+$/.test(f.userEmail.trim())) e.userEmail = 'Enter a valid email address.';
    setErrors(e);
    if (Object.keys(e).length) return;
    const err = apply((d) => addClient(d, { ...f, businessName: f.businessName.trim(), industry: f.industry.trim(), userName: f.userName.trim(), userEmail: f.userEmail.trim() }));
    if (err) setError(err);
    else navigate({ name: 'admin-clients' }, { replace: true });
  };

  return (
    <div className="screen narrow">
      <ScreenHeader title="Add Client" onBack={() => navigate({ name: 'admin-clients' })} backLabel="Clients" />
      <Notice tone="warn">Prototype only: the client is saved to local demo data. No invitation or email is sent.</Notice>
      <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Business Name" error={errors.businessName}>{(id, d) => <input id={id} aria-describedby={d} value={f.businessName} onChange={set('businessName')} />}</Field>
        <Field label="Industry" error={errors.industry}>{(id, d) => <input id={id} aria-describedby={d} value={f.industry} onChange={set('industry')} />}</Field>
        <Field label="Currency">
          {(id) => (
            <select id={id} value={f.currency} onChange={set('currency')}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </Field>
        <Field label="Client User Name" error={errors.userName}>{(id, d) => <input id={id} aria-describedby={d} value={f.userName} onChange={set('userName')} />}</Field>
        <Field label="Client User Email" error={errors.userEmail}>{(id, d) => <input id={id} aria-describedby={d} type="email" inputMode="email" value={f.userEmail} onChange={set('userEmail')} />}</Field>
        <ErrorBanner message={error} />
        <Button type="submit" block>Add Client</Button>
      </form>
    </div>
  );
}
