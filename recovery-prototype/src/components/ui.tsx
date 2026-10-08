// Shared presentational building blocks.

import { useEffect, useId, useState, type ReactNode } from 'react';
import { CLASSIFICATION_LABEL } from '../domain/labels';
import type { Classification } from '../domain/types';

export function Icon({ name, size = 18 }: { name: 'check' | 'question' | 'stop' | 'clock' | 'back' | 'copy' | 'plus' | 'send' | 'eye' | 'lock'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'check':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>;
    case 'question':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14" /><path d="M12 17h.01" /></svg>;
    case 'stop':
      return <svg {...common}><path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z" /><path d="M8 12h8" /></svg>;
    case 'clock':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case 'back':
      return <svg {...common}><path d="m15 18-6-6 6-6" /></svg>;
    case 'copy':
      return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>;
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'send':
      return <svg {...common}><path d="m4 12 16-8-6 16-2-7z" /></svg>;
    case 'eye':
      return <svg {...common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
    case 'lock':
      return <svg {...common}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
  }
}

const CLASS_ICON: Record<Classification, 'check' | 'question' | 'stop'> = { GREEN: 'check', YELLOW: 'question', RED: 'stop' };

/** Classification badge — always icon + colour name + text label, never colour alone. */
export function ClassificationBadge({ value, size = 'md', showLabel = true }: { value: Classification; size?: 'md' | 'lg'; showLabel?: boolean }) {
  return (
    <span className={`badge badge-${value.toLowerCase()} badge-${size}`}>
      <Icon name={CLASS_ICON[value]} size={size === 'lg' ? 22 : 16} />
      <span className="badge-code">{value}</span>
      {showLabel && <span className="badge-label">{CLASSIFICATION_LABEL[value]}</span>}
    </span>
  );
}

export function StatusPill({ tone, children }: { tone: 'neutral' | 'review' | 'waiting' | 'won' | 'closed' | 'info'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Card({ title, children, className = '', aside, tone }: { title?: ReactNode; children: ReactNode; className?: string; aside?: ReactNode; tone?: 'private' }) {
  return (
    <section className={`card ${tone === 'private' ? 'card-private' : ''} ${className}`}>
      {(title || aside) && (
        <header className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

type BtnProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  block?: boolean;
  small?: boolean;
};

export function Button({ children, onClick, variant = 'primary', type = 'button', disabled, block, small }: BtnProps) {
  return (
    <button type={type} className={`btn btn-${variant} ${block ? 'btn-block' : ''} ${small ? 'btn-small' : ''}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function ScreenHeader({ title, subtitle, onBack, backLabel = 'Back', right }: { title: ReactNode; subtitle?: ReactNode; onBack?: () => void; backLabel?: string; right?: ReactNode }) {
  return (
    <div className="screen-head">
      {onBack && (
        <button type="button" className="back-link" onClick={onBack}>
          <Icon name="back" size={18} /> {backLabel}
        </button>
      )}
      <div className="screen-head-row">
        <div>
          <h1 className="screen-title">{title}</h1>
          {subtitle && <p className="screen-subtitle">{subtitle}</p>}
        </div>
        {right}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, optional, children }: { label: string; hint?: ReactNode; error?: string | null; optional?: boolean; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${error ? 'field-error' : ''}`}>
      <label htmlFor={id} className="field-label">
        {label} {optional && <span className="optional">— optional</span>}
      </label>
      {hint && <p id={hintId} className="field-hint">{hint}</p>}
      {children(id, describedBy)}
      {error && <p id={errId} className="field-err" role="alert">{error}</p>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="banner banner-error" role="alert">{message}</div>;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'private' }) {
  return <div className={`banner banner-${tone}`}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Copy Message' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    // UI feedback reset only; not a workflow timer.
    const t = window.setTimeout(() => setState('idle'), 2500);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <>
      <button type="button" className={`btn btn-secondary btn-block ${state === 'copied' ? 'btn-success' : ''}`} onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} /> {state === 'copied' ? 'Copied' : label}
      </button>
      <span className="sr-only" aria-live="polite">{state === 'copied' ? 'Message copied to clipboard' : ''}</span>
      {state === 'failed' && <p className="field-err" role="alert">Copy is not supported here. Press and hold the message to select it.</p>}
    </>
  );
}

export function formatMoney(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString()}`;
  }
}

export function formatDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', withTime ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Simple in-flow confirmation block, used before final or destructive actions. */
export function ConfirmBox({ title, body, confirmLabel, onConfirm, onCancel, danger }: { title: string; body?: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean }) {
  return (
    <div className="confirm" role="group" aria-label={title}>
      <p className="confirm-title">{title}</p>
      {body && <div className="confirm-body">{body}</div>}
      <div className="btn-row">
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
