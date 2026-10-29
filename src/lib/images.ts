/** Longest side and size above which photos are shrunk before upload (vision models accept up to 5 MB). */
const MAX_SIDE = 2048;
const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;

export const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif';
export const isImageFile = (f: File) => /^image\/(jpeg|png|webp|gif)$/.test(f.type) || /\.(jpe?g|png|webp|gif)$/i.test(f.name);

/**
 * Shrinks a large photo on the device, so phone camera pictures upload quickly and fit the
 * model's limit. GIFs are left alone (shrinking would drop their animation); anything that
 * fails to decode is uploaded unchanged and the server decides.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!isImageFile(file) || /gif$/i.test(file.type || file.name) || typeof createImageBitmap === 'undefined') return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= SHRINK_ABOVE_BYTES) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  // WebP keeps transparency; browsers that can't encode it fall back to PNG, so use JPEG then.
  let blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob || blob.size >= file.size) return file;
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.${ext}`, { type: blob.type });
}
