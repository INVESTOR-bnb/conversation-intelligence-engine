import { navigate } from '../router';

export function AdminNav({ active }: { active: 'home' | 'clients' }) {
  return (
    <nav className="tabs" aria-label="Admin sections">
      <button type="button" className={active === 'home' ? 'on' : ''} aria-current={active === 'home' ? 'page' : undefined} onClick={() => navigate({ name: 'admin-home' })}>
        Control Room
      </button>
      <button type="button" className={active === 'clients' ? 'on' : ''} aria-current={active === 'clients' ? 'page' : undefined} onClick={() => navigate({ name: 'admin-clients' })}>
        Clients
      </button>
    </nav>
  );
}
