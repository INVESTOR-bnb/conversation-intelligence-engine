// C04 — submission confirmation.

import { Button, Icon } from '../components/ui';
import { navigate } from '../router';
import { useClientCase } from '../state/store';
import { CaseIdentity } from './common';

export function SubmittedScreen({ id }: { id: string }) {
  const { view } = useClientCase(id);
  return (
    <div className="screen narrow">
      <div className="card center-card">
        <span className="big-icon tone-review"><Icon name="check" size={32} /></span>
        <h1 className="screen-title">Case Submitted</h1>
        {view && <CaseIdentity view={view} />}
        <p>We’re reviewing this deal.</p>
        <p>You don’t need to take any action yet.</p>
        <Button block onClick={() => navigate({ name: 'client-dashboard' }, { replace: true })}>Back to Dashboard</Button>
        {view && <Button block variant="ghost" onClick={() => navigate({ name: 'client-case', id: view.id })}>View Case</Button>}
      </div>
    </div>
  );
}
