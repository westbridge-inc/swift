import { Image } from 'react-native';

export interface UploadFile { uri: string; name: string; type: string }

/** Decode on device, preserve aspect ratio, and keep the original for retries.
 * Documents retain extra detail for human review. PDFs bypass image encoding. */
export async function prepareUploadImage(file: UploadFile, document = false): Promise<UploadFile> {
  if (!file.type.startsWith('image/')) return file;
  const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    Image.getSize(file.uri, (width, height) => resolve({ width, height }), reject);
  });
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Could not read the photo dimensions. Please choose another photo.');
  }
  const edge = document ? 1600 : 1280;
  const actions = Math.max(width, height) > edge
    ? [{ resize: width >= height ? { width: edge } : { height: edge } }]
    : [];
  const { manipulateAsync, SaveFormat } = await import('expo-image-manipulator');
  const result = await manipulateAsync(file.uri, actions, {
    compress: document ? 0.75 : 0.6,
    format: SaveFormat.JPEG,
  });
  return { uri: result.uri, name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg' };
}
