import { describe, it, expect, vi } from 'vitest';

// images.ts imports API_URL from ../services/api (which pulls in native modules);
// stub it so these stay pure-logic tests.
vi.mock('../services/api', () => ({ API_URL: 'https://api.test' }));

import { mediaUrl, kindForVendor, itemPhoto, vendorPhoto, categoryPhoto } from './images';

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


describe('categoryPhoto — the merchant\'s own picture or nothing [S8]', () => {
  it("returns the category's own image when the merchant set one", () => {
    expect(categoryPhoto({ name: 'Mains', imageUrl: 'https://cdn.swift.gy/c/mains.webp' }))
      .toBe('https://cdn.swift.gy/c/mains.webp');
  });

  it('returns null when there is no picture — the caller draws PhotoPlaceholder', () => {
    expect(categoryPhoto({ name: 'Rice & Grains', imageUrl: null })).toBeNull();
    expect(categoryPhoto({ name: 'Produce' })).toBeNull();
    expect(categoryPhoto({})).toBeNull();
  });

  it('a category NAMED after a vertical gets no stock photo either', () => {
    // The deleted CATEGORY_IMAGES map keyed on these six literal names, so a
    // chip called "food" or "taxi" drew a stock photograph while every chip
    // beside it drew an honest placeholder — one rail, two truth standards.
    for (const name of ['food', 'grocery', 'taxi', 'courier', 'shops', 'services']) {
      expect(categoryPhoto({ name, imageUrl: null }), `"${name}" must not resolve to stock imagery`).toBeNull();
    }
  });
});
