import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { LiveConfig } from './config';

let client: SupabaseClient | null = null;

export const AUTH_STORAGE_KEY = 'rre-auth';

export function getSupabase(config: LiveConfig): SupabaseClient {
  if (!client) {
    client = createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true, // survives refresh and browser reopen
        autoRefreshToken: true,
        // Callbacks are parsed explicitly on /auth/callback (see authCallback.ts)
        // so tokens never interact with the Stage-1 hash router.
        detectSessionInUrl: false,
        flowType: 'implicit', // dashboard invitations use the implicit flow
        storageKey: AUTH_STORAGE_KEY,
      },
    });
  }
  return client;
}
