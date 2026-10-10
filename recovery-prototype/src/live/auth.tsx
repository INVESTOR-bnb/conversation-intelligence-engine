// Authentication state for the live app.
//
// Trust model:
//   * The session comes from Supabase Auth (stored by supabase-js).
//   * The ROLE comes only from the server-side function public.whoami(),
//     which reads the founders / business_members tables. Nothing the browser
//     holds (user metadata, storage, URL) can grant a role.
//   * If the role cannot be verified, access is denied (fail closed).
//   * UI route guards are convenience only; data access is enforced by RLS
//     and the guarded database functions.

import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CALLBACK_MESSAGES, type CallbackResult } from './authCallback';
import { AUTH_STORAGE_KEY } from './supabase';

export type Role = 'FOUNDER' | 'CLIENT' | 'NONE';

export interface Profile {
  userId: string;
  email: string | null;
  role: Role;
  businessName?: string;
  businessId?: string;
}

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  supabase: SupabaseClient;
  status: Status;
  session: Session | null;
  profile: Profile | null;
  profileError: string | null;
  passwordSetupRequired: boolean;
  /** Reads the setup flag from storage (authoritative, no render lag). */
  isPasswordSetupRequired: () => boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  completeCallback: (result: CallbackResult) => Promise<{ error: string | null; needsPassword: boolean }>;
  setPassword: (password: string) => Promise<string | null>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);
const SETUP_KEY = 'rre-password-setup-required';

function readSetupFlag(userId: string | undefined) {
  try {
    return !!userId && localStorage.getItem(SETUP_KEY) === userId;
  } catch {
    return false;
  }
}

export function friendlyAuthError(err: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'You appear to be offline. Check your connection and try again.';
  }
  const e = err as { code?: string; status?: number; message?: string; name?: string } | null;
  const code = e?.code ?? '';
  switch (code) {
    case 'invalid_credentials':
      return 'Email or password is incorrect.';
    case 'email_not_confirmed':
      return 'This email address has not been confirmed yet. Open your invitation email first.';
    case 'user_banned':
      return 'This account is disabled. Contact the founder.';
    case 'weak_password':
      return 'That password is too weak. Use a longer password with a mix of words, numbers and symbols.';
    case 'same_password':
      return 'Choose a password different from your current one.';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'session_not_found':
    case 'session_expired':
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
    case 'bad_jwt':
      return CALLBACK_MESSAGES.INVALID;
  }
  if (e?.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
  if (e?.name === 'AuthRetryableFetchError' || e?.message === 'Failed to fetch' || e?.name === 'TypeError') {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

export function AuthProvider({ supabase, children }: { supabase: SupabaseClient; children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordSetupRequired, setPasswordSetupRequired] = useState(false);
  const loadSeq = useRef(0);

  // Server-side authorization lookup. Never derived from client-side data.
  const loadProfile = useCallback(
    async (s: Session | null) => {
      const seq = ++loadSeq.current;
      if (!s) {
        setProfile(null);
        setProfileError(null);
        return;
      }
      const { data, error } = await supabase.rpc('whoami');
      if (seq !== loadSeq.current) return;
      const role = (data as { role?: string } | null)?.role;
      if (error || (role !== 'FOUNDER' && role !== 'CLIENT' && role !== 'NONE')) {
        setProfile(null);
        setProfileError('Your access could not be verified. Check your connection and reload the page.');
        return;
      }
      setProfileError(null);
      setProfile({
        userId: s.user.id,
        email: s.user.email ?? null,
        role: role as Role,
        businessName: (data as { business_name?: string }).business_name,
        businessId: (data as { business_id?: string }).business_id,
      });
    },
    [supabase],
  );

  const apply = useCallback(
    async (s: Session | null) => {
      setSession(s);
      setPasswordSetupRequired(readSetupFlag(s?.user.id));
      setStatus(s ? 'signedIn' : 'signedOut');
      await loadProfile(s);
    },
    [loadProfile],
  );

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) void apply(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!active) return;
      if (event === 'SIGNED_OUT') {
        void apply(null);
      } else if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        setSession(s);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase, apply]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error || !data.session) return friendlyAuthError(error);
      await apply(data.session);
      return null;
    },
    [supabase, apply],
  );

  const signOut = useCallback(async () => {
    try {
      localStorage.removeItem(SETUP_KEY);
    } catch {
      /* ignore */
    }
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    // Belt and braces: make sure no session remains in storage.
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    await apply(null);
  }, [supabase, apply]);

  const completeCallback = useCallback(
    async (result: CallbackResult) => {
      if (result.kind === 'error') return { error: result.message, needsPassword: false };
      if (result.kind === 'code') {
        // Invitations from the dashboard never use this flow; a code here can't be
        // completed safely on this device.
        return { error: CALLBACK_MESSAGES.INVALID, needsPassword: false };
      }
      if (result.kind !== 'session') return { error: 'No invitation details were found in this link.', needsPassword: false };
      // setSession validates the tokens with Supabase (it fetches the user or refreshes).
      const { data, error } = await supabase.auth.setSession({ access_token: result.accessToken, refresh_token: result.refreshToken });
      if (error || !data.session) return { error: CALLBACK_MESSAGES.INVALID, needsPassword: false };
      const needsPassword = result.linkType === 'invite' || result.linkType === 'recovery';
      if (needsPassword) {
        try {
          localStorage.setItem(SETUP_KEY, data.session.user.id);
        } catch {
          /* ignore */
        }
      }
      await apply(data.session);
      return { error: null, needsPassword };
    },
    [supabase, apply],
  );

  const setPassword = useCallback(
    async (password: string) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) return friendlyAuthError(error);
      try {
        localStorage.removeItem(SETUP_KEY);
      } catch {
        /* ignore */
      }
      setPasswordSetupRequired(false);
      return null;
    },
    [supabase],
  );

  const refreshProfile = useCallback(() => loadProfile(session), [loadProfile, session]);
  const isPasswordSetupRequired = useCallback(() => readSetupFlag(session?.user.id), [session]);

  const value = useMemo(
    () => ({ supabase, status, session, profile, profileError, passwordSetupRequired, isPasswordSetupRequired, signIn, signOut, completeCallback, setPassword, refreshProfile }),
    [supabase, status, session, profile, profileError, passwordSetupRequired, isPasswordSetupRequired, signIn, signOut, completeCallback, setPassword, refreshProfile],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
