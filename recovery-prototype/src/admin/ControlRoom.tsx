// A01 — Recovery Control Room.

import { Button, ClassificationBadge, EmptyState, ScreenHeader, StatusPill, formatDate } from '../components/ui';
import { NEEDS_ANALYSIS_STATES, REVIEW_STATES, WORKFLOW_LABEL, isTerminal } from '../domain/labels';
import type { AppData, RecoveryCase } from '../domain/types';
import { navigate } from '../router';
import { useStore } from '../state/store';
import { AdminNav } from './AdminNav';

const REASON_LABEL: Record<NonNullable<RecoveryCase['reviewReason']>, string> = {
  NEW_SUBMISSION: 'New submission',
  PROSPECT_RESPONSE: 'New prospect response',
  REANALYSIS: 'Reanalysis requested',
};

export function reviewQueue(data: AppData) {
  return data.cases
    .filter((c) => REVIEW_STATES.includes(c.workflowState))
    .sort((a, b) => (a.queuedAt ?? a.updatedAt).localeCompare(b.queuedAt ?? b.updatedAt));
}

export function clientName(data: AppData, id: string) {
  return data.clients.find((c) => c.id === id)?.businessName ?? 'Unknown client';
}

export function ControlRoomScreen() {
  const { data } = useStore();
  const queue = reviewQueue(data);
  const active = data.cases.filter((c) => !isTerminal(c.workflowState));
  const won = data.cases.filter((c) => c.workflowState === 'WON');
  const others = active.filter((c) => !REVIEW_STATES.includes(c.workflowState));

  return (
    <div className="screen wide">
      <ScreenHeader title="Recovery Control Room" subtitle="Admin" />
      <AdminNav active="home" />

      <div className="stats stats-3">
        <div className="stat"><span className="stat-num">{queue.length}</span><span className="stat-label">Requires Review</span></div>
        <div className="stat"><span className="stat-num">{active.length}</span><span className="stat-label">Active Cases</span></div>
        <div className="stat"><span className="stat-num">{won.length}</span><span className="stat-label">Won</span></div>
      </div>

      <h2 className="section-title">Review Queue <span className="muted small">oldest first</span></h2>
      {queue.length === 0 ? (
        <EmptyState title="Review queue is empty.">New submissions and prospect responses will appear here.</EmptyState>
      ) : (
        <div className="stack">
          {queue.map((c) => (
            <article key={c.id} className="case-card">
              <p className="client-name">{clientName(data, c.clientId)}</p>
              <p className="case-line"><span className="case-ref">{c.reference}</span> — {c.productService}</p>
              <div className="meta-row">
                {c.reviewReason && <StatusPill tone="info">{REASON_LABEL[c.reviewReason]}</StatusPill>}
                <span className="muted small">Queued {formatDate(c.queuedAt, true)}</span>
              </div>
              <div className="meta-row">
                <span className="muted small">Mock AI Recommendation:</span>
                {c.analysis && !NEEDS_ANALYSIS_STATES.includes(c.workflowState) ? (
                  <ClassificationBadge value={c.analysis.classification} showLabel={false} />
                ) : (
                  <StatusPill tone="neutral">Not yet run</StatusPill>
                )}
              </div>
              <Button block onClick={() => navigate({ name: 'admin-case', id: c.id })}>Review Case</Button>
            </article>
          ))}
        </div>
      )}

      <h2 className="section-title">Other Active Cases</h2>
      {others.length === 0 ? (
        <EmptyState title="No other active cases." />
      ) : (
        <ul className="list">
          {others.map((c) => (
            <li key={c.id}>
              <button type="button" className="list-row" onClick={() => navigate({ name: 'admin-case', id: c.id })}>
                <span>
                  <span className="list-title">{c.reference} — {c.productService}</span>
                  <span className="muted small">{clientName(data, c.clientId)} · {WORKFLOW_LABEL[c.workflowState]}</span>
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
