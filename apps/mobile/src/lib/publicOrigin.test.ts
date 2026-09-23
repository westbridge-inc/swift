import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PUBLIC_SITE_HOST,
  CANONICAL_PUBLIC_SITE_ORIGIN,
  resolveLinkBuildChannel,
  resolveNativeLinkDomain,
} from './publicOrigin';

describe('canonical public origin', () => {
  it('names the public web application, never the separate API service', () => {
    expect(CANONICAL_PUBLIC_SITE_ORIGIN).toBe('https://swiftgy.com');
    expect(CANONICAL_PUBLIC_SITE_HOST).toBe('swiftgy.com');
  });

  it('requires release channels to name that exact native-link domain', () => {
    expect(resolveNativeLinkDomain('swiftgy.com', 'production')).toBe('swiftgy.com');
    expect(resolveNativeLinkDomain('swiftgy.com', 'preview')).toBe('swiftgy.com');
    expect(() => resolveNativeLinkDomain(undefined, 'production')).toThrow(/require SWIFT_LINK_DOMAIN/);
    expect(() => resolveNativeLinkDomain('swift.gy', 'production')).toThrow(/must be exactly/);
  });

  it('rejects hostile, whitespace-padded, and unknown channel input', () => {
    for (const hostile of ['attacker.example', 'swiftgy.com.attacker.example', ' swiftgy.com', 'swiftgy.com ']) {
      expect(() => resolveNativeLinkDomain(hostile, null), hostile).toThrow(/must be exactly/);
    }
    expect(resolveLinkBuildChannel('production')).toBe('production');
    expect(resolveLinkBuildChannel('preview')).toBe('preview');
    expect(resolveLinkBuildChannel('staging')).toBeNull();
    expect(resolveLinkBuildChannel(undefined)).toBeNull();
  });
});
