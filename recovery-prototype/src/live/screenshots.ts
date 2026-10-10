// Stage 2A-4c screenshot intake: on-device processing and upload planning.
//
// IMPORTANT: everything in this file runs on the client and is untrusted. It
// improves privacy (metadata stripped) and usability (early, clear errors). It
// is NOT server-side validation: the server only checks paths, ownership, case
// state, recorded size and declared type. Nobody server-side verifies that a
// stored file is a real image or that its hash is correct.

export const BUCKET = 'case-screenshots';
export const MAX_FILES = 10;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_WIDTH = 4096;
export const MAX_HEIGHT = 16384;
export const MAX_PIXELS = 40_000_000;
export const ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

export type SniffedType = 'png' | 'jpeg' | 'webp';

/** File type from the first bytes (not the name or the browser-reported type). */
export function sniffType(b: Uint8Array): SniffedType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

export function checkDimensions(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return 'could not be read as an image';
  if (width > MAX_WIDTH || height > MAX_HEIGHT || width * height > MAX_PIXELS) return 'is too large in pixels (maximum 4096 × 16384)';
  return null;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

export function buildPath(businessId: string, caseId: string, position: number, sha256: string, ext: 'png' | 'jpg') {
  return `${businessId}/${caseId}/${position}-${sha256}.${ext}`;
}

export interface ProcessedShot {
  id: string;
  fileLabel: string; // shown on this device only; never uploaded
  bytes: ArrayBuffer;
  mime: 'image/png' | 'image/jpeg';
  ext: 'png' | 'jpg';
  size: number;
  sha256: string;
  width: number;
  height: number;
  previewUrl: string;
}

export class ShotError extends Error {}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new ShotError('could not be processed'))), type, quality));
}

async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number; close?: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
  } catch {
    throw new ShotError('could not be read as an image');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Re-encodes a screenshot at full resolution. Redrawing on a canvas drops all
 * metadata (EXIF location, camera data, PNG text chunks). PNG/WebP become PNG
 * (lossless, best for text); JPEG stays JPEG (quality 0.92). A PNG over 5 MB
 * is retried once as JPEG. Hash, size and dimensions describe the PROCESSED bytes.
 */
export async function processScreenshot(file: File): Promise<ProcessedShot> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = sniffType(head);
  if (!kind) throw new ShotError('is not a PNG, JPEG or WebP image');
  const image = await decode(file);
  const dimErr = checkDimensions(image.width, image.height);
  if (dimErr) {
    image.close?.();
    throw new ShotError(dimErr);
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ShotError('could not be processed');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  image.close?.();

  let mime: 'image/png' | 'image/jpeg' = kind === 'jpeg' ? 'image/jpeg' : 'image/png';
  let blob = await toBlob(canvas, mime, mime === 'image/jpeg' ? 0.92 : undefined);
  if (blob.size > MAX_BYTES && mime === 'image/png') {
    mime = 'image/jpeg';
    blob = await toBlob(canvas, mime, 0.92);
  }
  if (blob.size > MAX_BYTES) throw new ShotError('is larger than 5 MB even after processing');
  const bytes = await blob.arrayBuffer();
  const out = sniffType(new Uint8Array(bytes.slice(0, 16)));
  if (out !== (mime === 'image/png' ? 'png' : 'jpeg')) throw new ShotError('could not be processed');
  return {
    id: crypto.randomUUID(),
    fileLabel: file.name || 'screenshot',
    bytes,
    mime,
    ext: mime === 'image/png' ? 'png' : 'jpg',
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    width: canvas.width,
    height: canvas.height,
    previewUrl: URL.createObjectURL(new Blob([bytes], { type: mime })),
  };
}

// ---------------------------------------------------------------- server status

export interface StatusFile { position: number | null; sha256: string | null; size: number | null; mime_type: string | null; registered: boolean }
export interface ScreenshotStatus { case_id: string; source: 'SCREENSHOTS' | 'TEXT'; is_draft: boolean; files: StatusFile[]; registered_count: number }

export interface StatusSummary {
  uploaded: number[]; // distinct positions with at least one stored file
  conflicts: number[]; // positions with more than one stored file
  gaps: number[]; // missing positions below the highest uploaded one
  registered: number;
  unusable: boolean; // conflicts can never be resolved by the client
}

export function summarizeStatus(s: Pick<ScreenshotStatus, 'files' | 'registered_count'>): StatusSummary {
  const counts = new Map<number, number>();
  for (const f of s.files) if (f.position) counts.set(f.position, (counts.get(f.position) ?? 0) + 1);
  const uploaded = [...counts.keys()].sort((a, b) => a - b);
  const conflicts = uploaded.filter((p) => (counts.get(p) ?? 0) > 1);
  const max = uploaded.length ? uploaded[uploaded.length - 1] : 0;
  const gaps: number[] = [];
  for (let p = 1; p <= max; p++) if (!counts.has(p)) gaps.push(p);
  const invalid = s.files.some((f) => !f.position);
  return { uploaded, conflicts, gaps, registered: s.registered_count, unusable: conflicts.length > 0 || invalid };
}

/** True if the server already holds exactly this file at this position. */
export function isStored(s: Pick<ScreenshotStatus, 'files'>, position: number, shot: Pick<ProcessedShot, 'sha256' | 'size'>) {
  return s.files.some((f) => f.position === position && f.sha256 === shot.sha256 && f.size === shot.size);
}

/**
 * Positions for new screenshots: fill gaps first, then continue after the
 * highest stored position. Returns null if they do not fit in 10.
 */
export function planPositions(summary: Pick<StatusSummary, 'uploaded' | 'gaps'>, count: number): number[] | null {
  const free = [...summary.gaps];
  let next = (summary.uploaded.length ? summary.uploaded[summary.uploaded.length - 1] : 0) + 1;
  while (free.length < count && next <= MAX_FILES) free.push(next++);
  return free.length >= count ? free.slice(0, count) : null;
}

export const SHOT_MESSAGES = {
  CONFLICT: 'This draft has conflicting screenshots (two different images were saved for the same place) and cannot be completed. Start a new case with your screenshots.',
  GAPS: 'Some screenshots are missing. Add screenshots to fill the gaps, then submit.',
  UPLOAD_FAILED: 'Some screenshots did not upload. Check your connection and tap Retry — nothing will be duplicated.',
  TOO_MANY: 'A case can have at most 10 screenshots.',
  NONE: 'Add at least one screenshot.',
} as const;

/** Maps a finalize error to a message and whether the draft can still be completed. */
export function finalizeErrorKind(message: string | undefined): 'conflict' | 'gaps' | 'none' | 'invalid' | 'other' {
  const m = message ?? '';
  if (/^VALIDATION: conflicting screenshots/.test(m)) return 'conflict';
  if (/^VALIDATION: missing screenshots/.test(m)) return 'gaps';
  if (/^VALIDATION: no screenshots uploaded/.test(m)) return 'none';
  if (/^VALIDATION: screenshot failed checks/.test(m)) return 'invalid';
  return 'other';
}
