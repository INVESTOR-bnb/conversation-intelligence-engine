// Stage 2A-5d-4a — loading evidence strictly from the frozen snapshot.
//
// The analysis row's evidence_manifest (manifest v2, Stage 2A-5b) lists exactly
// which messages and stored screenshots the analysis may use, with SHA-256
// hashes taken when the analysis started. Only those are loaded, and each is
// re-hashed: a missing item or a different hash fails the run closed. Nothing
// outside the manifest (other messages of the case, excluded or deleted
// screenshots, other cases) is ever loaded.

import type { AnalysisRecord, FounderDb } from './types.ts';

/** A failure with a fixed, content-free code (stored as "PIPELINE_ERROR: <code>"). */
export class PipelineFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'PipelineFailure';
    this.code = code;
  }
}

export interface LoadedEvidence {
  messages: { id: string; kind: string; body: string }[];
  screenshots: { position: number; mimeType: string; base64: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg'];

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * True if the snapshot lists any restriction that is not DISMISSED_AS_MISREAD, or has
 * no restriction list at all. Same rule as the Stage 2A-5d-1 contract (fail closed).
 */
export function snapshotRestricted(manifest: unknown): boolean {
  const list = obj(manifest)?.restrictions;
  if (!Array.isArray(list)) return true;
  return list.some((r) => obj(r)?.status !== 'DISMISSED_AS_MISREAD');
}

export async function loadEvidence(db: FounderDb, record: AnalysisRecord, maxScreenshotBytes: number): Promise<LoadedEvidence> {
  const m = obj(record.evidenceManifest);
  if (!m || m.manifest_version !== 2 || !Array.isArray(m.messages) || !Array.isArray(m.screenshots)) {
    throw new PipelineFailure('EVIDENCE_SNAPSHOT_INVALID');
  }
  const wantedMessages = m.messages.map((x) => {
    const e = obj(x);
    const id = e?.id, sha = e?.body_sha256, kind = e?.kind;
    if (typeof id !== 'string' || !UUID.test(id) || typeof sha !== 'string' || !SHA256_HEX.test(sha) || typeof kind !== 'string') {
      throw new PipelineFailure('EVIDENCE_SNAPSHOT_INVALID');
    }
    return { id, sha, kind };
  });
  const wantedShots = m.screenshots.map((x) => {
    const e = obj(x);
    const id = e?.id, sha = e?.sha256, position = e?.position;
    if (typeof id !== 'string' || !UUID.test(id) || typeof sha !== 'string' || !SHA256_HEX.test(sha)
        || !Number.isInteger(position) || (position as number) < 1 || (position as number) > 10) {
      throw new PipelineFailure('EVIDENCE_SNAPSHOT_INVALID');
    }
    return { id, sha, position: position as number };
  });
  if (wantedMessages.length + wantedShots.length === 0) throw new PipelineFailure('EVIDENCE_MISSING');

  const messages: LoadedEvidence['messages'] = [];
  if (wantedMessages.length > 0) {
    const rows = await db.getMessages(record.caseId, wantedMessages.map((w) => w.id));
    for (const w of wantedMessages) {
      const row = rows.find((r) => r.id === w.id);
      if (!row || typeof row.body !== 'string') throw new PipelineFailure('EVIDENCE_MISSING');
      if (row.kind !== w.kind || (await sha256Hex(row.body)) !== w.sha) throw new PipelineFailure('EVIDENCE_HASH_MISMATCH');
      messages.push({ id: w.id, kind: w.kind, body: row.body });
    }
  }

  const screenshots: LoadedEvidence['screenshots'] = [];
  for (const w of wantedShots) {
    const file = await db.getScreenshotFile(record.caseId, w.id);
    if (!file) throw new PipelineFailure('EVIDENCE_MISSING');
    if (file.bytes.length === 0 || file.bytes.length > maxScreenshotBytes) throw new PipelineFailure('EVIDENCE_FILE_SIZE');
    if (!IMAGE_TYPES.includes(file.mimeType)) throw new PipelineFailure('EVIDENCE_FILE_TYPE');
    if (file.position !== w.position || (await sha256Hex(file.bytes)) !== w.sha) throw new PipelineFailure('EVIDENCE_HASH_MISMATCH');
    screenshots.push({ position: w.position, mimeType: file.mimeType, base64: toBase64(file.bytes) });
  }
  return { messages, screenshots };
}
