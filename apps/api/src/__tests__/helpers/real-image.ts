import { crc32 } from 'node:zlib';

/**
 * [Row 108] Real photos for tests. The storage seam reads every photo with the real
 * decoder and refuses anything that is not one (fail closed), so a fixture of magic
 * bytes followed by text is refused like any other unreadable upload. These are
 * genuine 1×1 images; the `unique*` forms carry a note in a metadata segment, so
 * two fixtures never share a hash, and the note itself is metadata the strip removes.
 */

/** A real 1×1 PNG: IHDR, IDAT, IEND. */
export const REAL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA3fxQ8AAAAABJRU5ErkJggg==', 'base64');

/** A real 1×1 JPEG (quantisation and Huffman tables, scan data, end marker). */
export const REAL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);

/** The real PNG with a text chunk (valid CRC) carrying `note`, just after IHDR. */
export function uniquePng(note: string): Buffer {
  const data = Buffer.from(`Comment\0${note}`, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from('tEXt', 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([REAL_PNG.subarray(0, 33), len, body, crc, REAL_PNG.subarray(33)]);
}

/** The real JPEG with a comment segment carrying `note`, just after the start marker. */
export function uniqueJpeg(note: string): Buffer {
  const data = Buffer.from(note, 'latin1');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length + 2, 0);
  return Buffer.concat([REAL_JPEG.subarray(0, 2), Buffer.from([0xff, 0xfe]), len, data, REAL_JPEG.subarray(2)]);
}

/** A real 1×1 lossy WebP. */
export const REAL_WEBP = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+5fo/+QXLC65Gv/Qk/BJ+CT+AYAAA', 'base64');

/**
 * The real JPEG whose frame header says width × height, made unique by `note`. The decoder
 * reads a photo's size from that header; the pixels themselves are never decoded here.
 */
export function jpegSized(width: number, height: number, note: string): Buffer {
  const out = uniqueJpeg(note);
  const sof = out.indexOf(Buffer.from([0xff, 0xc0]));
  out.writeUInt16BE(height, sof + 5);
  out.writeUInt16BE(width, sof + 7);
  return out;
}
