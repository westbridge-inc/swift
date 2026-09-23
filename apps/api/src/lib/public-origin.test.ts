import { describe, expect, it } from 'vitest';
import { CANONICAL_PUBLIC_WEB_ORIGIN, publicWebOrigin } from './public-origin';

describe('public web origin', () => {
  it('uses the canonical public site when APP_PUBLIC_URL is absent or exact', () => {
    expect(CANONICAL_PUBLIC_WEB_ORIGIN).toBe('https://swiftgy.com');
    expect(publicWebOrigin({})).toBe(CANONICAL_PUBLIC_WEB_ORIGIN);
    expect(publicWebOrigin({ APP_PUBLIC_URL: CANONICAL_PUBLIC_WEB_ORIGIN })).toBe(CANONICAL_PUBLIC_WEB_ORIGIN);
  });

  it('refuses stale, API, malformed, and hostile redirect bases', () => {
    for (const value of [
      'https://swift.gy',
      'https://api.swift.gy',
      'https://swiftgy.com/',
      'https://swiftgy.com.attacker.example',
      'https://user:pw@swiftgy.com',
      'http://swiftgy.com',
      ' https://swiftgy.com',
      '',
    ]) {
      expect(() => publicWebOrigin({ APP_PUBLIC_URL: value }), value).toThrow(/APP_PUBLIC_URL must be exactly/);
    }
  });
});
