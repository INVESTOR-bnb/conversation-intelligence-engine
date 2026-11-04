// WhatsApp integration (PREVIEW, isolated environment only): the owner's page and the founder's
// diagnostics. Nothing here decides access: every call is checked by the database or the
// `whatsapp` Edge Function. The owner never sees analysis; the founder's tools stay founder-only.

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ConfirmBox, EmptyState, ErrorBanner, Field, Notice, ScreenHeader } from '../components/ui';
import { useAuth } from './auth';
import { navigate } from './router';
import {
  actionMessage, continueInWhatsApp, STATUS_LABEL, validateAuthorization, WA_SCOPE_POINTS, WA_TERMS_VERSION,
  type WaAuthorization, type WaAuthorizationErrors, type WaStatus,
} from './whatsapp';

interface WaClientStatus {
  status: WaStatus; action_code: string | null; number_last4: string | null;
  history: { status: string; progress: number | null; oldest: string | null; newest: string | null; kept: number; discarded: number };
  authorization: null | { send_mode: string; history_months: number; max_sends_per_day: number; max_followups_per_contact: number; spend_limit_usd: number; reopen_template_text: string | null };
  counts: { conversations_reviewed: number; followups_sent: number; replies_received: number; waiting_for_permission: number };
}
interface WaContact { id: string; number: string; permission: string; taken_over: boolean; evidence_incomplete: boolean; last_message_at: string | null; case_status: string | null }

declare global { interface Window { FB?: { init: (o: object) => void; login: (cb: (r: { authResponse?: { code?: string } }) => void, o: object) => void }; fbAsyncInit?: () => void } }

/** Meta's official Embedded Signup, WhatsApp Business app onboarding flow. Resolves with the code and the ids Meta reports. */
function metaSignup(appId: string, configId: string): Promise<{ code: string; phoneNumberId: string; wabaId: string } | null> {
  return new Promise((resolve) => {
    let ids: { phoneNumberId: string; wabaId: string } | null = null;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
      let data: { type?: string; event?: string; data?: { phone_number_id?: string; waba_id?: string } };
      try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
      if (data?.type === 'WA_EMBEDDED_SIGNUP' && typeof data.event === 'string' && data.event.startsWith('FINISH') && data.data) {
        ids = { phoneNumberId: String(data.data.phone_number_id ?? ''), wabaId: String(data.data.waba_id ?? '') };
      }
    };
    window.addEventListener('message', onMessage);
    const start = () => window.FB!.login(async (r) => {
      const code = r?.authResponse?.code;
      for (let i = 0; i < 20 && !ids; i++) await new Promise((t) => setTimeout(t, 250));
      window.removeEventListener('message', onMessage);
      resolve(code && ids?.phoneNumberId && ids.wabaId ? { code, ...ids } : null);
    }, { config_id: configId, response_type: 'code', override_default_response_type: true,
         extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' } });
    if (window.FB) { start(); return; }
    window.fbAsyncInit = () => { window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: 'v25.0' }); start(); };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js'; s.async = true; s.crossOrigin = 'anonymous';
    s.onerror = () => { window.removeEventListener('message', onMessage); resolve(null); };
    document.head.appendChild(s);
  });
}

const EMPTY_AUTH: WaAuthorization = { historyMonths: 3, sendMode: 'AUTOMATIC', maxSendsPerDay: 10, maxFollowupsPerContact: 2, spendLimitUsd: 2,
  reopenTemplate: '', reopenTemplateLang: 'en', reopenTemplateText: '' };

export function ClientWhatsAppPage() {
  const { supabase } = useAuth();
  const [st, setSt] = useState<WaClientStatus | null>(null);
  const [contacts, setContacts] = useState<WaContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState<WaAuthorization>(EMPTY_AUTH);
  const [authErrors, setAuthErrors] = useState<WaAuthorizationErrors>({});
  const [agree, setAgree] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([supabase.rpc('client_wa_status'), supabase.rpc('client_wa_contacts')]);
    if (s.error) { setError('Could not load your WhatsApp status.'); return; }
    setSt(s.data as WaClientStatus);
    setContacts((c.data ?? []) as WaContact[]);
  }, [supabase]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<{ error: unknown }>) => {
    setBusy(true); setError(null);
    const r = await fn();
    setBusy(false);
    if (r.error) setError((r.error as { message?: string }).message?.replace(/^[A-Z_]+: /, '') ?? 'That did not work.');
    await load();
  };

  const connect = async () => {
    setBusy(true); setError(null);
    const appId = import.meta.env.VITE_WA_APP_ID ?? ''; const configId = import.meta.env.VITE_WA_ES_CONFIG_ID ?? '';
    const r = await metaSignup(appId, configId);
    if (!r) { setBusy(false); setError('Meta sign-up did not complete. Nothing was connected.'); return; }
    const { error: err } = await supabase.functions.invoke('whatsapp/connect', { body: { code: r.code, phone_number_id: r.phoneNumberId, waba_id: r.wabaId } });
    setBusy(false);
    if (err) setError('Connecting did not finish. See the status below.');
    await load();
  };

  const saveAuth = () => {
    const e = validateAuthorization(auth);
    setAuthErrors(e);
    if (Object.keys(e).length || !agree) return;
    void act(async () => supabase.rpc('client_wa_authorize', {
      p_terms_version: WA_TERMS_VERSION, p_history_months: auth.historyMonths, p_send_mode: auth.sendMode, p_max_sends_per_day: auth.maxSendsPerDay,
      p_max_followups_per_contact: auth.maxFollowupsPerContact, p_spend_limit_usd: auth.spendLimitUsd,
      p_reopen_template: auth.reopenTemplate || null, p_reopen_template_lang: auth.reopenTemplate ? auth.reopenTemplateLang : null,
      p_reopen_template_text: auth.reopenTemplate ? auth.reopenTemplateText : null }));
  };

  const connected = st && st.status !== 'DISCONNECTED';
  return (
    <>
      <ScreenHeader title="WhatsApp (preview)" subtitle={st ? STATUS_LABEL[st.status] : undefined} onBack={() => navigate('/app/client')} backLabel="Your cases" />
      <ErrorBanner message={error} />
      {st === null && !error && <p className="muted" role="status">Loading…</p>}
      {st?.status === 'ACTION_REQUIRED' && <Notice tone="warn"><span data-testid="wa-action">{actionMessage(st.action_code)}</span></Notice>}

      <Card title="What RRE does with your WhatsApp">
        <ul data-testid="wa-scope">{WA_SCOPE_POINTS.map((p) => <li key={p}>{p}</li>)}</ul>
      </Card>

      {st && !connected && (
        <Card title="Connect WhatsApp">
          <p className="muted small">Use your existing WhatsApp Business app number. You keep using the app as usual; nothing is deleted or moved.</p>
          {!st.authorization && <p className="muted small" data-testid="wa-authorize-first">First save your recovery settings below. RRE requests your chat history only after you have authorized it.</p>}
          <Button block disabled={busy || !st.authorization} onClick={() => void connect()}>Connect WhatsApp</Button>
        </Card>
      )}

      {st && connected && (
        <Card title="Status">
          <div data-testid="wa-status">
            <p><strong>{STATUS_LABEL[st.status]}</strong>{st.number_last4 ? ` · number ending ${st.number_last4}` : ''}</p>
            <p className="muted small">Chat history: {st.history.status === 'DECLINED' ? 'not shared (you chose not to share it)'
              : st.history.status === 'COMPLETE' ? `received — ${st.history.kept} message(s) from ${st.history.oldest?.slice(0, 10) ?? '—'} to ${st.history.newest?.slice(0, 10) ?? '—'} kept within your chosen period${st.history.discarded ? `, ${st.history.discarded} older discarded` : ''}`
              : st.history.status === 'NOT_REQUESTED' ? 'not requested' : `arriving${st.history.progress != null ? ` (${st.history.progress}%)` : ''}`}</p>
            <ul className="muted small">
              <li>Conversations reviewed: {st.counts.conversations_reviewed}</li>
              <li>Follow-ups sent: {st.counts.followups_sent}</li>
              <li>Replies received: {st.counts.replies_received}</li>
              <li>Waiting for your permission: {st.counts.waiting_for_permission}</li>
            </ul>
            {(st.status === 'CONNECTED' || st.status === 'PAUSED') && (
              <Button block variant={st.status === 'PAUSED' ? 'primary' : 'secondary'} disabled={busy}
                onClick={() => void act(async () => supabase.rpc('client_wa_pause', { p_paused: st.status !== 'PAUSED' }))}>
                {st.status === 'PAUSED' ? 'Resume recovery' : 'Pause recovery now'}
              </Button>
            )}
            {!confirmDisconnect
              ? <button type="button" className="text-link" onClick={() => setConfirmDisconnect(true)}>Disconnect WhatsApp</button>
              : <ConfirmBox title="Disconnect WhatsApp from RRE?" body={<p className="muted small">RRE stops sending and deletes its access. Your WhatsApp app and chats are not affected.</p>}
                  confirmLabel="Disconnect" onConfirm={() => { setConfirmDisconnect(false); void act(async () => supabase.functions.invoke('whatsapp/disconnect', { body: {} })); }}
                  onCancel={() => setConfirmDisconnect(false)} />}
          </div>
        </Card>
      )}

      {st && (
        <Card title={st.authorization ? 'Your recovery settings' : 'Authorize recovery'}>
          {st.authorization && (
            <p className="muted small" data-testid="wa-auth-current">
              {st.authorization.send_mode === 'AUTOMATIC' ? 'RRE sends approved follow-ups for you' : 'You send follow-ups yourself'} · last {st.authorization.history_months} month(s) ·
              up to {st.authorization.max_sends_per_day}/day · {st.authorization.max_followups_per_contact} per person · spending limit USD {st.authorization.spend_limit_usd}
            </p>
          )}
          <Field label="Chat history RRE may use (months)">{(id) => <input id={id} type="number" min={1} max={6} value={auth.historyMonths} onChange={(e) => setAuth({ ...auth, historyMonths: Number(e.target.value) })} />}</Field>
          {authErrors.historyMonths && <p className="error-text">{authErrors.historyMonths}</p>}
          <Field label="Who sends follow-ups">{(id) => (
            <select id={id} value={auth.sendMode} onChange={(e) => setAuth({ ...auth, sendMode: e.target.value as WaAuthorization['sendMode'] })}>
              <option value="AUTOMATIC">RRE sends approved follow-ups from my number</option><option value="OWNER_SENDS">I send them myself</option>
            </select>)}</Field>
          <Field label="Most follow-ups per day">{(id) => <input id={id} type="number" min={1} max={50} value={auth.maxSendsPerDay} onChange={(e) => setAuth({ ...auth, maxSendsPerDay: Number(e.target.value) })} />}</Field>
          <Field label="Most follow-ups per person">{(id) => <input id={id} type="number" min={1} max={2} value={auth.maxFollowupsPerContact} onChange={(e) => setAuth({ ...auth, maxFollowupsPerContact: Number(e.target.value) })} />}</Field>
          <Field label="WhatsApp message spending limit (USD, estimated)">{(id) => <input id={id} type="number" min={0} max={50} step={0.5} value={auth.spendLimitUsd} onChange={(e) => setAuth({ ...auth, spendLimitUsd: Number(e.target.value) })} />}</Field>
          {authErrors.spendLimitUsd && <p className="error-text">{authErrors.spendLimitUsd}</p>}
          <Field label="Approved reopening template name (from WhatsApp Manager)" optional>{(id) => <input id={id} value={auth.reopenTemplate} onChange={(e) => setAuth({ ...auth, reopenTemplate: e.target.value.trim() })} />}</Field>
          {authErrors.reopenTemplate && <p className="error-text">{authErrors.reopenTemplate}</p>}
          <Field label="Template language" optional>{(id) => <input id={id} value={auth.reopenTemplateLang} onChange={(e) => setAuth({ ...auth, reopenTemplateLang: e.target.value.trim() })} />}</Field>
          <Field label="The template's exact approved text" optional>{(id) => <textarea id={id} rows={3} value={auth.reopenTemplateText} onChange={(e) => setAuth({ ...auth, reopenTemplateText: e.target.value })} />}</Field>
          {authErrors.reopenTemplateText && <p className="error-text">{authErrors.reopenTemplateText}</p>}
          <p className="muted small">Without an approved template RRE cannot reopen older chats; it can only reply when a customer writes within the last 24 hours.</p>
          <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I authorize RRE to act as described above, within these limits.</label>
          <Button block disabled={busy || !agree} onClick={saveAuth}>Save authorization</Button>
        </Card>
      )}

      {st && connected && (
        <Card title="Conversations">
          {contacts.length === 0 ? <EmptyState title="No imported conversations yet." /> : (
            <ul className="list" data-testid="wa-contacts">
              {contacts.map((c) => (
                <li key={c.id} className="list-row">
                  <span>
                    <span className="list-title">{c.number}</span>
                    <span className="muted small">{c.permission === 'OPTED_IN' ? 'May be contacted' : c.permission === 'OPTED_OUT' ? 'Do not contact' : 'Permission not recorded — RRE will not message'}
                      {c.taken_over ? ' · you are handling this' : ''}{c.evidence_incomplete ? ' · some messages unreadable: no automatic follow-up' : ''}</span>
                  </span>
                  {c.permission === 'UNKNOWN' && (
                    <span>
                      <input aria-label={`How ${c.number} agreed`} placeholder="How did they agree?" value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
                      <Button small disabled={busy} onClick={() => void act(async () => supabase.rpc('client_wa_set_permission', { p_contact_id: c.id, p_opted_in: true, p_note: notes[c.id] ?? '' }))}>Agreed</Button>
                    </span>
                  )}
                  {!c.taken_over && <Button small variant="secondary" disabled={busy} onClick={() => void act(async () => supabase.rpc('client_wa_takeover', { p_contact_id: c.id }))}>I’ll handle it</Button>}
                  <a className="text-link" href={continueInWhatsApp(c.number)} target="_blank" rel="noopener noreferrer">Open in WhatsApp</a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}

export function FounderWhatsAppPage() {
  const { supabase } = useAuth();
  const [o, setO] = useState<{ sending_enabled: boolean; businesses: { business: string; status: string; action_code: string | null; history_status: string; sends: Record<string, number>; unknown_sends: { send_id: string; kind: string; detail: string | null }[] }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await supabase.rpc('founder_wa_overview');
    if (r.error) setError('Could not load WhatsApp diagnostics.'); else setO(r.data);
  }, [supabase]);
  useEffect(() => { void load(); }, [load]);
  const call = async (fn: string, args: Record<string, unknown>) => { const r = await supabase.rpc(fn, args); if (r.error) setError(r.error.message); await load(); };
  return (
    <>
      <ScreenHeader title="WhatsApp diagnostics (preview)" onBack={() => navigate('/app/founder')} backLabel="Founder workspace" />
      <ErrorBanner message={error} />
      {o && (
        <div data-testid="wa-founder">
          <Card title="Integration sending switch">
            <p>{o.sending_enabled ? 'ON — eligible approved follow-ups are sent' : 'OFF — nothing is sent'}</p>
            <Button block variant={o.sending_enabled ? 'secondary' : 'primary'} onClick={() => void call('founder_wa_set_sending', { p_enabled: !o.sending_enabled })}>
              {o.sending_enabled ? 'Turn sending OFF' : 'Turn sending ON'}
            </Button>
          </Card>
          {o.businesses.map((b) => (
            <Card key={b.business} title={b.business}>
              <p className="muted small">{b.status}{b.action_code ? ` (${b.action_code})` : ''} · history {b.history_status} · sends {JSON.stringify(b.sends)}</p>
              {b.unknown_sends.map((u) => (
                <div key={u.send_id} className="stack-sm">
                  <p className="warn-text">Unconfirmed send ({u.kind}, {u.detail}). Check the owner’s WhatsApp app, then:</p>
                  <Button small onClick={() => void call('founder_wa_resolve_unknown', { p_send_id: u.send_id, p_was_sent: true, p_wamid: '' })}>It was sent</Button>
                  <Button small variant="secondary" onClick={() => void call('founder_wa_resolve_unknown', { p_send_id: u.send_id, p_was_sent: false, p_wamid: '' })}>It was not sent</Button>
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
