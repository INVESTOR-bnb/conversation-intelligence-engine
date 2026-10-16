// Route table and guards for the live (Supabase) app.

import { useEffect, type ReactNode } from 'react';
import { App as Stage1App } from '../App';
import { StoreProvider } from '../state/store';
import { useAuth, type Role } from './auth';
import { looksLikeAuthCallback } from './authCallback';
import { clientCaseIdFromPath, founderCaseIdFromPath } from './cases';
import {
  AccountPending, AuthCallbackPage, ClientCaseRoute, ClientWorkspace, FounderCasePage, FounderWorkspace, Loading, LoginPage, NotAuthorized, NotFound, SetPasswordPage,
} from './pages';
import { navigate, usePathname } from './router';

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return <Loading />;
}

/** Requires a session, a completed password setup and (optionally) a server-verified role. */
function Protected({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { status, profile, profileError, isPasswordSetupRequired } = useAuth();
  const path = window.location.pathname;
  if (status === 'loading') return <Loading />;
  if (status === 'signedOut') return <Redirect to={`/login?next=${encodeURIComponent(path)}`} />;
  if (isPasswordSetupRequired()) return <Redirect to="/auth/set-password" />;
  if (profileError) return <Loading label={profileError} />;
  if (!profile) return <Loading label="Checking access…" />;
  if (roles && !roles.includes(profile.role)) return <NotAuthorized />;
  return <>{children}</>;
}

function Home() {
  const { profile } = useAuth();
  if (profile?.role === 'FOUNDER') return <Redirect to="/app/founder" />;
  if (profile?.role === 'CLIENT') return <Redirect to="/app/client" />;
  return <AccountPending />;
}

export function LiveApp() {
  const path = usePathname();

  // Supabase redirects to the Site URL (often the root) with tokens or errors
  // in the fragment. Handle that wherever it lands, before any other routing.
  if (looksLikeAuthCallback(window.location.hash, window.location.search)) return <AuthCallbackPage />;

  const founderCaseId = founderCaseIdFromPath(path);
  if (founderCaseId) return <Protected roles={['FOUNDER']}><FounderCasePage caseId={founderCaseId} /></Protected>;
  const clientCaseId = clientCaseIdFromPath(path);
  if (clientCaseId) return <Protected roles={['CLIENT']}><ClientCaseRoute caseId={clientCaseId} /></Protected>;

  switch (path) {
    case '/':
      return <Redirect to="/app" />;
    case '/login':
      return <LoginPage />;
    case '/auth/callback':
      return <AuthCallbackPage />;
    case '/auth/set-password':
      return <SetPasswordPage />;
    case '/app':
      return <Protected><Home /></Protected>;
    case '/app/founder':
      return <Protected roles={['FOUNDER']}><FounderWorkspace /></Protected>;
    case '/app/client':
      return <Protected roles={['CLIENT']}><ClientWorkspace /></Protected>;
    case '/demo':
      // Stage-1 prototype (browser-local mock data) — founder only in live mode.
      return (
        <Protected roles={['FOUNDER']}>
          <StoreProvider>
            <Stage1App />
          </StoreProvider>
        </Protected>
      );
    default:
      return <NotFound />;
  }
}
