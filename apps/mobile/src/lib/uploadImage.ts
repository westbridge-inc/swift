import { Image } from 'react-native';

export interface UploadFile { uri: string; name: string; type: string }

const SIZE_READ_TIMEOUT_MS = 8_000;

/** Decode on device, preserve aspect ratio, and keep the original for retries.
 * Documents retain extra detail for human review. PDFs bypass image encoding.
 *
 * Never drops an upload: if anything in the on-device preparation fails (the
 * native image module is missing from an older binary, the size cannot be
 * read, or the decoder fails on a low-memory phone), the ORIGINAL photo is
 * sent instead. Pickup and delivery proof are mandatory on the server. */
export async function prepareUploadImage(file: UploadFile, document = false): Promise<UploadFile> {
  if (typeof file.type !== 'string' || !file.type.startsWith('image/')) return file;
  try {
    return await resizeForUpload(file, document);
  } catch {
    return file;
  }
}

/** True only when the running binary actually ships the native module. A JS
 * bundle delivered over the air to a binary built without it must never load
 * expo-image-manipulator, whose module body throws when the native side is
 * absent. */
async function hasImageManipulator(): Promise<boolean> {
  const { requireOptionalNativeModule } = await import('expo');
  return requireOptionalNativeModule('ExpoImageManipulator') != null;
}

async function resizeForUpload(file: UploadFile, document: boolean): Promise<UploadFile> {
  if (!(await hasImageManipulator())) return file;
  // A corrupt file can leave the native size callback unanswered; give up
  // and send the original rather than hold the upload forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('size read timed out')), SIZE_READ_TIMEOUT_MS);
    Image.getSize(file.uri, (width, height) => resolve({ width, height }), reject);
  }).finally(() => clearTimeout(timer));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return file;
  const edge = document ? 1600 : 1280;
  const actions = Math.max(width, height) > edge
    ? [{ resize: width >= height ? { width: edge } : { height: edge } }]
    : [];
  const { manipulateAsync, SaveFormat } = await import('expo-image-manipulator');
  const result = await manipulateAsync(file.uri, actions, {
    compress: document ? 0.75 : 0.6,
    format: SaveFormat.JPEG,
  });
  if (!result?.uri) return file;
  return { uri: result.uri, name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg' };
}
