/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Supabase project URL, e.g. https://<project-ref>.supabase.co */
  readonly VITE_SUPABASE_URL?: string;
  /** Public (publishable / anon) key only. Never a secret or service-role key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Legacy name for the same public anon key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
