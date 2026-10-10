// Live (authenticated) pages. Reuses the Stage-1 UI building blocks; no redesign.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, EmptyState, ErrorBanner, Field, Notice, ScreenHeader } from '../components/ui';
import { useAuth } from './auth';
import { parseAuthCallback } from './authCallback';
import { BUSINESS_NAME_MAX, INDUSTRY_MAX, onboardingErrorMessage, validateBusiness, validateLink, type BusinessErrors } from './onboarding';
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

interface BusinessRow { id: string; name: string; industry: string; currency: string }

export function FounderWorkspace() {
  const { supabase, profile } = useAuth();
  const [businesses, setBusinesses] = useState<BusinessRow[] | null>(null);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [caseCount, setCaseCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Reads are enforced by RLS: these rows are only returned to founders.
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const [b, m, c] = await Promise.all([
      supabase.from('businesses').select('id, name, industry, currency').order('name'),
      supabase.from('business_members').select('business_id'),
      supabase.from('cases').select('id', { count: 'exact', head: true }),
    ]);
    if (mine !== seq.current) return;
    if (b.error || m.error || c.error) {
      setError('Could not load workspace data.');
      return;
    }
    setError(null);
    setBusinesses((b.data ?? []) as BusinessRow[]);
    const counts: Record<string, number> = {};
    for (const r of (m.data ?? []) as { business_id: string }[]) counts[r.business_id] = (counts[r.business_id] ?? 0) + 1;
    setMemberCounts(counts);
    setCaseCount(c.count ?? 0);
  }, [supabase]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  return (
    <Shell>
      <ScreenHeader title="Founder workspace" subtitle={profile?.email ?? undefined} />
      <ErrorBanner message={error} />
      <div className="stats">
        <div className="stat"><span className="stat-num" data-testid="founder-business-count">{businesses ? businesses.length : '…'}</span><span className="stat-label">Businesses</span></div>
        <div className="stat"><span className="stat-num" data-testid="founder-case-count">{caseCount ?? '…'}</span><span className="stat-label">Cases</span></div>
      </div>
      <Card title="Businesses">
        {businesses && businesses.length === 0 ? (
          <EmptyState title="No businesses yet." />
        ) : (
          <ul className="list" data-testid="founder-business-list">
            {(businesses ?? []).map((b) => (
              <li key={b.id} className="list-row">
                <span>
                  <span className="list-title">{b.name}</span>
                  <span className="muted small">
                    {[b.industry, b.currency].filter(Boolean).join(' · ')} · {memberCounts[b.id] ?? 0} linked client{(memberCounts[b.id] ?? 0) === 1 ? '' : 's'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CreateBusinessForm onCreated={load} />
      <LinkClientForm businesses={businesses ?? []} onLinked={load} />
      <Notice>Use synthetic businesses and test accounts only. The live case workflow arrives in later Stage 2A steps.</Notice>
      <Button block variant="secondary" onClick={() => { window.location.href = '/demo'; }}>Open Stage-1 prototype (mock data)</Button>
    </Shell>
  );
}

function SuccessNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="banner banner-info" role="status">{message}</div>;
}

function CreateBusinessForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const { supabase } = useAuth();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [errors, setErrors] = useState<BusinessErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card"
      noValidate
      aria-labelledby="create-business-title"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setSuccess(null);
        setError(null);
        const { value, errors: errs } = validateBusiness({ name, industry, currency });
        setErrors(errs);
        if (!value) return;
        setBusy(true);
        const { error: err } = await supabase.rpc('founder_create_business', { p_name: value.name, p_industry: value.industry, p_currency: value.currency });
        if (err) {
          setError(onboardingErrorMessage(err));
        } else {
          setSuccess(`Business “${value.name}” created.`);
          setName('');
          setIndustry('');
          setCurrency('NGN');
          await onCreated();
        }
        setBusy(false);
      }}
    >
      <h2 className="card-title" id="create-business-title">Create business</h2>
      <Field label="Business name" error={errors.name}>
        {(id, d) => <input id={id} aria-describedby={d} maxLength={BUSINESS_NAME_MAX + 20} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Industry" optional error={errors.industry}>
        {(id, d) => <input id={id} aria-describedby={d} maxLength={INDUSTRY_MAX + 20} value={industry} onChange={(e) => setIndustry(e.target.value)} />}
      </Field>
      <Field label="Currency" hint="3-letter code, for example NGN." error={errors.currency}>
        {(id, d) => <input id={id} aria-describedby={d} maxLength={3} autoCapitalize="characters" autoComplete="off" value={currency} onChange={(e) => setCurrency(e.target.value)} />}
      </Field>
      <ErrorBanner message={error} />
      <SuccessNote message={success} />
      <Button type="submit" block disabled={busy}>{busy ? 'Creating…' : 'Create Business'}</Button>
    </form>
  );
}

function LinkClientForm({ businesses, onLinked }: { businesses: BusinessRow[]; onLinked: () => Promise<void> }) {
  const { supabase } = useAuth();
  const [businessId, setBusinessId] = useState('');
  const [userId, setUserId] = useState('');
  const [errors, setErrors] = useState<{ business?: string; userId?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card"
      noValidate
      aria-labelledby="link-client-title"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setSuccess(null);
        setError(null);
        const { value, errors: errs } = validateLink(businessId, userId);
        setErrors(errs);
        if (!value) return;
        setBusy(true);
        const { error: err } = await supabase.rpc('founder_add_member', { p_business_id: value.businessId, p_user_id: value.userId });
        if (err) {
          setError(onboardingErrorMessage(err));
        } else {
          const name = businesses.find((b) => b.id === value.businessId)?.name ?? 'the business';
          setSuccess(`Client linked to “${name}”. Ask them to tap “Check again” or reload the page.`);
          setUserId('');
          await onLinked();
        }
        setBusy(false);
      }}
    >
      <h2 className="card-title" id="link-client-title">Link client</h2>
      <p className="muted small">Invite the client from the Supabase dashboard first. After they set a password they see their User ID — paste it here.</p>
      <Field label="Business" error={errors.business}>
        {(id, d) => (
          <select id={id} aria-describedby={d} value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
            <option value="">Choose a business…</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </Field>
      <Field label="Client User ID" error={errors.userId}>
        {(id, d) => <input id={id} aria-describedby={d} autoComplete="off" autoCapitalize="none" spellCheck={false} value={userId} onChange={(e) => setUserId(e.target.value)} />}
      </Field>
      <ErrorBanner message={error} />
      <SuccessNote message={success} />
      <Button type="submit" block disabled={busy || businesses.length === 0}>{busy ? 'Linking…' : 'Link Client'}</Button>
    </form>
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
