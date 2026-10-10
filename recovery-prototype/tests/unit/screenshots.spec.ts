// Stage 2A-4c client-side logic (no browser, no network). These checks are
// usability/privacy aids only; the server never relies on them.

import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { validateCase } from '../../src/live/cases';
import {
  buildPath, checkDimensions, finalizeErrorKind, isStored, MAX_BYTES, MAX_FILES, planPositions, sha256Hex, sniffType, summarizeStatus,
} from '../../src/live/screenshots';

const bytes = (...b: number[]) => new Uint8Array(b);

test('file type comes from the first bytes, not the name', () => {
  expect(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe('png');
  expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
  expect(sniffType(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]))).toBe('webp');
  for (const bad of [Buffer.from('GIF89a'), Buffer.from('<svg xmlns="x">'), Buffer.from('<html>'), bytes(0x89, 0x50, 0x4e), bytes()]) {
    expect(sniffType(new Uint8Array(bad))).toBeNull();
  }
});

test('limits: 5 MB, 10 files, pixel dimensions', () => {
  expect(MAX_BYTES).toBe(5 * 1024 * 1024);
  expect(MAX_FILES).toBe(10);
  expect(checkDimensions(1080, 2400)).toBeNull();
  expect(checkDimensions(1080, 16384)).toBeNull();
  expect(checkDimensions(4097, 100)).toMatch(/too large/);
  expect(checkDimensions(1080, 16385)).toMatch(/too large/);
  expect(checkDimensions(4096, 12000)).toMatch(/too large/); // > 40 megapixels
  expect(checkDimensions(0, 10)).toMatch(/could not be read/);
});

test('hash is the SHA-256 of the given bytes', async () => {
  const data = Buffer.from('synthetic processed image bytes');
  expect(await sha256Hex(new Uint8Array(data).buffer)).toBe(createHash('sha256').update(data).digest('hex'));
});

test('upload path matches the database upload rule pattern', () => {
  const p = buildPath('10000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-000000000001', 10, 'a'.repeat(64), 'jpg');
  expect(p).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/(10|[1-9])-[0-9a-f]{64}\.(png|jpg)$/);
});

test('status summary: uploaded positions, gaps, conflicts', () => {
  const f = (position: number | null, sha256 = 'a', size = 1) => ({ position, sha256, size, mime_type: 'image/png', registered: false });
  expect(summarizeStatus({ files: [f(1), f(2)], registered_count: 0 })).toEqual({ uploaded: [1, 2], conflicts: [], gaps: [], registered: 0, unusable: false });
  expect(summarizeStatus({ files: [f(1), f(3)], registered_count: 0 }).gaps).toEqual([2]);
  const c = summarizeStatus({ files: [f(1, 'a'), f(1, 'b')], registered_count: 0 });
  expect(c.conflicts).toEqual([1]);
  expect(c.unusable).toBe(true);
  expect(summarizeStatus({ files: [f(null)], registered_count: 0 }).unusable).toBe(true);
  expect(isStored({ files: [f(2, 'abc', 10)] }, 2, { sha256: 'abc', size: 10 })).toBe(true);
  expect(isStored({ files: [f(2, 'abc', 10)] }, 2, { sha256: 'abc', size: 11 })).toBe(false);
  expect(isStored({ files: [f(2, 'abc', 10)] }, 1, { sha256: 'abc', size: 10 })).toBe(false);
});

test('positions for new screenshots fill gaps first, then append, never beyond 10', () => {
  expect(planPositions({ uploaded: [], gaps: [] }, 3)).toEqual([1, 2, 3]);
  expect(planPositions({ uploaded: [1, 3], gaps: [2] }, 2)).toEqual([2, 4]);
  expect(planPositions({ uploaded: [1, 2, 3, 4, 5, 6, 7, 8, 9], gaps: [] }, 1)).toEqual([10]);
  expect(planPositions({ uploaded: [1, 2, 3, 4, 5, 6, 7, 8, 9], gaps: [] }, 2)).toBeNull();
});

test('finalize errors are classified from the exact database messages', () => {
  expect(finalizeErrorKind('VALIDATION: conflicting screenshots at positions 2')).toBe('conflict');
  expect(finalizeErrorKind('VALIDATION: missing screenshots at positions 3')).toBe('gaps');
  expect(finalizeErrorKind('VALIDATION: no screenshots uploaded')).toBe('none');
  expect(finalizeErrorKind('VALIDATION: screenshot failed checks at positions 1')).toBe('invalid');
  expect(finalizeErrorKind('TypeError: Failed to fetch')).toBe('other');
  expect(finalizeErrorKind(undefined)).toBe('other');
});

test('screenshot cases do not require a pasted conversation; text cases still do', () => {
  const base = { reference: 'S-1', productService: 'Synthetic', leadSource: 'Referral', estimatedValue: '', lastInteractionDate: '', clientContext: '', conversation: '' };
  expect(validateCase(base, '2026-10-12', 'SCREENSHOTS').value?.conversation).toBe('');
  expect(validateCase(base, '2026-10-12').errors.conversation).toMatch(/at least 20/);
  expect(validateCase({ ...base, conversation: 'x'.repeat(30) }, '2026-10-12', 'SCREENSHOTS').value?.conversation).toBe('');
});
