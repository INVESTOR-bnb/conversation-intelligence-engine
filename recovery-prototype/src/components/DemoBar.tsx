// Stage-1 prototype control. NOT authentication — it only switches demo views.

import { useState } from 'react';
import { navigate } from '../router';
import { useStore } from '../state/store';

export function DemoBar({ role }: { role: 'client' | 'admin' | 'none' }) {
  const { data, reset, setDemoClient } = useStore();
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="demobar" role="region" aria-label="Stage-1 prototype controls">
      <div className="demobar-row">
        <span className="demobar-tag">Stage-1 prototype</span>
        <div className="seg" role="group" aria-label="Demo role">
          <button type="button" aria-pressed={role === 'client'} className={role === 'client' ? 'on' : ''} onClick={() => navigate({ name: 'client-dashboard' })}>
            Client Demo
          </button>
          <button type="button" aria-pressed={role === 'admin'} className={role === 'admin' ? 'on' : ''} onClick={() => navigate({ name: 'admin-home' })}>
            Admin Demo
          </button>
        </div>
        <button type="button" className="demobar-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Options'}
        </button>
      </div>
      {open && (
        <div className="demobar-panel">
          <label className="demobar-field">
            <span>Client Demo views as</span>
            <select
              value={data.demoClientId}
              onChange={(e) => {
                setDemoClient(e.target.value);
                if (role === 'client') navigate({ name: 'client-dashboard' });
              }}
            >
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>{c.businessName}</option>
              ))}
            </select>
          </label>
          {confirmReset ? (
            <div className="demobar-confirm">
              <span>Discard all demo changes and restore the original mock cases?</span>
              <div className="btn-row">
                <button type="button" className="btn btn-danger btn-small" onClick={() => { reset(); setConfirmReset(false); setOpen(false); navigate({ name: role === 'admin' ? 'admin-home' : 'client-dashboard' }); }}>
                  Reset
                </button>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => setConfirmReset(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirmReset(true)}>Reset Demo Data</button>
          )}
          <p className="demobar-note">Prototype navigation only. There is no real login; data lives in this browser’s local storage.</p>
        </div>
      )}
    </div>
  );
}
