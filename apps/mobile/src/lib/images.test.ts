import { describe, it, expect, vi } from 'vitest';

// images.ts imports API_URL from ../services/api (which pulls in native modules);
// stub it so these stay pure-logic tests.
vi.mock('../services/api', () => ({ API_URL: 'https://api.test' }));

import { mediaUrl, kindForVendor, itemPhoto, vendorPhoto } from './images';

describe('mediaUrl', () => {
  it('returns null for empty input', () => {
    expect(mediaUrl(null)).toBeNull();
    expect(mediaUrl(undefined)).toBeNull();
    expect(mediaUrl('')).toBeNull();
  });

  it('passes absolute URLs through untouched', () => {
    expect(mediaUrl('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png');
    expect(mediaUrl('http://x/y.png')).toBe('http://x/y.png');
  });

  it('prefixes the API origin for relative storage paths (with or without a leading slash)', () => {
    expect(mediaUrl('/uploads/items/x.png')).toBe('https://api.test/uploads/items/x.png');
    expect(mediaUrl('uploads/x.png')).toBe('https://api.test/uploads/x.png');
  });
});

describe('kindForVendor', () => {
  it('maps vendor types to the right fallback pool', () => {
    expect(kindForVendor({ vendorType: 'SUPERMARKET' })).toBe('grocery');
    expect(kindForVendor({ vendorType: 'STORE' })).toBe('store');
    expect(kindForVendor({ vendorType: 'SERVICE' })).toBe('service');
    expect(kindForVendor({ vendorType: 'RESTAURANT' })).toBe('food');
    expect(kindForVendor(null)).toBe('food');
  });
});

describe('vendorPhoto / itemPhoto — never invent a photograph [F-264]', () => {
  it('prefers the cover, then the logo', () => {
    expect(vendorPhoto({ coverImageUrl: 'c.png', logoUrl: 'l.png' })).toBe('c.png');
    expect(vendorPhoto({ logoUrl: 'l.png' })).toBe('l.png');
  });

  it('returns NULL rather than a stock photo when there is none', () => {
    // THE DEFECT THIS PINS: the removed `vendorImage`/`itemImage` returned a
    // random stock image keyed off the row id, so an unphotographed dish was
    // advertised with a stranger's dinner. On a marketplace the customer buys
    // from the picture; inventing one misrepresents the goods.
    expect(vendorPhoto({ id: 'v1', vendorType: 'STORE' } as never)).toBeNull();
    expect(vendorPhoto(null)).toBeNull();
    expect(vendorPhoto(undefined)).toBeNull();
    expect(itemPhoto({ imageUrl: null })).toBeNull();
    expect(itemPhoto({})).toBeNull();
  });

  it('passes a real url straight through', () => {
    expect(itemPhoto({ imageUrl: 'https://cdn/x.jpg' })).toBe('https://cdn/x.jpg');
  });
});

