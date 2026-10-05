import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  width: 4000, height: 3000,
  manipulateAsync: vi.fn(async () => ({ uri: 'file:///resized.jpg' })),
}));
vi.mock('react-native', () => ({ Image: { getSize: (_uri: string, ok: (w: number, h: number) => void) => ok(native.width, native.height) } }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: native.manipulateAsync, SaveFormat: { JPEG: 'jpeg' } }));
import { prepareUploadImage } from './uploadImage';
const file = { uri: 'file:///original.heic', name: 'capture.heic', type: 'image/heic' };
beforeEach(() => { native.width = 4000; native.height = 3000; native.manipulateAsync.mockClear(); });
describe('on-device upload preparation', () => {
  it('resizes landscape proof to a 1280px long edge and JPEG 0.6', async () => {
    expect(await prepareUploadImage(file)).toEqual({ uri: 'file:///resized.jpg', name: 'capture.jpg', type: 'image/jpeg' });
    expect(native.manipulateAsync).toHaveBeenCalledWith(file.uri, [{ resize: { width: 1280 } }], { compress: 0.6, format: 'jpeg' });
  });
  it('keeps identity documents at 1600px with higher quality and preserves portrait aspect ratio', async () => {
    native.width = 3000; native.height = 4000;
    await prepareUploadImage(file, true);
    expect(native.manipulateAsync).toHaveBeenCalledWith(file.uri, [{ resize: { height: 1600 } }], { compress: 0.75, format: 'jpeg' });
  });
  it('rejects invalid image dimensions before encoding', async () => {
    native.width = 0;
    await expect(prepareUploadImage(file)).rejects.toThrow('dimensions');
    expect(native.manipulateAsync).not.toHaveBeenCalled();
  });
  it('does not upscale smaller images', async () => {
    native.width = 600; native.height = 800;
    await prepareUploadImage(file);
    expect(native.manipulateAsync).toHaveBeenCalledWith(file.uri, [], { compress: 0.6, format: 'jpeg' });
  });
  it('preserves non-image documents without sending them to an image decoder', async () => {
    const pdf = { ...file, name: 'document.pdf', type: 'application/pdf' };
    expect(await prepareUploadImage(pdf, true)).toBe(pdf);
    expect(native.manipulateAsync).not.toHaveBeenCalled();
  });
});

import { RetainedUploadPhotos } from './retainedUploadPhotos';
describe('retained proof photos', () => {
  it('keeps a capture for retry until the upload succeeds', async () => {
    const photos = new RetainedUploadPhotos();
    const camera = vi.fn(async () => 'file:///proof.jpg');
    await photos.capture('session/job/delivery', camera);
    // A failed upload does not acknowledge or forget the captured proof.
    expect(await photos.capture('session/job/delivery', camera)).toBe('file:///proof.jpg');
    expect(camera).toHaveBeenCalledTimes(1);
    photos.forget('session/job/delivery');
    await photos.capture('session/job/delivery', camera);
    expect(camera).toHaveBeenCalledTimes(2);
  });
  it('isolates jobs and clears photos at the account boundary', async () => {
    const photos = new RetainedUploadPhotos();
    const camera = vi.fn(async () => 'file:///proof.jpg');
    await photos.capture('session/job-a/pickup', camera);
    await photos.capture('session/job-b/pickup', camera);
    expect(camera).toHaveBeenCalledTimes(2);
    photos.clear();
    await photos.capture('session/job-a/pickup', camera);
    expect(camera).toHaveBeenCalledTimes(3);
  });
  it('single-flights a camera and never restores its photo after clearing', async () => {
    const photos = new RetainedUploadPhotos();
    let finish!: (value: string) => void;
    const camera = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = photos.capture('session/job/pickup', camera);
    const second = photos.capture('session/job/pickup', camera);
    expect(camera).toHaveBeenCalledTimes(1);
    photos.clear();
    finish('file:///stale.jpg');
    await Promise.all([first, second]);
    const fresh = vi.fn(async () => 'file:///fresh.jpg');
    expect(await photos.capture('session/job/pickup', fresh)).toBe('file:///fresh.jpg');
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});
