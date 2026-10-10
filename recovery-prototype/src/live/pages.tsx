// Live (authenticated) pages. Reuses the Stage-1 UI building blocks; no redesign.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, EmptyState, ErrorBanner, Field, Notice, ScreenHeader } from '../components/ui';
import { useAuth } from './auth';
import { parseAuthCallback } from './authCallback';
import { navigate, safeNext } from './router';

export const MIN_PASSWORD_LENGTH = 10;

function Shell({ children }: { children: ReactNode }) {
  const { status, profile, session, signOut } = useAuth();
  return (
    <div className="app app-live">
      <div className="demobar" role="region" aria-label="Environment">
        <div className="demobar-row">
          <span className="demobar-tag">Staging · synthetic data only</span>
          {status === 'signedIn' && (
            <button type="button" className="demobar-more" onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}>
              Sign out
            </button>
          )}
        </div>
        {status === 'signedIn' && (
          <p className="demobar-note">Signed in as {session?.user.email ?? 'unknown'}{profile ? ` · ${profile.role === 'NONE' ? 'not yet authorised' : profile.role.toLowerCase()}` : ''}</p>
        )}
      </div>
      <main className="main">
        <div className="screen narrow">{children}</div>
      </main>
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <Shell>
      <p className="muted" role="status">{label}</p>
    </Shell>
  );
}

export function LoginPage() {
  const { signIn, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(new URLSearchParams(window.location.search).get('next'));

  useEffect(() => {
    if (status === 'signedIn') navigate(next, { replace: true });
  }, [status, next]);

  return (
    <Shell>
      <div className="login-brand">
        <span className="brand-mark" aria-hidden="true">R</span>
        <div>
          <p className="brand-name">Revenue Recovery</p>
          <p className="brand-sub">Sign in to your account</p>
        </div>
      </div>
      <form
        className="card"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!email.trim() || !password) {
            setError('Enter your email and password.');
            return;
          }
          setBusy(true);
          setError(await signIn(email, password));
          setBusy(false);
        }}
      >
        <h1 className="card-title">Sign in</h1>
        <Field label="Email">
          {(id) => <input id={id} type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Password">
          {(id) => <input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <ErrorBanner message={error} />
        <Button type="submit" block disabled={busy}>{busy ? 'Signing in…' : 'Sign In'}</Button>
        <p className="muted small">Access is by invitation only. If you were invited, open the link in your invitation email first.</p>
      </form>
    </Shell>
  );
}

/** Handles Supabase invitation / recovery redirects (tokens or errors in the URL). */
export function AuthCallbackPage() {
  const { completeCallback } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const result = parseAuthCallback(window.location.hash, window.location.search);
    // Remove tokens/errors from the address bar and history immediately.
    history.replaceState(null, '', '/auth/callback');
    void completeCallback(result).then(({ error: err, needsPassword }) => {
      if (err) setError(err);
      else navigate(needsPassword ? '/auth/set-password' : '/app', { replace: true });
    });
  }, [completeCallback]);

  if (!error) return <Loading label="Checking your invitation…" />;
  return (
    <Shell>
      <ScreenHeader title="Link problem" />
      <div className="banner banner-error" role="alert">{error}</div>
      <Button block variant="secondary" onClick={() => navigate('/login', { replace: true })}>Go to sign in</Button>
    </Shell>
  );
}

export function SetPasswordPage() {
  const { status, setPassword, passwordSetupRequired } = useAuth();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'signedOut') navigate('/login', { replace: true });
  }, [status]);
  if (status !== 'signedIn') return <Loading />;

  return (
    <Shell>
      <ScreenHeader title={passwordSetupRequired ? 'Set your password' : 'Change password'} subtitle="You will use this password to sign in." />
      <form
        className="card"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw.length < MIN_PASSWORD_LENGTH) return setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
          if (pw !== confirm) return setError('The two passwords do not match.');
          setBusy(true);
          const err = await setPassword(pw);
          setBusy(false);
          if (err) setError(err);
          else navigate('/app', { replace: true });
        }}
      >
        <Field label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}
        </Field>
        <Field label="Confirm password">
          {(id) => <input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <ErrorBanner message={error} />
        <Button type="submit" block disabled={busy}>{busy ? 'Saving…' : 'Save Password'}</Button>
      </form>
    </Shell>
  );
}

/** Account exists but the server grants no role yet (invited, not yet authorised). */
export function AccountPending() {
  const { profile, refreshProfile } = useAuth();
  return (
    <Shell>
      <ScreenHeader title="Account not yet authorised" />
      <Card>
        <p>Your sign-in works, but this account has not been given access yet. Nothing is visible until the founder authorises it.</p>
        <dl className="kv">
          <div><dt>Email</dt><dd data-testid="account-email">{profile?.email ?? '—'}</dd></div>
          <div><dt>User ID</dt><dd data-testid="account-user-id">{profile?.userId}</dd></div>
        </dl>
        <Button variant="secondary" block onClick={() => void refreshProfile()}>Check again</Button>
      </Card>
    </Shell>
  );
}

export function NotAuthorized() {
  return (
    <Shell>
      <ScreenHeader title="Not authorised" />
      <div className="banner banner-error" role="alert">Your account does not have access to this page.</div>
      <Button block variant="secondary" onClick={() => navigate('/app', { replace: true })}>Go to my workspace</Button>
    </Shell>
  );
}

export function NotFound() {
  return (
    <Shell>
      <ScreenHeader title="Page not found" />
      <Button block variant="secondary" onClick={() => navigate('/app', { replace: true })}>Go to my workspace</Button>
    </Shell>
  );
}

export function FounderWorkspace() {
  const { supabase, profile } = useAuth();
  const [counts, setCounts] = useState<{ businesses: number; cases: number } | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      // Reads are enforced by RLS: these rows are only returned to founders.
      const [b, c] = await Promise.all([
        supabase.from('businesses').select('name').order('name'),
        supabase.from('cases').select('id', { count: 'exact', head: true }),
      ]);
      if (!active) return;
      if (b.error || c.error) return setError('Could not load workspace data.');
      setNames((b.data ?? []).map((r: { name: string }) => r.name));
      setCounts({ businesses: (b.data ?? []).length, cases: c.count ?? 0 });
    })();
    return () => {
      active = false;
    };
  }, [supabase]);

  return (
    <Shell>
      <ScreenHeader title="Founder workspace" subtitle={profile?.email ?? undefined} />
      <ErrorBanner message={error} />
      <div className="stats">
        <div className="stat"><span className="stat-num" data-testid="founder-business-count">{counts ? counts.businesses : '…'}</span><span className="stat-label">Businesses</span></div>
        <div className="stat"><span className="stat-num" data-testid="founder-case-count">{counts ? counts.cases : '…'}</span><span className="stat-label">Cases</span></div>
      </div>
      <Card title="Businesses">
        {names.length === 0 ? <EmptyState title="No businesses yet." /> : <ul className="bullets">{names.map((n) => <li key={n}>{n}</li>)}</ul>}
      </Card>
      <Notice>The live case workflow arrives in later Stage 2A steps. The Stage-1 prototype (mock data) remains available below.</Notice>
      <Button block variant="secondary" onClick={() => { window.location.href = '/demo'; }}>Open Stage-1 prototype (mock data)</Button>
    </Shell>
  );
}

interface ClientRow { id: string; reference: string; product_service: string; status: string }

export function ClientWorkspace() {
  const { supabase, profile } = useAuth();
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Client-safe projection only (server-side function); no private fields exist in it.
    supabase.rpc('client_list_cases').then(({ data, error: err }) => {
      if (!active) return;
      if (err) setError('Could not load your cases.');
      else setRows(((data ?? []) as ClientRow[]).map(({ id, reference, product_service, status }) => ({ id, reference, product_service, status })));
    });
    return () => {
      active = false;
    };
  }, [supabase]);

  return (
    <Shell>
      <ScreenHeader title="Your cases" subtitle={profile?.businessName} />
      <ErrorBanner message={error} />
      {rows === null && !error && <p className="muted" role="status">Loading…</p>}
      {rows && rows.length === 0 && <EmptyState title="No cases yet." />}
      {rows && rows.length > 0 && (
        <ul className="list" data-testid="client-cases">
          {rows.map((r) => (
            <li key={r.id} className="list-row">
              <span><span className="list-title">{r.reference} — {r.product_service}</span><span className="muted small">{r.status.replace('_', ' ').toLowerCase()}</span></span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
