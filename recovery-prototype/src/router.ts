// Minimal hash router. Hash routes keep the Android back button working without
// adding a routing dependency or needing server configuration.

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'login' }
  | { name: 'client-dashboard' }
  | { name: 'client-new' }
  | { name: 'client-submitted'; id: string }
  | { name: 'client-case'; id: string }
  | { name: 'client-sent'; id: string }
  | { name: 'client-respond'; id: string }
  | { name: 'client-outcome'; id: string }
  | { name: 'admin-home' }
  | { name: 'admin-case'; id: string }
  | { name: 'admin-clients' }
  | { name: 'admin-client'; id: string }
  | { name: 'admin-client-new' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [area, a, b, c] = parts;
  if (area === 'client') {
    if (a === 'new') return { name: 'client-new' };
    if (a === 'submitted' && b) return { name: 'client-submitted', id: b };
    if (a === 'case' && b) {
      if (c === 'sent') return { name: 'client-sent', id: b };
      if (c === 'respond') return { name: 'client-respond', id: b };
      if (c === 'outcome') return { name: 'client-outcome', id: b };
      return { name: 'client-case', id: b };
    }
    return { name: 'client-dashboard' };
  }
  if (area === 'admin') {
    if (a === 'case' && b) return { name: 'admin-case', id: b };
    if (a === 'clients' && b === 'new') return { name: 'admin-client-new' };
    if (a === 'clients' && b) return { name: 'admin-client', id: b };
    if (a === 'clients') return { name: 'admin-clients' };
    return { name: 'admin-home' };
  }
  return { name: 'login' };
}

export function routeToHash(r: Route): string {
  switch (r.name) {
    case 'login': return '#/login';
    case 'client-dashboard': return '#/client';
    case 'client-new': return '#/client/new';
    case 'client-submitted': return `#/client/submitted/${r.id}`;
    case 'client-case': return `#/client/case/${r.id}`;
    case 'client-sent': return `#/client/case/${r.id}/sent`;
    case 'client-respond': return `#/client/case/${r.id}/respond`;
    case 'client-outcome': return `#/client/case/${r.id}/outcome`;
    case 'admin-home': return '#/admin';
    case 'admin-case': return `#/admin/case/${r.id}`;
    case 'admin-clients': return '#/admin/clients';
    case 'admin-client': return `#/admin/clients/${r.id}`;
    case 'admin-client-new': return '#/admin/clients/new';
  }
}

export function navigate(r: Route, opts: { replace?: boolean } = {}) {
  const hash = routeToHash(r);
  if (opts.replace) {
    history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
