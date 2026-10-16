// Live (authenticated) pages. Reuses the Stage-1 UI building blocks; no redesign.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, EmptyState, ErrorBanner, Field, formatDate, Notice, ScreenHeader } from '../components/ui';
import { FounderAnalysis } from './analysisUi';
import { useAuth } from './auth';
import { DEMO_RULE_SUBMIT, DEMO_RULE_SHORT, FOUNDER_ENVIRONMENT_LABEL, headerView, PRODUCT_NAME } from './environment';
import { parseAuthCallback } from './authCallback';
import { caseErrorMessage, clientStatusLabel, founderStateLabel, isAlreadySubmitted, LEAD_SOURCES, LIMITS, newRequestId, validateCase, type CaseErrors } from './cases';
import { BUSINESS_NAME_MAX, INDUSTRY_MAX, onboardingErrorMessage, validateBusiness, validateLink, type BusinessErrors } from './onboarding';
import { navigate, safeNext } from './router';
import { DRAFT_KEY, FounderScreenshots, releaseShots, resultMessage, ResumeDraft, ScreenshotPicker } from './screenshotUi';
import { completeScreenshotCase, fetchStatus, type ShotState } from './screenshotUpload';
import { SHOT_MESSAGES, summarizeStatus, type ProcessedShot } from './screenshots';
import { ClientCasePage, FounderCaseTimeline, FounderDecision, FounderRunAnalysis } from './workflowUi';

export const MIN_PASSWORD_LENGTH = 10;

function Shell({ children }: { children: ReactNode }) {
  const { status, profile, session, signOut } = useAuth();
  const signOutButton = status === 'signedIn' && (
    <button type="button" className="demobar-more" onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}>
      Sign out
    </button>
  );
  return (
    <div className="app app-live">
      {headerView(profile?.role) === 'founder' ? (
        <div className="demobar" role="region" aria-label="Environment">
          <div className="demobar-row">
            <span className="demobar-tag">{FOUNDER_ENVIRONMENT_LABEL}</span>
            {signOutButton}
          </div>
          {status === 'signedIn' && (
            <p className="demobar-note">Signed in as {session?.user.email ?? 'unknown'} · founder</p>
          )}
        </div>
      ) : (
        <header className="appbar" role="region" aria-label="Environment">
          <div className="appbar-row">
            <span className="appbar-brand">
              <span className="appbar-mark" aria-hidden="true">R</span>
              <span className="appbar-name">{PRODUCT_NAME}</span>
              <span className="demo-pill" data-testid="demo-label">Demo</span>
            </span>
          </div>
          <div className="appbar-row appbar-sub">
            <p className="appbar-note">
              {DEMO_RULE_SHORT}
              {status === 'signedIn' && <><br />{session?.user.email ?? 'unknown'}{profile?.role === 'NONE' ? ' (not yet authorised)' : ''}</>}
            </p>
            {signOutButton}
          </div>
        </header>
      )}
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
      <p className="muted">Sign in with the account you were given for this demo.</p>
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
interface FounderCaseRow { id: string; reference: string; product_service: string; workflow_state: string; created_at: string; businesses: { name: string } | null }

export function FounderWorkspace() {
  const { supabase, profile } = useAuth();
  const [businesses, setBusinesses] = useState<BusinessRow[] | null>(null);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [cases, setCases] = useState<FounderCaseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Reads are enforced by RLS: these rows are only returned to founders.
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const [b, m, c] = await Promise.all([
      supabase.from('businesses').select('id, name, industry, currency').order('name'),
      supabase.from('business_members').select('business_id'),
      // Drafts are the client's unfinished work; the founder sees submitted cases.
      supabase.from('cases').select('id, reference, product_service, workflow_state, created_at, businesses(name)')
        .neq('workflow_state', 'DRAFT').order('created_at', { ascending: false }).limit(100),
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
    setCases((c.data ?? []) as unknown as FounderCaseRow[]);
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
        <div className="stat"><span className="stat-num" data-testid="founder-case-count">{cases ? cases.length : '…'}</span><span className="stat-label">Submitted cases</span></div>
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
      <Card title="Submitted cases">
        {cases && cases.length === 0 ? (
          <EmptyState title="No submitted cases yet." />
        ) : (
          <ul className="list" data-testid="founder-case-list">
            {(cases ?? []).map((c) => (
              <li key={c.id} className="list-row">
                <a href={`/app/founder/case/${c.id}`} onClick={(e) => { e.preventDefault(); navigate(`/app/founder/case/${c.id}`); }}>
                  <span className="list-title">{c.reference} — {c.product_service}</span>
                  <span className="muted small">{c.businesses?.name ?? 'Unknown business'} · {founderStateLabel(c.workflow_state)} · {formatDate(c.created_at)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CreateBusinessForm onCreated={load} />
      <LinkClientForm businesses={businesses ?? []} onLinked={load} />
      <Notice>Use synthetic businesses, test accounts and made-up conversations only until the pilot data-handling terms are agreed.</Notice>
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

interface FounderCaseDetail {
  id: string; reference: string; product_service: string; lead_source: string; estimated_value: number | null;
  last_interaction_date: string | null; client_context: string | null; workflow_state: string; evidence_version: number;
  created_at: string; queued_at: string | null; conversation_source: 'TEXT' | 'SCREENSHOTS'; businesses: { name: string; currency: string } | null;
}

/** Founder view of one case: the evidence, the analysis, the decision and what happened next. All text is rendered as plain text (React escapes it; never HTML). */
export function FounderCasePage({ caseId }: { caseId: string }) {
  const { supabase } = useAuth();
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const [row, setRow] = useState<FounderCaseDetail | null | undefined>(undefined);
  const [conversation, setConversation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [c, m] = await Promise.all([
        supabase.from('cases').select('id, reference, product_service, lead_source, estimated_value, last_interaction_date, client_context, workflow_state, evidence_version, created_at, queued_at, conversation_source, businesses(name, currency)')
          .eq('id', caseId).maybeSingle(),
        supabase.from('case_messages').select('body').eq('case_id', caseId).eq('kind', 'PASTED_CONVERSATION').order('created_at').limit(1),
      ]);
      if (!active) return;
      if (c.error || m.error) {
        setError('Could not load this case.');
        return;
      }
      setRow((c.data as unknown as FounderCaseDetail | null) ?? null);
      setConversation(((m.data ?? []) as { body: string }[])[0]?.body ?? null);
    })();
    return () => {
      active = false;
    };
  }, [supabase, caseId, reload]);

  const back = () => navigate('/app/founder');
  return (
    <Shell>
      <ScreenHeader title={row ? `${row.reference} — ${row.product_service}` : 'Case'} subtitle={row?.businesses?.name} onBack={back} backLabel="Founder workspace" />
      <ErrorBanner message={error} />
      {row === undefined && !error && <p className="muted" role="status">Loading…</p>}
      {row === null && <EmptyState title="Case not found." />}
      {row && (
        <>
          <Card title="Details">
            <dl className="kv" data-testid="founder-case-details">
              <div><dt>Status</dt><dd>{founderStateLabel(row.workflow_state)}</dd></div>
              <div><dt>Lead source</dt><dd>{row.lead_source}</dd></div>
              <div><dt>Estimated value</dt><dd>{row.estimated_value == null ? '—' : `${row.businesses?.currency ?? ''} ${Number(row.estimated_value).toLocaleString('en')}`}</dd></div>
              <div><dt>Last contact</dt><dd>{formatDate(row.last_interaction_date)}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(row.created_at, true)}</dd></div>
              <div><dt>Submitted</dt><dd>{formatDate(row.queued_at, true)}</dd></div>
              <div><dt>Evidence version</dt><dd>{row.evidence_version}</dd></div>
            </dl>
          </Card>
          {row.client_context && (
            <Card title="Client context">
              <p className="message-card faded" data-testid="founder-case-context">{row.client_context}</p>
            </Card>
          )}
          {row.conversation_source === 'SCREENSHOTS' ? (
            <Card title="Screenshots">
              <FounderScreenshots caseId={row.id} />
            </Card>
          ) : (
            <Card title="Pasted conversation">
              {conversation === null ? <EmptyState title="No pasted conversation." /> : <pre className="message-card prospect" data-testid="case-conversation">{conversation}</pre>}
            </Card>
          )}
          <FounderRunAnalysis caseId={row.id} workflowState={row.workflow_state} onDone={refresh} />
          <FounderAnalysis key={`analysis-${reload}`} caseId={row.id} evidenceVersion={row.evidence_version} />
          {row.workflow_state === 'AWAITING_ADMIN_REVIEW' && <FounderDecision key={`decision-${reload}`} caseId={row.id} evidenceVersion={row.evidence_version} onDone={refresh} />}
          <FounderCaseTimeline key={`timeline-${reload}`} caseId={row.id} currency={row.businesses?.currency ?? 'NGN'} />
        </>
      )}
    </Shell>
  );
}

interface ClientRow { id: string; reference: string; product_service: string; status: string }

export function ClientWorkspace() {
  const { supabase, profile } = useAuth();
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [shotDrafts, setShotDrafts] = useState<Record<string, string>>({}); // draft id -> summary label
  const [resuming, setResuming] = useState<string | null>(null);
  const seq = useRef(0);

  // Client-safe projection only (server-side function); clients cannot read case tables directly.
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const { data, error: err } = await supabase.rpc('client_list_cases');
    if (mine !== seq.current) return;
    if (err) setError('Could not load your cases.');
    else {
      setError(null);
      const list = ((data ?? []) as ClientRow[]).map(({ id, reference, product_service, status }) => ({ id, reference, product_service, status }));
      setRows(list);
      // Drafts: screenshot drafts are continued, not just submitted.
      const found: Record<string, string> = {};
      for (const r of list.filter((x) => x.status === 'DRAFT')) {
        const st = await fetchStatus(supabase, r.id);
        if ('error' in st || st.status.source !== 'SCREENSHOTS') continue;
        const sum = summarizeStatus(st.status);
        found[r.id] = sum.unusable ? 'Draft — cannot be completed (conflicting screenshots)' : `Draft — upload incomplete (${sum.uploaded.length} saved)`;
      }
      if (mine !== seq.current) return;
      setShotDrafts(found);
      let saved: string | null = null;
      try { saved = localStorage.getItem(DRAFT_KEY); } catch { /* ignore */ }
      if (saved && found[saved]) setResuming((cur) => cur ?? saved);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const submitDraft = async (id: string) => {
    setRowError(null);
    setSubmitting(id);
    const { error: err } = await supabase.rpc('client_submit_case', { p_case_id: id });
    if (err && !isAlreadySubmitted(err)) setRowError(caseErrorMessage(err));
    await load();
    setSubmitting(null);
  };

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
              <span>
                <span className="list-title">{r.reference} — {r.product_service}</span>
                <span className="muted small" data-testid="client-case-status">{shotDrafts[r.id] ?? clientStatusLabel(r.status)}</span>
              </span>
              {r.status === 'DRAFT' && shotDrafts[r.id] && (
                <Button small variant="secondary" onClick={() => setResuming(resuming === r.id ? null : r.id)}>{resuming === r.id ? 'Close' : 'Continue'}</Button>
              )}
              {r.status !== 'DRAFT' && (
                <Button small variant={r.status === 'ACTION_REQUIRED' ? 'primary' : 'secondary'} onClick={() => navigate(`/app/client/case/${r.id}`)}>Open</Button>
              )}
              {r.status === 'DRAFT' && !shotDrafts[r.id] && (
                <Button small onClick={() => void submitDraft(r.id)} disabled={submitting !== null}>{submitting === r.id ? 'Submitting…' : 'Submit'}</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorBanner message={rowError} />
      {resuming && rows?.some((r) => r.id === resuming) && (
        <ResumeDraft key={resuming} caseId={resuming} reference={rows.find((r) => r.id === resuming)!.reference}
          onDone={async () => { setResuming(null); await load(); }} />
      )}
      <NewCaseForm onSaved={load} />
    </Shell>
  );
}

/** The business's view of one case (client-safe projection only). */
export function ClientCaseRoute({ caseId }: { caseId: string }) {
  return (
    <Shell>
      <ClientCasePage caseId={caseId} />
    </Shell>
  );
}

const EMPTY_CASE = { reference: '', productService: '', leadSource: '', estimatedValue: '', lastInteractionDate: '', clientContext: '', conversation: '' };

function NewCaseForm({ onSaved }: { onSaved: () => Promise<void> }) {
  const { supabase } = useAuth();
  const [form, setForm] = useState(EMPTY_CASE);
  const [errors, setErrors] = useState<CaseErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One request ID per case being entered. Kept across retries so a repeated
  // tap or a retry after a dropped connection returns the same case.
  const requestId = useRef(newRequestId());
  const { profile } = useAuth();
  const [mode, setMode] = useState<'TEXT' | 'SCREENSHOTS'>('TEXT');
  const [shots, setShots] = useState<ProcessedShot[]>([]);
  const [shotStates, setShotStates] = useState<Record<string, ShotState>>({});
  const [startOver, setStartOver] = useState(false);
  const shotRequestId = useRef(newRequestId());
  const assigned = useRef(new Map<string, number>());
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  useEffect(() => () => releaseShots(shotsRef.current), []);

  const submitScreenshots = async () => {
    setError(null);
    setSuccess(null);
    const { value, errors: errs } = validateCase(form, undefined, 'SCREENSHOTS');
    setErrors(errs);
    if (!value) return;
    if (shots.length === 0) {
      setError(SHOT_MESSAGES.NONE);
      return;
    }
    if (!profile?.businessId) {
      setError(caseErrorMessage({ code: '42501' }));
      return;
    }
    setBusy(true);
    const created = await supabase.rpc('client_create_case', {
      p_idempotency_key: shotRequestId.current,
      p_reference: value.reference,
      p_product_service: value.productService,
      p_lead_source: value.leadSource,
      p_conversation_source: 'SCREENSHOTS',
      p_conversation_text: null,
      p_estimated_value: value.estimatedValue,
      p_last_interaction_date: value.lastInteractionDate,
      p_client_context: value.clientContext,
    });
    if (created.error || typeof created.data !== 'string') {
      setError(caseErrorMessage(created.error));
      setBusy(false);
      return;
    }
    try { localStorage.setItem(DRAFT_KEY, created.data); } catch { /* ignore */ }
    const r = await completeScreenshotCase(supabase, {
      businessId: profile.businessId, caseId: created.data, shots, assigned: assigned.current,
      onState: (id, st) => setShotStates((m) => ({ ...m, [id]: st })),
    });
    if (r.ok) {
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      setSuccess(`Case ${value.reference} submitted for review with ${shots.length} screenshot${shots.length === 1 ? '' : 's'}.`);
      releaseShots(shots);
      setShots([]);
      setShotStates({});
      setForm(EMPTY_CASE);
      setErrors({});
      setStartOver(false);
      shotRequestId.current = newRequestId();
      assigned.current = new Map();
    } else {
      setError(resultMessage(r));
      setStartOver(r.kind === 'conflict' || r.kind === 'invalid');
    }
    await onSaved();
    setBusy(false);
  };

  // A draft that can never be completed: keep the selected screenshots, start a fresh case.
  const startNewCase = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    shotRequestId.current = newRequestId();
    assigned.current = new Map();
    setShotStates({});
    setStartOver(false);
    setError(null);
  };
  const set = (k: keyof typeof EMPTY_CASE) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form
      className="card"
      noValidate
      aria-labelledby="new-case-title"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        if (mode === 'SCREENSHOTS') {
          await submitScreenshots();
          return;
        }
        setError(null);
        setSuccess(null);
        const { value, errors: errs } = validateCase(form);
        setErrors(errs);
        if (!value) return;
        setBusy(true);
        const created = await supabase.rpc('client_create_case', {
          p_idempotency_key: requestId.current,
          p_reference: value.reference,
          p_product_service: value.productService,
          p_lead_source: value.leadSource,
          p_conversation_source: 'TEXT',
          p_conversation_text: value.conversation,
          p_estimated_value: value.estimatedValue,
          p_last_interaction_date: value.lastInteractionDate,
          p_client_context: value.clientContext,
        });
        if (created.error || typeof created.data !== 'string') {
          setError(caseErrorMessage(created.error));
          setBusy(false);
          return;
        }
        const submitted = await supabase.rpc('client_submit_case', { p_case_id: created.data });
        if (submitted.error && !isAlreadySubmitted(submitted.error)) {
          setError(`Saved as a draft but not submitted: ${caseErrorMessage(submitted.error)} Tap “Submit Case” again, or use Submit in the list.`);
        } else {
          setSuccess(`Case ${value.reference} submitted for review.`);
          setForm(EMPTY_CASE);
          setErrors({});
          requestId.current = newRequestId();
        }
        await onSaved();
        setBusy(false);
      }}
    >
      <h2 className="card-title" id="new-case-title">New case</h2>
      <Notice tone="warn"><span data-testid="demo-submit-rule">{DEMO_RULE_SUBMIT}</span></Notice>
      <Field label="Reference" hint="Your own label, for example TEST-001." error={errors.reference}>
        {(id, d) => <input id={id} aria-describedby={d} maxLength={LIMITS.reference + 10} autoComplete="off" value={form.reference} onChange={set('reference')} />}
      </Field>
      <Field label="Product or service" error={errors.productService}>
        {(id, d) => <input id={id} aria-describedby={d} maxLength={LIMITS.product + 10} value={form.productService} onChange={set('productService')} />}
      </Field>
      <Field label="Lead source" error={errors.leadSource}>
        {(id, d) => (
          <select id={id} aria-describedby={d} value={form.leadSource} onChange={set('leadSource')}>
            <option value="">Choose…</option>
            {LEAD_SOURCES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
      </Field>
      <Field label="Estimated value" optional error={errors.estimatedValue}>
        {(id, d) => <input id={id} aria-describedby={d} inputMode="decimal" autoComplete="off" value={form.estimatedValue} onChange={set('estimatedValue')} />}
      </Field>
      <Field label="Last contact date" optional error={errors.lastInteractionDate}>
        {(id, d) => <input id={id} aria-describedby={d} type="date" value={form.lastInteractionDate} onChange={set('lastInteractionDate')} />}
      </Field>
      <Field label="Context for the reviewer" optional error={errors.clientContext}>
        {(id, d) => <textarea id={id} aria-describedby={d} rows={3} value={form.clientContext} onChange={set('clientContext')} />}
      </Field>
      <div className="mode-toggle" role="group" aria-label="How will you share the conversation?">
        <button type="button" className={`btn btn-small ${mode === 'TEXT' ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={mode === 'TEXT'} disabled={busy} onClick={() => setMode('TEXT')}>Paste conversation</button>
        <button type="button" className={`btn btn-small ${mode === 'SCREENSHOTS' ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={mode === 'SCREENSHOTS'} disabled={busy} onClick={() => setMode('SCREENSHOTS')}>Upload screenshots</button>
      </div>
      {mode === 'TEXT' ? (
        <Field label="Pasted conversation" hint="Paste a sample WhatsApp conversation, oldest message first. No real customer chats." error={errors.conversation}>
          {(id, d) => <textarea id={id} aria-describedby={d} rows={8} value={form.conversation} onChange={set('conversation')} />}
        </Field>
      ) : (
        <>
          <Notice tone="warn">Sample screenshots only — never a real customer’s conversation.</Notice>
          <ScreenshotPicker shots={shots} onChange={setShots} states={shotStates} locked={busy || assigned.current.size > 0} />
        </>
      )}
      <ErrorBanner message={error} />
      <SuccessNote message={success} />
      {mode === 'SCREENSHOTS' && startOver && (
        <Button block variant="secondary" onClick={startNewCase} disabled={busy}>Start a New Case With These Screenshots</Button>
      )}
      <p className="muted small submit-reminder">{DEMO_RULE_SHORT}</p>
      <Button type="submit" block disabled={busy || (mode === 'SCREENSHOTS' && startOver)}>
        {busy ? 'Submitting…' : mode === 'SCREENSHOTS' && assigned.current.size > 0 ? 'Retry' : 'Submit Case'}
      </Button>
    </form>
  );
}
