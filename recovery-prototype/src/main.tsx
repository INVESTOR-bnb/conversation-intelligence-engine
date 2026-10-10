import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './live/auth';
import { readLiveConfig } from './live/config';
import { LiveApp } from './live/LiveApp';
import { getSupabase } from './live/supabase';
import { StoreProvider } from './state/store';
import './styles.css';

const live = readLiveConfig(import.meta.env);
const root = createRoot(document.getElementById('root') as HTMLElement);

if (live.status === 'unconfigured') {
  // No Supabase configuration: the Stage-1 prototype exactly as before.
  root.render(
    <StrictMode>
      <StoreProvider>
        <App />
      </StoreProvider>
    </StrictMode>,
  );
} else if (live.status === 'invalid') {
  // Fail closed: never run with a missing, malformed or secret key.
  root.render(
    <main className="main">
      <div className="screen narrow">
        <div className="banner banner-error" role="alert">
          This deployment is misconfigured and has been stopped for safety: {live.reason}.
        </div>
      </div>
    </main>,
  );
} else {
  root.render(
    <StrictMode>
      <AuthProvider supabase={getSupabase(live.config)}>
        <LiveApp />
      </AuthProvider>
    </StrictMode>,
  );
}
