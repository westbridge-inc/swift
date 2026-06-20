import { describe, it, expect, vi } from 'vitest';

// images.ts imports API_URL from ../services/api (which pulls in native modules);
// stub it so these stay pure-logic tests.
vi.mock('../services/api', () => ({ API_URL: 'https://api.test' }));

import { mediaUrl, kindForVendor, vendorImage, fallbackImage } from './images';

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

describe('vendorImage', () => {
  it('prefers a real cover, then logo, then a deterministic fallback', () => {
    expect(vendorImage({ coverImageUrl: 'c.png', logoUrl: 'l.png' })).toBe('c.png');
    expect(vendorImage({ logoUrl: 'l.png' })).toBe('l.png');
    const fb = vendorImage({ id: 'v1', vendorType: 'STORE' });
    expect(typeof fb).toBe('string');
    expect(fb.length).toBeGreaterThan(0);
  });
});

describe('fallbackImage', () => {
  it('is deterministic — the same seed always yields the same image', () => {
    expect(fallbackImage('seed-1', 'food')).toBe(fallbackImage('seed-1', 'food'));
  });
});
