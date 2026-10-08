// C01 — visual login for workflow testing. No authentication happens here.

import { useState } from 'react';
import { Button, Field, Notice } from '../components/ui';
import { navigate } from '../router';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="screen narrow login">
      <div className="login-brand">
        <span className="brand-mark" aria-hidden="true">R</span>
        <div>
          <p className="brand-name">Revenue Recovery</p>
          <p className="brand-sub">Stalled deal review</p>
        </div>
      </div>

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          setNote('Sign-in is not available in the Stage-1 prototype. Use “Enter Client Demo” below.');
        }}
      >
        <h1 className="card-title">Sign in</h1>
        <Field label="Email">
          {(id) => <input id={id} type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Password">
          {(id) => <input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" block>Sign In</Button>
        {note && <Notice tone="warn">{note}</Notice>}
      </form>

      <div className="card demo-entry">
        <p className="demo-entry-tag">Stage-1 prototype</p>
        <p className="muted">No real authentication. Choose a demo view to test the workflow.</p>
        <Button block onClick={() => navigate({ name: 'client-dashboard' })}>Enter Client Demo</Button>
        <Button block variant="secondary" onClick={() => navigate({ name: 'admin-home' })}>Enter Admin Demo</Button>
      </div>
    </div>
  );
}
