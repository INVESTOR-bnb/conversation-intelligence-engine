import { ClassificationBadge, StatusPill } from '../components/ui';
import type { ClientCaseView } from '../domain/clientView';

export function ClientStatus({ view, size = 'md' }: { view: ClientCaseView; size?: 'md' | 'lg' }) {
  switch (view.status) {
    case 'UNDER_REVIEW':
      return <StatusPill tone="review">Under Review</StatusPill>;
    case 'ACTION_REQUIRED':
      return view.classification ? <ClassificationBadge value={view.classification} size={size} /> : <StatusPill tone="review">Under Review</StatusPill>;
    case 'WAITING':
      return <StatusPill tone="waiting">Waiting for Prospect</StatusPill>;
    case 'WON':
      return <StatusPill tone="won">Recovered</StatusPill>;
    case 'LOST':
      return <StatusPill tone="closed">Closed — Lost</StatusPill>;
    case 'PAUSED':
      return <StatusPill tone="closed">Paused</StatusPill>;
    case 'DISQUALIFIED':
      return <StatusPill tone="closed">Disqualified</StatusPill>;
  }
}

export function nextStepText(view: ClientCaseView): string | null {
  switch (view.status) {
    case 'UNDER_REVIEW':
      return 'No action needed yet';
    case 'ACTION_REQUIRED':
      return view.classification === 'RED' ? 'Stop follow-up and close the case' : 'Send approved message';
    case 'WAITING':
      return 'Add the prospect’s response when it arrives';
    default:
      return null;
  }
}

export function CaseIdentity({ view }: { view: ClientCaseView }) {
  return (
    <div className="case-id">
      <span className="case-ref">{view.reference}</span>
      <span className="case-product">{view.productService}</span>
    </div>
  );
}
