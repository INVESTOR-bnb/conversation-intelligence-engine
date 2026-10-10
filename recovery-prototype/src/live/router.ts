// Minimal pathname router for the live (authenticated) app. The Stage-1 demo
// keeps its own hash router under /demo.

import { useEffect, useState } from 'react';
import { founderCaseIdFromPath } from './cases';

export const LIVE_PATHS = ['/login', '/auth/callback', '/auth/set-password', '/app', '/app/founder', '/app/client', '/demo'] as const;

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function usePathname(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    // Child effects run before this one: catch navigations that happened
    // before the listener existed (e.g. an initial redirect).
    onPop();
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

/**
 * Post-login destination. Only known internal app paths are accepted, which
 * prevents open redirects (e.g. ?next=https://evil.example or //evil.example).
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/app';
  const path = next.split(/[?#]/)[0];
  const allowed = ['/app', '/app/founder', '/app/client', '/demo'];
  if (allowed.includes(path)) return path;
  const caseId = founderCaseIdFromPath(path);
  return caseId ? `/app/founder/case/${caseId}` : '/app';
}
