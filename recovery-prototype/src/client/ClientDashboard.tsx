// C02 — client dashboard.

import { useState } from 'react';
import { Button, EmptyState, Icon, ScreenHeader } from '../components/ui';
import type { ClientCaseView } from '../domain/clientView';
import { navigate } from '../router';
import { useClientCases } from '../state/store';
import { CaseIdentity, ClientStatus, nextStepText } from './common';

const FILTERS = ['All', 'Green', 'Yellow', 'Waiting', 'Closed'] as const;
type Filter = (typeof FILTERS)[number];

const CLOSED = ['WON', 'LOST', 'PAUSED', 'DISQUALIFIED'];

function matches(v: ClientCaseView, f: Filter) {
  switch (f) {
    case 'All': return true;
    case 'Green': return v.status === 'ACTION_REQUIRED' && v.classification === 'GREEN';
    case 'Yellow': return v.status === 'ACTION_REQUIRED' && v.classification === 'YELLOW';
    case 'Waiting': return v.status === 'WAITING';
    case 'Closed': return CLOSED.includes(v.status);
  }
}

function CaseCard({ view }: { view: ClientCaseView }) {
  const next = nextStepText(view);
  return (
    <article className="case-card">
      <div className="case-card-top">
        <CaseIdentity view={view} />
      </div>
      <ClientStatus view={view} />
      {next && (
        <p className="case-next">
          <span className="muted">Next:</span> {next}
        </p>
      )}
      <Button variant="secondary" block onClick={() => navigate({ name: 'client-case', id: view.id })}>View Case</Button>
    </article>
  );
}

export function ClientDashboard() {
  const { clientName, cases } = useClientCases();
  const [filter, setFilter] = useState<Filter>('All');

  const active = cases.filter((c) => !CLOSED.includes(c.status)).length;
  const recovered = cases.filter((c) => c.status === 'WON').length;
  const actionCases = cases.filter((c) => c.status === 'ACTION_REQUIRED');
  const filtered = cases.filter((c) => matches(c, filter));

  return (
    <div className="screen narrow">
      <ScreenHeader title="Recovery" subtitle={clientName} />

      <div className="stats">
        <div className="stat"><span className="stat-num">{active}</span><span className="stat-label">Active Cases</span></div>
        <div className="stat"><span className="stat-num">{recovered}</span><span className="stat-label">Recovered Deals</span></div>
      </div>

      <Button block onClick={() => navigate({ name: 'client-new' })}>
        <Icon name="plus" /> Add Stalled Prospect
      </Button>

      <h2 className="section-title">Cases Requiring Your Action</h2>
      {actionCases.length === 0 ? (
        <EmptyState title="Nothing needs your action right now.">Cases under review will appear here once a recommendation is approved.</EmptyState>
      ) : (
        <div className="stack">{actionCases.map((v) => <CaseCard key={v.id} view={v} />)}</div>
      )}

      <h2 className="section-title">All Cases</h2>
      <div className="chips" role="group" aria-label="Filter cases">
        {FILTERS.map((f) => (
          <button key={f} type="button" className={`chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <EmptyState title={cases.length === 0 ? 'No cases yet.' : `No ${filter.toLowerCase()} cases.`}>
          {cases.length === 0 && 'Add a stalled prospect to get started.'}
        </EmptyState>
      ) : (
        <div className="stack">{filtered.map((v) => <CaseCard key={v.id} view={v} />)}</div>
      )}
    </div>
  );
}
