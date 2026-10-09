/** A real 16×16 progressive JPEG of a single synthetic colour, with ten scans.
 * Inserting a segment at a known scan boundary preserves every image byte;
 * the independently expected result is this exact original, not a re-encode. */
export const PROGRESSIVE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAVAQEBAAAAAAAAAAAAAAAAAAABBP/aAAwDAQACEAMQAAABng2f/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABBQIf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQAGPwIf/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABPyEf/9oADAMBAAIAAwAAABAL/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABPxAf/9k=',
  'base64',
);

export const PROGRESSIVE_SCAN_OFFSETS = [223, 262, 295, 328, 361, 394, 405, 442, 475, 508] as const;
export const SYNTHETIC_CAMERA_TAG = 'synthetic-camera-location';

export function cameraSegment(marker = 0xe1): Buffer {
  const payload = Buffer.from(`Exif\0\0${SYNTHETIC_CAMERA_TAG}`, 'latin1');
  const size = Buffer.alloc(2);
  size.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), size, payload]);
}

export function progressiveWithMetadata(offset: number, marker = 0xe1): Buffer {
  return Buffer.concat([PROGRESSIVE_JPEG.subarray(0, offset), cameraSegment(marker), PROGRESSIVE_JPEG.subarray(offset)]);
}
