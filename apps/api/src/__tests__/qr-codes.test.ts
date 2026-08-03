import { describe, it, expect } from 'vitest';
import {
  QR_CHARSET,
  QR_CODE_LENGTH,
  classifyScan,
  generateShortCode,
  makeSlug,
  normalizeShortCode,
  redirectTargetFor,
  sanitizeTemplate,
  type QrLookup,
} from '../modules/qr/qr-codes';
import { hashScanIp, parseUserAgent } from '../modules/qr/scan-log';

// ---------------------------------------------------------------------------
// QR pure core: the charset/normalization laws, the slug contract, and the
// 5-row scan decision table — every row pinned, plus the redirect constructor
// that must never let client input steer a 302.
// ---------------------------------------------------------------------------

const BASE = 'https://swift.gy';
const DAY_MS = 24 * 60 * 60 * 1000;

const liveQr = (over: Partial<QrLookup> = {}): QrLookup => ({
  shortCode: 'BCDFGHJKMN',
  status: 'ACTIVE',
  supersededAt: null,
  entity: { live: true, slug: 'green-bowl-x7k2m9' },
  ...over,
});

describe('short codes', () => {
  it('charset has 28 chars, no vowels, no 0/1/I/L/O/U lookalikes', () => {
    expect(QR_CHARSET).toHaveLength(28);
    for (const banned of 'AEIOU01IL') expect(QR_CHARSET.includes(banned)).toBe(false);
  });

  it('generates codes of the right length drawn only from the charset', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateShortCode();
      expect(code).toHaveLength(QR_CODE_LENGTH);
      for (const ch of code) expect(QR_CHARSET.includes(ch)).toBe(true);
    }
  });

  it('a 1k sample has no duplicates (keyspace sanity)', () => {
    const sample = new Set(Array.from({ length: 1000 }, () => generateShortCode()));
    expect(sample.size).toBe(1000);
  });

  it('normalize: case-insensitive input, canonical uppercase out', () => {
    expect(normalizeShortCode('bcdfghjkmn')).toBe('BCDFGHJKMN');
    expect(normalizeShortCode('  BCDFGHJKMN  ')).toBe('BCDFGHJKMN');
  });

  it('normalize rejects anything that is not exactly a valid code', () => {
    for (const bad of [
      '', 'SHORT', 'BCDFGHJKMNP', // wrong length
      'ACDFGHJKMN', // vowel
      'BCDFGHJKM0', // lookalike digit
      '../../../etc', 'BCDFGHJKM;', '<script>AA', 'BCDFGHJKM\n',
    ]) {
      expect(normalizeShortCode(bad)).toBeNull();
    }
  });
});

describe('makeSlug', () => {
  it('strips diacritics, collapses runs, trims dashes', () => {
    expect(makeSlug("Auntie Désirée's Roti & Curry Shop")).toBe('auntie-desiree-s-roti-curry-shop');
    expect(makeSlug('  --Green   Bowl--  ')).toBe('green-bowl');
  });

  it('caps at 60 chars without a trailing dash', () => {
    const slug = makeSlug(`${'a'.repeat(59)} bakery`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('non-latin input degrades to empty (caller falls back)', () => {
    expect(makeSlug('好味餐厅')).toBe('');
  });
});

describe('classifyScan — the decision table, row by row', () => {
  const now = new Date('2026-08-03T12:00:00Z');

  it('row 1+2: null (malformed or unknown) → NOT_FOUND, one shared path', () => {
    expect(classifyScan(null, now, 30)).toBe('NOT_FOUND');
  });

  it('row 3a: DEACTIVATED → RETIRED_PAGE, even with a live entity', () => {
    expect(classifyScan(liveQr({ status: 'DEACTIVATED' }), now, 30)).toBe('RETIRED_PAGE');
  });

  it('row 3b: SUPERSEDED past grace → RETIRED_PAGE', () => {
    const supersededAt = new Date(now.getTime() - 31 * DAY_MS);
    expect(classifyScan(liveQr({ status: 'SUPERSEDED', supersededAt }), now, 30)).toBe('RETIRED_PAGE');
  });

  it('row 9 (edge matrix): SUPERSEDED within grace resolves normally', () => {
    const supersededAt = new Date(now.getTime() - 5 * DAY_MS);
    expect(classifyScan(liveQr({ status: 'SUPERSEDED', supersededAt }), now, 30)).toBe('WEB_RENDER');
  });

  it('grace is config, not a constant: 0 days retires immediately (QR-P)', () => {
    const supersededAt = new Date(now.getTime() - 1000);
    expect(classifyScan(liveQr({ status: 'SUPERSEDED', supersededAt }), now, 0)).toBe('RETIRED_PAGE');
    expect(classifyScan(liveQr({ status: 'SUPERSEDED', supersededAt }), now, 365)).toBe('WEB_RENDER');
  });

  it('row 4: entity not live (or missing) → UNAVAILABLE_PAGE', () => {
    expect(classifyScan(liveQr({ entity: { live: false, slug: 's' } }), now, 30)).toBe('UNAVAILABLE_PAGE');
    expect(classifyScan(liveQr({ entity: null }), now, 30)).toBe('UNAVAILABLE_PAGE');
  });

  it('row 4 beats liveness for superseded-in-grace of a dead store', () => {
    const supersededAt = new Date(now.getTime() - 5 * DAY_MS);
    expect(classifyScan(liveQr({ status: 'SUPERSEDED', supersededAt, entity: { live: false, slug: 's' } }), now, 30))
      .toBe('UNAVAILABLE_PAGE');
  });

  it('row 5: valid + live → WEB_RENDER', () => {
    expect(classifyScan(liveQr(), now, 30)).toBe('WEB_RENDER');
  });
});

describe('redirectTargetFor — server-constructed targets only', () => {
  it('WEB_RENDER goes to the CURRENT slug with src/c (and sanitized t)', () => {
    expect(redirectTargetFor('WEB_RENDER', liveQr(), { base: BASE, template: 'tabletent' }))
      .toBe('https://swift.gy/store/green-bowl-x7k2m9?src=qr&c=BCDFGHJKMN&t=tabletent');
    expect(redirectTargetFor('WEB_RENDER', liveQr(), { base: BASE, template: null }))
      .toBe('https://swift.gy/store/green-bowl-x7k2m9?src=qr&c=BCDFGHJKMN');
  });

  it('hostile template values are dropped by the allowlist, never echoed', () => {
    for (const bad of ['https://evil.example', '../redirect', 'a b', 'x'.repeat(40), '<svg>', '1abc']) {
      expect(sanitizeTemplate(bad)).toBeNull();
    }
    expect(sanitizeTemplate(' Sticker ')).toBe('sticker');
  });

  it('RETIRED links to the current store page only when the store is live', () => {
    expect(redirectTargetFor('RETIRED_PAGE', liveQr({ status: 'DEACTIVATED' }), { base: BASE }))
      .toBe('https://swift.gy/qr/retired?store=green-bowl-x7k2m9');
    expect(redirectTargetFor('RETIRED_PAGE', liveQr({ status: 'DEACTIVATED', entity: null }), { base: BASE }))
      .toBe('https://swift.gy/qr/retired');
  });

  it('UNAVAILABLE and NOT_FOUND are fixed branded pages', () => {
    expect(redirectTargetFor('UNAVAILABLE_PAGE', liveQr({ entity: null }), { base: BASE }))
      .toBe('https://swift.gy/qr/unavailable');
    expect(redirectTargetFor('NOT_FOUND', null, { base: BASE })).toBe('https://swift.gy/qr/not-found');
  });

  it('a trailing slash on the base cannot double up', () => {
    expect(redirectTargetFor('NOT_FOUND', null, { base: 'https://swift.gy/' })).toBe('https://swift.gy/qr/not-found');
  });
});

describe('scan privacy primitives', () => {
  it('ipHash rotates across UTC days (unlinkable across days)', () => {
    const ip = '190.80.12.34';
    const monday = hashScanIp(ip, new Date('2026-08-03T23:59:00Z'));
    const tuesday = hashScanIp(ip, new Date('2026-08-04T00:01:00Z'));
    expect(monday).not.toBe(tuesday);
    expect(monday).toMatch(/^[0-9a-f]{64}$/);
    expect(monday.includes(ip)).toBe(false);
  });

  it('UA parse is coarse-only', () => {
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)')).toEqual({ osFamily: 'ios', deviceClass: 'phone' });
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-A155F) Mobile Safari')).toEqual({ osFamily: 'android', deviceClass: 'phone' });
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toEqual({ osFamily: 'desktop', deviceClass: 'desktop' });
    expect(parseUserAgent(undefined)).toEqual({ osFamily: 'other', deviceClass: 'desktop' });
  });
});
