import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  customerIdHoldReasons, floatTrustLevel, measureImage, MIN_READABLE_LONG_SIDE, MIN_READABLE_SHORT_SIDE, VELOCITY_MAX_EARLIER,
  type CustomerIdFacts,
} from '../modules/verification/customer-id';

// [Owner ruling 8 Oct 2026 — CUSTOMER ID] The pure half of the intake: the header-only size
// reader and the rule that turns facts into hold reasons. Every doubt holds for a person.

function jpegHeader(width: number, height: number, marker = 0xc0): Buffer {
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x08]), Buffer.from('Exif\0\0')]);
  const sof = Buffer.from([0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xff]), sof, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

function webp(chunk: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(32, 4); b.write('WEBP', 8, 'ascii'); b.write(chunk, 12, 'ascii');
  if (chunk === 'VP8 ') { b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(width, 26); b.writeUInt16LE(height, 28); }
  if (chunk === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21); }
  if (chunk === 'VP8X') { b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3); }
  return b;
}

const clean: CustomerIdFacts = {
  duplicateImage: false, linkedAccountSubmissions: 0, openSubmissions: 0, priorHolds: 0, earlierPersonDecision: false,
  earlierSubmissionsInWindow: 0, size: { width: 1600, height: 1000 }, sizeCheckApplies: true,
  accountHold: false, identityReview: false, strikeRestricted: false, processorReferred: false, processorUnavailable: false,
};

describe('measureImage reads the pixel size from the header alone', () => {
  it('reads a real PNG', () => {
    const png = PNG.sync.write(new PNG({ width: 1200, height: 800 }));
    expect(measureImage(png)).toEqual({ width: 1200, height: 800 });
  });

  it.each([0xc0, 0xc1, 0xc2])('reads a JPEG frame header (SOF %i) past APP segments and fill bytes', (marker) => {
    expect(measureImage(jpegHeader(2000, 1500, marker))).toEqual({ width: 2000, height: 1500 });
  });

  it('does not mistake a Huffman table (DHT 0xC4) for a frame header', () => {
    const dht = Buffer.from([0xff, 0xc4, 0x00, 0x05, 0x00, 0x01, 0x02]);
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, jpegHeader(900, 700).subarray(2)]);
    expect(measureImage(buf)).toEqual({ width: 900, height: 700 });
  });

  it.each(['VP8 ', 'VP8L', 'VP8X'] as const)('reads WebP %s', (chunk) => {
    expect(measureImage(webp(chunk, 1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  it.each([
    ['a PDF', Buffer.from('%PDF-1.4\n')],
    ['a JPEG that ends before any frame header', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['a JPEG with a broken segment', Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78])],
    ['a zero-sized PNG', PNG.sync.write(new PNG({ width: 1, height: 1 })).fill(0, 16, 24)],
    ['random bytes', Buffer.from('not an image at all, just text')],
    ['nothing', Buffer.alloc(0)],
  ])('cannot measure %s — null, never "readable"', (_label, buf) => {
    expect(measureImage(buf)).toBeNull();
  });
});

describe('customerIdHoldReasons — the automatic checks', () => {
  it('a clean, readable upload goes on file (no reasons)', () => {
    expect(customerIdHoldReasons(clean)).toEqual([]);
  });

  it('holds at the readable-size boundary, and not one pixel above it', () => {
    expect(customerIdHoldReasons({ ...clean, size: { width: MIN_READABLE_LONG_SIDE, height: MIN_READABLE_SHORT_SIDE } })).toEqual([]);
    expect(customerIdHoldReasons({ ...clean, size: { width: MIN_READABLE_LONG_SIDE, height: MIN_READABLE_SHORT_SIDE - 1 } })).toEqual(['TOO_SMALL']);
    expect(customerIdHoldReasons({ ...clean, size: { width: MIN_READABLE_LONG_SIDE - 1, height: MIN_READABLE_LONG_SIDE - 1 } })).toEqual(['TOO_SMALL']);
    expect(customerIdHoldReasons({ ...clean, size: { width: MIN_READABLE_SHORT_SIDE, height: MIN_READABLE_LONG_SIDE } })).toEqual([]);
  });

  it('an unmeasurable file is held; a processor that read the document stands in for the size check', () => {
    expect(customerIdHoldReasons({ ...clean, size: null })).toEqual(['NOT_MEASURABLE']);
    expect(customerIdHoldReasons({ ...clean, size: null, sizeCheckApplies: false })).toEqual([]);
  });

  it('velocity: the third upload in the window waits for a person', () => {
    expect(customerIdHoldReasons({ ...clean, earlierSubmissionsInWindow: VELOCITY_MAX_EARLIER - 1 })).toEqual([]);
    expect(customerIdHoldReasons({ ...clean, earlierSubmissionsInWindow: VELOCITY_MAX_EARLIER })).toEqual(['VELOCITY']);
  });

  // Every fact the intake gathers must be able to hold an upload: a fact gathered and silently
  // ignored is a check that does not exist. Each field has a case below; a new field without one
  // fails `every fact has a case`.
  const FLAG_CASES = [
    ['processorReferred', { processorReferred: true }, 'PROCESSOR_REFERRED'],
    ['duplicateImage', { duplicateImage: true }, 'DUPLICATE_IMAGE'],
    ['linkedAccountSubmissions', { linkedAccountSubmissions: 1 }, 'LINKED_ACCOUNT'],
    ['openSubmissions', { openSubmissions: 1 }, 'OPEN_SUBMISSION'],
    ['priorHolds', { priorHolds: 1 }, 'PRIOR_HOLD'],
    ['processorUnavailable', { processorUnavailable: true }, 'CHECKS_UNAVAILABLE'],
    ['earlierPersonDecision', { earlierPersonDecision: true }, 'EARLIER_DECISION'],
    ['accountHold', { accountHold: true }, 'ACCOUNT_HOLD'],
    ['identityReview', { identityReview: true }, 'IDENTITY_REVIEW'],
    ['strikeRestricted', { strikeRestricted: true }, 'STRIKES'],
    ['earlierSubmissionsInWindow', { earlierSubmissionsInWindow: VELOCITY_MAX_EARLIER }, 'VELOCITY'],
    ['size', { size: { width: 300, height: 200 } }, 'TOO_SMALL'],
  ] as const;
  it.each(FLAG_CASES)('%s alone holds the upload', (_name, patch, reason) => {
    expect(customerIdHoldReasons({ ...clean, ...patch })).toEqual([reason]);
  });

  it('every fact has a case (sizeCheckApplies is the switch the size case runs under)', () => {
    const covered = new Set<string>([...FLAG_CASES.map(([name]) => name), 'sizeCheckApplies']);
    expect(Object.keys(clean).sort()).toEqual([...covered].sort());
    expect(new Set(FLAG_CASES.map(([, , reason]) => reason)).size).toBe(FLAG_CASES.length);
  });

  it('several flags are all named, in a stable order', () => {
    expect(customerIdHoldReasons({ ...clean, strikeRestricted: true, duplicateImage: true, size: null })).toEqual(['DUPLICATE_IMAGE', 'NOT_MEASURABLE', 'STRIKES']);
  });
});

describe("floatTrustLevel — a rider's cash float never rises on an ID that is only on file", () => {
  const db = (basis: 'PERSON' | 'AUTOMATIC' | 'NONE' | 'THROWS') => ({
    verificationDocument: { findMany: async () => { if (basis === 'THROWS') throw new Error('synthetic outage'); return basis === 'NONE' ? [] : [{ id: 'd' }]; } },
    reviewDecision: { count: async () => (basis === 'PERSON' ? 1 : 0) },
  }) as never;

  it('L1 stays L1 without a lookup', async () => {
    expect(await floatTrustLevel(db('THROWS'), 'u', 'L1')).toBe('L1');
  });
  it('an ID on file (no person) sizes the float as L1, even at L3', async () => {
    expect(await floatTrustLevel(db('AUTOMATIC'), 'u', 'L2')).toBe('L1');
    expect(await floatTrustLevel(db('AUTOMATIC'), 'u', 'L3')).toBe('L1');
  });
  it('a person-approved ID, or a level with no customer-ID record, keeps its level', async () => {
    expect(await floatTrustLevel(db('PERSON'), 'u', 'L2')).toBe('L2');
    expect(await floatTrustLevel(db('NONE'), 'u', 'L3')).toBe('L3');
  });
  it('fails closed: if the basis cannot be read, the float is sized as L1', async () => {
    expect(await floatTrustLevel(db('THROWS'), 'u', 'L3')).toBe('L1');
  });
});
