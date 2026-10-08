// C05–C08, C10, C13 — the client case view. Content depends solely on the
// client-safe projection (ClientCaseView); private analysis is never available here.

import { Button, CopyButton, EmptyState, Icon, ScreenHeader, formatDate, formatMoney } from '../components/ui';
import type { ClientCaseView } from '../domain/clientView';
import { navigate } from '../router';
import { useClientCase } from '../state/store';
import { CaseIdentity, ClientStatus } from './common';

export function ClientCaseScreen({ id }: { id: string }) {
  const { view, currency } = useClientCase(id);
  const back = () => navigate({ name: 'client-dashboard' });

  if (!view) {
    return (
      <div className="screen narrow">
        <ScreenHeader title="Case not found" onBack={back} backLabel="Dashboard" />
        <EmptyState title="This case doesn’t exist for the current demo client.">It may belong to another demo business, or demo data was reset.</EmptyState>
      </div>
    );
  }

  return (
    <div className="screen narrow">
      <ScreenHeader title={<CaseIdentity view={view} />} onBack={back} backLabel="Dashboard" />
      <div className="status-hero">
        <ClientStatus view={view} size="lg" />
      </div>
      <Body view={view} currency={currency} />
      <History view={view} />
    </div>
  );
}

function Body({ view, currency }: { view: ClientCaseView; currency: string }) {
  switch (view.status) {
    case 'UNDER_REVIEW':
      return (
        <section className="card">
          <h2 className="card-title">Under Review</h2>
          <p>We’re reviewing the deal and determining the most appropriate next action.</p>
          <p className="strong">No action is required from you yet.</p>
        </section>
      );
    case 'ACTION_REQUIRED':
      return <Recommendation view={view} />;
    case 'WAITING':
      return (
        <>
          <section className="card">
            <h2 className="card-title">Waiting for Prospect</h2>
            <p>The recovery message has been sent.</p>
            <p>When the prospect responds, add their exact response here.</p>
            <p className="no-response"><Icon name="clock" size={16} /> No response yet</p>
            <Button block onClick={() => navigate({ name: 'client-respond', id: view.id })}>Add Prospect Response</Button>
          </section>
          {view.lastSentMessage && (
            <section className="card">
              <h2 className="card-title">Message You Sent</h2>
              <blockquote className="message-card">{view.lastSentMessage}</blockquote>
            </section>
          )}
          <OutcomeLink view={view} />
        </>
      );
    case 'WON':
      return (
        <section className="card closed-card">
          <h2 className="card-title">Recovered</h2>
          <dl className="kv">
            <div><dt>Recovered Payment</dt><dd>{formatMoney(view.won?.amountPaid, currency)}</dd></div>
            <div><dt>Recovery Attempts</dt><dd>{view.recoveryAttempts}</dd></div>
            <div><dt>Completion Date</dt><dd>{formatDate(view.won?.paymentDate)}</dd></div>
          </dl>
        </section>
      );
    case 'LOST':
      return <ClosedSimple title="Closed — Lost" text="This case is closed." view={view} />;
    case 'PAUSED':
      return <ClosedSimple title="Paused" text="This case is paused. No action is required." view={view} />;
    case 'DISQUALIFIED':
      return <ClosedSimple title="Disqualified" text="This prospect has been disqualified. No further contact." view={view} />;
  }
}

function ClosedSimple({ title, text, view }: { title: string; text: string; view: ClientCaseView }) {
  return (
    <section className="card closed-card">
      <h2 className="card-title">{title}</h2>
      <p>{text}</p>
      <p className="muted">Closed {formatDate(view.closedAt)} · {view.recoveryAttempts} recovery attempt{view.recoveryAttempts === 1 ? '' : 's'}</p>
    </section>
  );
}

function Recommendation({ view }: { view: ClientCaseView }) {
  const isRed = view.classification === 'RED';
  return (
    <>
      <section className={`card ${isRed ? 'card-stop' : ''}`}>
        <h2 className="card-title">Deal Situation</h2>
        <p>{view.dealSituation}</p>
      </section>
      <section className="card">
        <h2 className="card-title">What To Do Next</h2>
        <p className="strong">{view.nextAction}</p>
        {isRed && (
          <p className="muted">
            Stopping here is the right call for this prospect. It saves your time for deals the evidence supports. You can close this case below.
          </p>
        )}
      </section>
      {!isRed && view.approvedMessage && (
        <section className="card">
          <h2 className="card-title">Recommended Message</h2>
          <blockquote className="message-card" data-testid="approved-message">{view.approvedMessage}</blockquote>
          <div className="stack-sm">
            <CopyButton text={view.approvedMessage} />
            <Button block onClick={() => navigate({ name: 'client-sent', id: view.id })}>
              <Icon name="send" /> I Sent It
            </Button>
          </div>
        </section>
      )}
      <OutcomeLink view={view} red={isRed} />
    </>
  );
}

function OutcomeLink({ view, red }: { view: ClientCaseView; red?: boolean }) {
  return (
    <section className="card subtle">
      <h2 className="card-title">{red ? 'Close This Case' : 'Deal Outcome'}</h2>
      <p className="muted">{red ? 'Record how this case ends.' : 'If this deal has concluded, record the outcome.'}</p>
      <Button variant="secondary" block onClick={() => navigate({ name: 'client-outcome', id: view.id })}>Record Outcome</Button>
    </section>
  );
}

function History({ view }: { view: ClientCaseView }) {
  if (view.history.length === 0) return null;
  return (
    <section className="card">
      <h2 className="card-title">Case History</h2>
      <ol className="timeline">
        {[...view.history].reverse().map((h) => (
          <li key={h.id}>
            <span className="timeline-label">{h.label}</span>
            <span className="timeline-date">{formatDate(h.at, true)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
