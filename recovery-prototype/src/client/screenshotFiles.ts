// Local-only screenshot handling for the Stage-1 prototype. Nothing is uploaded:
// each image is decoded in the browser and re-encoded as a downscaled JPEG data
// URL so a handful of screenshots fit in localStorage demo data.

import { newId } from '../domain/mockAnalysis';
import type { ConversationScreenshot } from '../domain/types';

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

const MAX_WIDTH = 900;
const JPEG_QUALITY = 0.72;

export function isAcceptedImage(file: File) {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  // Some Android pickers report an empty type; fall back to the extension.
  return file.type === '' && /\.(png|jpe?g|webp)$/i.test(file.name);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read ${file.name}.`));
    };
    img.src = url;
  });
}

export async function toLocalScreenshot(file: File): Promise<ConversationScreenshot> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_WIDTH / img.naturalWidth);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`Couldn't process ${file.name}.`);
  ctx.fillStyle = '#ffffff'; // transparent PNG areas become white, not black
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return {
    id: newId('shot'),
    order: 0, // assigned from list position on submit
    fileName: file.name,
    originalType: file.type || 'unknown',
    originalSizeBytes: file.size,
    dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
    width,
    height,
  };
}
