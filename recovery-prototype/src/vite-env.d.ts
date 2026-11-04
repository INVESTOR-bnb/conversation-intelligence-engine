/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Supabase project URL, e.g. https://<project-ref>.supabase.co */
  readonly VITE_SUPABASE_URL?: string;
  /** Public (publishable / anon) key only. Never a secret or service-role key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Legacy name for the same public anon key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** '1' only in the isolated WhatsApp preview build (never with the prototype's project). */
  readonly VITE_WHATSAPP_PREVIEW?: string;
  /** Public Meta app id and Embedded Signup configuration id (WhatsApp preview only; not secrets). */
  readonly VITE_WA_APP_ID?: string;
  readonly VITE_WA_ES_CONFIG_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
