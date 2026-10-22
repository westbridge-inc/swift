import type { FastifyRequest } from 'fastify';
import { scanUpload, type UploadSurface } from '../lib/malware-scan';
import type { StorageProvider } from '../providers/storage/storage-provider';
import { AppError } from './errors';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from './images';
import { renderStorePhoto } from './public-store-photos';

/**
 * [IMAGES-E2E] The one way a photo customers will see is kept: a store's menu item,
 * logo or cover (`items/<store>/`) or a service provider's portfolio photo
 * (`portfolio/<provider>/`).
 *
 * - The photo must be JPEG, PNG or WebP, judged by its bytes.
 * - It is scanned.
 * - It is DRAWN AGAIN with the public door's own drawing (public-store-photos
 *   renderStorePhoto): upright, sRGB, no metadata at all (EXIF/GPS/XMP/ICC included),
 *   long edge at most 1600 px, same format. Bytes that do not decode are refused,
 *   because the door could never draw them for a customer.
 * - It is kept under `folder`, which only the public door serves, and only while a
 *   row still shows it. The storage seam strips once more on the way in.
 */
export async function keepPublicPhoto(
  request: FastifyRequest,
  storage: StorageProvider,
  folder: string,
  surface: UploadSurface,
): Promise<string> {
  const file = await request.file();
  if (!file) throw new AppError(400, 'NO_FILE', 'Attach an image file');
  if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
    throw new AppError(400, 'BAD_IMAGE_TYPE', 'Only JPEG, PNG, or WebP images are accepted');
  }

  const buffer = await file.toBuffer();
  if (!looksLikeImage(buffer)) {
    throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
  }

  await scanUpload(buffer, { surface, log: request.log });
  const drawn = await renderStorePhoto(buffer, null);
  if (!drawn) throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
  const ext = drawn.type === 'image/png' ? '.png' : drawn.type === 'image/webp' ? '.webp' : '.jpg';
  const { url } = await storage.upload({ buffer: drawn.body, filename: `photo${ext}`, mimeType: drawn.type, folder });
  return url;
}
