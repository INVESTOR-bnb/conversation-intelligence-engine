// Screenshot picker (client), draft resume panel (client) and viewer (founder).

import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import { Button, ErrorBanner, Notice } from '../components/ui';
import { useAuth } from './auth';
import { caseErrorMessage } from './cases';
import { completeScreenshotCase, fetchStatus, type CompleteResult, type ShotState } from './screenshotUpload';
import {
  ACCEPT_ATTR, BUCKET, MAX_FILES, processScreenshot, SHOT_MESSAGES, ShotError, summarizeStatus,
  type ProcessedShot, type ScreenshotStatus,
} from './screenshots';

export function releaseShots(shots: ProcessedShot[]) {
  for (const s of shots) URL.revokeObjectURL(s.previewUrl);
}

const STATE_LABEL: Record<ShotState, string> = { waiting: '', uploading: 'Uploading…', saved: 'Saved', failed: 'Failed' };

/** Select, process (metadata removed), preview, reorder and remove screenshots before upload. */
export function ScreenshotPicker({ shots, onChange, max = MAX_FILES, states, locked }: {
  shots: ProcessedShot[]; onChange: (s: ProcessedShot[]) => void; max?: number; states?: Record<string, ShotState>; locked?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const addFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setBusy(true);
    const issues: string[] = [];
    const added: ProcessedShot[] = [];
    for (const file of Array.from(list)) {
      if (shots.length + added.length >= max) {
        issues.push(SHOT_MESSAGES.TOO_MANY);
        break;
      }
      try {
        added.push(await processScreenshot(file));
      } catch (e) {
        issues.push(`${file.name || 'A file'} ${e instanceof ShotError ? e.message : 'could not be processed'}.`);
      }
    }
    onChange([...shots, ...added]);
    setProblems(issues);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const move = (i: number, d: -1 | 1) => {
    const next = [...shots];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };

  return (
    <div className="uploader">
      <p className="field-label" id="shots-label">Conversation screenshots</p>
      <p className="field-hint" id="shots-hint">Oldest messages first. Up to {max} images, 5 MB each. Location and other hidden data are removed on this phone before upload.</p>
      <input ref={inputRef} id="shots-input" className="sr-only" type="file" accept={ACCEPT_ATTR} multiple
        aria-labelledby="shots-label" aria-describedby="shots-hint" data-testid="shots-input" onChange={(e) => void addFiles(e.target.files)} />
      {!locked && (
        <Button block variant={shots.length ? 'secondary' : 'primary'} onClick={() => inputRef.current?.click()} disabled={busy || shots.length >= max}>
          {busy ? 'Preparing screenshots…' : shots.length ? 'Add More Screenshots' : 'Select Screenshots'}
        </Button>
      )}
      <p className="shots-count" aria-live="polite">{shots.length === 0 ? 'No screenshots selected' : `${shots.length} screenshot${shots.length === 1 ? '' : 's'} selected`}</p>
      {shots.length > 0 && (
        <ol className="shots" aria-label="Selected screenshots, in order" data-testid="shots-list">
          {shots.map((s, i) => (
            <li key={s.id} className="shot">
              <span className="shot-num" aria-hidden="true">{i + 1}</span>
              <img src={s.previewUrl} alt={`Screenshot ${i + 1}`} />
              <span className="shot-name">{s.fileLabel}</span>
              {states?.[s.id] && <span className="shot-state" data-testid="shot-state">{STATE_LABEL[states[s.id]]}</span>}
              {!locked && (
                <span className="shot-actions">
                  <button type="button" className="shot-move" aria-label={`Move screenshot ${i + 1} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="shot-move" aria-label={`Move screenshot ${i + 1} later`} disabled={i === shots.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="shot-remove" aria-label={`Remove screenshot ${i + 1}`} onClick={() => { URL.revokeObjectURL(s.previewUrl); onChange(shots.filter((x) => x.id !== s.id)); }}>Remove</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {problems.length > 0 && <div className="banner banner-warn" role="alert">{problems.map((p, i) => <p key={i}>{p}</p>)}</div>}
    </div>
  );
}

export function resultMessage(r: Exclude<CompleteResult, { ok: true }>): string {
  switch (r.kind) {
    case 'upload': return SHOT_MESSAGES.UPLOAD_FAILED;
    case 'conflict':
    case 'invalid': return SHOT_MESSAGES.CONFLICT;
    case 'gaps': return SHOT_MESSAGES.GAPS;
    case 'none': return SHOT_MESSAGES.NONE;
    case 'too_many': return SHOT_MESSAGES.TOO_MANY;
    default: return caseErrorMessage(r.error);
  }
}

/** Continue an incomplete screenshot draft after a refresh or on another visit. */
export function ResumeDraft({ caseId, reference, onDone }: { caseId: string; reference: string; onDone: () => Promise<void> }) {
  const { supabase, profile } = useAuth();
  const [status, setStatus] = useState<ScreenshotStatus | null>(null);
  const [shots, setShots] = useState<ProcessedShot[]>([]);
  const [states, setStates] = useState<Record<string, ShotState>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const assigned = useRef(new Map<string, number>());
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  const refresh = async () => {
    const r = await fetchStatus(supabase, caseId);
    if ('error' in r) setError(caseErrorMessage(r.error));
    else setStatus(r.status);
  };
  useEffect(() => {
    void refresh();
    return () => releaseShots(shotsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  if (!status) return <div className="card" data-testid="resume-draft"><p className="muted" role="status">Checking saved screenshots…</p><ErrorBanner message={error} /></div>;
  const sum = summarizeStatus(status);
  const capacity = sum.gaps.length + MAX_FILES - (sum.uploaded[sum.uploaded.length - 1] ?? 0);
  const canSubmitSaved = sum.uploaded.length > 0 && sum.gaps.length === 0 && shots.length === 0;

  const run = async () => {
    if (!profile?.businessId) return;
    setBusy(true);
    setError(null);
    const r = await completeScreenshotCase(supabase, {
      businessId: profile.businessId, caseId, shots, assigned: assigned.current,
      onState: (id, st) => setStates((s) => ({ ...s, [id]: st })),
    });
    if (r.ok) {
      releaseShots(shots);
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      await onDone();
    } else {
      setError(resultMessage(r));
      await refresh();
    }
    setBusy(false);
  };

  return (
    <div className="card" data-testid="resume-draft">
      <h2 className="card-title">Continue {reference}</h2>
      <p data-testid="resume-summary">{sum.uploaded.length} screenshot{sum.uploaded.length === 1 ? '' : 's'} saved{sum.gaps.length ? ` · missing position${sum.gaps.length === 1 ? '' : 's'} ${sum.gaps.join(', ')}` : ''}.</p>
      {sum.unusable ? (
        <div className="banner banner-error" role="alert">{SHOT_MESSAGES.CONFLICT}</div>
      ) : (
        <>
          {sum.gaps.length > 0 && shots.length < sum.gaps.length && <Notice tone="warn">{SHOT_MESSAGES.GAPS}</Notice>}
          <ScreenshotPicker shots={shots} onChange={setShots} max={capacity} states={states} locked={busy} />
          <ErrorBanner message={error} />
          <Button block disabled={busy || !(shots.length > 0 || canSubmitSaved) || (sum.gaps.length > shots.length)} onClick={() => void run()}>
            {busy ? 'Submitting…' : shots.length ? 'Upload and Submit' : 'Submit Saved Screenshots'}
          </Button>
        </>
      )}
    </div>
  );
}

export const DRAFT_KEY = 'rre-screenshot-draft';

interface ShotRow { id: string; position: number; storage_path: string; mime_type: string; size_bytes: number; file_deleted_at: string | null }

/** Founder-only viewer: each file is downloaded with the founder's own session and shown from a local blob. */
export function FounderScreenshots({ caseId }: { caseId: string }) {
  const { supabase } = useAuth();
  const [rows, setRows] = useState<ShotRow[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string | 'missing'>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const made: string[] = [];
    (async () => {
      const { data, error: err } = await supabase.from('case_screenshots')
        .select('id, position, storage_path, mime_type, size_bytes, file_deleted_at').eq('case_id', caseId).order('position');
      if (!active) return;
      if (err) return setError('Could not load the screenshots.');
      const list = (data ?? []) as ShotRow[];
      setRows(list);
      for (const r of list) {
        if (r.file_deleted_at) continue;
        const url = await download(supabase, r);
        if (!active) { if (url) URL.revokeObjectURL(url); return; }
        if (url) made.push(url);
        setUrls((u) => ({ ...u, [r.id]: url ?? 'missing' }));
      }
    })();
    return () => {
      active = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [supabase, caseId]);

  if (error) return <ErrorBanner message={error} />;
  if (!rows) return <p className="muted" role="status">Loading screenshots…</p>;
  if (rows.length === 0) return <p className="muted">No screenshots recorded.</p>;
  return (
    <ol className="shots-full" data-testid="founder-shots">
      {rows.map((r) => (
        <li key={r.id} className="shot-full">
          <p className="field-label">Screenshot {r.position}</p>
          {r.file_deleted_at ? <p className="muted" data-testid="shot-deleted">File deleted under retention.</p>
            : urls[r.id] === 'missing' ? <p className="muted" data-testid="shot-missing">File missing or unavailable.</p>
              : urls[r.id] ? <img src={urls[r.id]} alt={`Screenshot ${r.position}`} data-testid={`founder-shot-${r.position}`} />
                : <p className="muted" role="status">Loading…</p>}
        </li>
      ))}
    </ol>
  );
}

async function download(supabase: SupabaseClient, r: ShotRow): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(r.storage_path);
  if (error || !data) return null;
  // Always display as the recorded image type (never as HTML or SVG), from a local blob.
  return URL.createObjectURL(new Blob([await data.arrayBuffer()], { type: r.mime_type === 'image/jpeg' ? 'image/jpeg' : 'image/png' }));
}
