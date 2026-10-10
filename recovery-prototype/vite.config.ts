import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Emits Cloudflare Pages' `_headers` file with security headers. The CSP only
// allows network connections to this origin and the configured Supabase project.
function securityHeaders(supabaseUrl: string | undefined): Plugin {
  let origin = '';
  if (supabaseUrl) {
    try {
      const u = new URL(supabaseUrl);
      if (u.protocol === 'https:') origin = u.origin;
    } catch {
      /* invalid URL: the app itself refuses to start (see src/live/config.ts) */
    }
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // React inline style attributes
    "img-src 'self' data: blob:", // local screenshot previews
    `connect-src 'self'${origin ? ` ${origin}` : ''}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const body = [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  X-Frame-Options: DENY',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
    '  Strict-Transport-Security: max-age=31536000',
    '',
  ].join('\n');
  return {
    name: 'rre-security-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: body });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Includes VITE_* variables from the process environment (e.g. Cloudflare Pages settings).
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    plugins: [react(), securityHeaders(env.VITE_SUPABASE_URL)],
    // Absolute base: deep links such as /auth/callback must load /assets/*.
    // (For a relative static copy of the Stage-1 demo use: npm run build -- --base ./)
    base: '/',
  };
});
