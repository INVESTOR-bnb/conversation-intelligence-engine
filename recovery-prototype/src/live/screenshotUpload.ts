// Uploads processed screenshots for one draft case, records them and submits.
// Every step can be repeated safely: a file's path is fixed by case, position
// and hash, so a retry after any failure either finds it already stored
// (confirmed via client_screenshot_status) or uploads it again.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isAlreadySubmitted } from './cases';
import {
  BUCKET, buildPath, finalizeErrorKind, isStored, planPositions, summarizeStatus,
  type ProcessedShot, type ScreenshotStatus,
} from './screenshots';

export type ShotState = 'waiting' | 'uploading' | 'saved' | 'failed';

export type CompleteResult =
  | { ok: true }
  | { ok: false; kind: 'upload' | 'conflict' | 'gaps' | 'invalid' | 'none' | 'too_many' | 'submit' | 'status'; error?: unknown };

export async function fetchStatus(supabase: SupabaseClient, caseId: string) {
  const { data, error } = await supabase.rpc('client_screenshot_status', { p_case_id: caseId });
  return error ? { error } : { status: data as ScreenshotStatus };
}

/**
 * Uploads `shots` into free positions of the draft (unless already stored),
 * records all stored files, and submits the case. `assigned` keeps each shot's
 * position across retries within this page session.
 */
export async function completeScreenshotCase(
  supabase: SupabaseClient,
  opts: {
    businessId: string;
    caseId: string;
    shots: ProcessedShot[];
    assigned: Map<string, number>;
    onState?: (shotId: string, state: ShotState) => void;
  },
): Promise<CompleteResult> {
  const { businessId, caseId, shots, assigned, onState } = opts;
  let st = await fetchStatus(supabase, caseId);
  if ('error' in st) return { ok: false, kind: 'status', error: st.error };
  let status = st.status;
  const summary = summarizeStatus(status);
  if (summary.conflicts.length) return { ok: false, kind: 'conflict' };

  const unplaced = shots.filter((s) => !assigned.has(s.id));
  if (unplaced.length) {
    const positions = planPositions(summary, unplaced.length);
    if (!positions) return { ok: false, kind: 'too_many' };
    unplaced.forEach((s, i) => assigned.set(s.id, positions[i]));
  }

  let failed = 0;
  for (const shot of shots) {
    const position = assigned.get(shot.id)!;
    if (isStored(status, position, shot)) {
      onState?.(shot.id, 'saved');
      continue;
    }
    onState?.(shot.id, 'uploading');
    const path = buildPath(businessId, caseId, position, shot.sha256, shot.ext);
    const { error } = await supabase.storage.from(BUCKET).upload(path, shot.bytes, { contentType: shot.mime, upsert: false, cacheControl: '0' });
    if (error) {
      // "Refused" and "already exists" look alike: ask the server what it holds.
      st = await fetchStatus(supabase, caseId);
      if (!('error' in st)) status = st.status;
      if (!('error' in st) && isStored(status, position, shot)) {
        onState?.(shot.id, 'saved');
        continue;
      }
      failed++;
      onState?.(shot.id, 'failed');
      continue;
    }
    onState?.(shot.id, 'saved');
  }
  if (failed) return { ok: false, kind: 'upload' };

  let fin = await supabase.rpc('client_finalize_screenshots', { p_case_id: caseId });
  // A lost response or transient error is safe to repeat once.
  if (fin.error && finalizeErrorKind(fin.error.message) === 'other') fin = await supabase.rpc('client_finalize_screenshots', { p_case_id: caseId });
  if (fin.error) {
    const k = finalizeErrorKind(fin.error.message);
    return { ok: false, kind: k === 'other' ? 'submit' : k, error: fin.error };
  }
  const sub = await supabase.rpc('client_submit_case', { p_case_id: caseId });
  if (sub.error && !isAlreadySubmitted(sub.error)) return { ok: false, kind: 'submit', error: sub.error };
  return { ok: true };
}
