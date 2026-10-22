import { describe, it, expect, vi } from 'vitest';

// images.ts imports API_URL from ../services/api (which pulls in native modules);
// stub it so these stay pure-logic tests.
vi.mock('../services/api', () => ({ API_URL: 'https://api.test' }));

import { mediaUrl, kindForVendor, itemPhoto, vendorPhoto, categoryPhoto, storePhotoUrl, HERO_PHOTO_WIDTH, isKeptPhoto } from './images';

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
    // A stored path gets the API origin like every other photo (it was handed out bare: no image view could load it).
    expect(vendorPhoto({ coverImageUrl: 'c.png', logoUrl: 'l.png' })).toBe('https://api.test/c.png');
    expect(vendorPhoto({ logoUrl: 'l.png' })).toBe('https://api.test/l.png');
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
  it("returns the category's own photo when Swift keeps it, sized from the ladder", () => {
    expect(categoryPhoto({ name: 'Mains', imageUrl: 'items/v1/abcdefghijklmnop.jpg' }, 640))
      .toMatch(/\/items\/v1\/abcdefghijklmnop\.jpg\?w=640$/);
  });

  it('[IMAGES-E2E PR5 · COORD ruling 19 Oct (a)] never an outside address: a customer\'s phone loads no third-party host', () => {
    expect(categoryPhoto({ name: 'Mains', imageUrl: 'https://cdn.swiftgy.com/c/mains.webp' })).toBeNull();
    expect(categoryPhoto({ name: 'Mains', imageUrl: '//elsewhere.example/x.jpg' })).toBeNull();
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

describe('store photos reach the screen at a size made for it [IMAGES-E2E]', () => {
  const key = 'items/cmstore01/AbCdEfGhIjKlMnOp.jpg';

  it("a store's photo kept in object storage loads from the API, as a list-size copy", () => {
    expect(itemPhoto({ imageUrl: key })).toBe(`https://api.test/${key}?w=640`);
    expect(vendorPhoto({ coverImageUrl: key })).toBe(`https://api.test/${key}?w=640`);
    expect(vendorPhoto({ logoUrl: key })).toBe(`https://api.test/${key}?w=640`);
  });

  it("a provider's portfolio photo is sized the same way", () => {
    expect(storePhotoUrl('portfolio/cmprov01/AbCdEfGhIjKlMnOp.jpg', 320)).toBe('https://api.test/portfolio/cmprov01/AbCdEfGhIjKlMnOp.jpg?w=320');
  });

  it('a whole-screen photo asks for the large copy', () => {
    expect(vendorPhoto({ coverImageUrl: key }, HERO_PHOTO_WIDTH)).toBe(`https://api.test/${key}?w=1280`);
    expect(itemPhoto({ imageUrl: key }, HERO_PHOTO_WIDTH)).toBe(`https://api.test/${key}?w=1280`);
  });

  it('only a key in the stores\' photo folder gets a width; every other address is left as it was', () => {
    expect(storePhotoUrl('/uploads/items/cmstore01/AbCdEfGhIjKlMnOp.jpg')).toBe('https://api.test/uploads/items/cmstore01/AbCdEfGhIjKlMnOp.jpg');
    expect(storePhotoUrl('https://cdn.example.com/x.jpg')).toBe('https://cdn.example.com/x.jpg');
    expect(storePhotoUrl('items/cmstore01/../../verification/AbCdEfGhIjKlMnOp.jpg')).toBe('https://api.test/items/cmstore01/../../verification/AbCdEfGhIjKlMnOp.jpg');
    expect(storePhotoUrl('avatars/u1/AbCdEfGhIjKlMnOp.jpg')).toBe('https://api.test/avatars/u1/AbCdEfGhIjKlMnOp.jpg');
    expect(storePhotoUrl(null)).toBeNull();
  });
});

describe('a menu section photo and a kept photo [IMAGES-E2E PR4]', () => {
  const key = 'items/cmstore01/AbCdEfGhIjKlMnOp.jpg';

  it('a section photo kept in object storage loads from the API at tile size (it was handed out as a bare key)', () => {
    expect(categoryPhoto({ name: 'Mains', imageUrl: key })).toBe(`https://api.test/${key}?w=320`);
  });

  it('only a path with no host is a photo Swift keeps; an outside address is not', () => {
    for (const kept of [key, `/uploads/${key}`, '/uploads/items/review-pack/v1/store--item.png']) expect(isKeptPhoto(kept)).toBe(true);
    for (const outside of ['https://elsewhere.example/a.jpg', '//elsewhere.example/a.jpg', 'data:image/png;base64,AAAA', ' https://x/y', '', null, undefined]) {
      expect(isKeptPhoto(outside as string | null | undefined)).toBe(false);
    }
  });
});
