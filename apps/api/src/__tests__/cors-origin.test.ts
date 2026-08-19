import { describe, expect, it } from 'vitest';
import { DEFAULT_DEV_CORS_ORIGINS, resolveCorsOrigins } from '../utils/cors-origin';

describe('CORS origin policy', () => {
  it('fails closed outside development when no allowlist is configured', () => {
    expect(resolveCorsOrigins(undefined, 'production')).toBe(false);
    expect(resolveCorsOrigins(undefined, 'test')).toBe(false);
  });

  it('uses one normalized development allowlist for HTTP and Socket.IO', () => {
    expect(resolveCorsOrigins(undefined, 'development')).toEqual([...DEFAULT_DEV_CORS_ORIGINS]);
  });

  it('trims, normalizes, and deduplicates explicit origins', () => {
    expect(resolveCorsOrigins(' https://app.swift.gy/,tauri://localhost,https://app.swift.gy ', 'production')).toEqual([
      'https://app.swift.gy',
      'tauri://localhost',
    ]);
  });

  it.each([
    '*',
    'null',
    'https://*.swift.gy',
    'javascript://swift.gy',
    'https://swift.gy/path',
    'https://user:pass@swift.gy',
    'https://swift.gy?origin=other',
    'https://swift.gy#fragment',
    'not-a-url',
    ' , ',
  ])('rejects unsafe or malformed configuration: %s', (raw) => {
    expect(() => resolveCorsOrigins(raw, 'production')).toThrow(/CORS_ORIGIN/);
  });
});
