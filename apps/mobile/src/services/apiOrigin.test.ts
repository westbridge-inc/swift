import { describe, expect, it } from 'vitest';
import {
  getReactNativeBundleScriptUrl,
  resolveApiOrigin,
} from './apiOrigin';

const credentialBearingDevelopmentUrl = [
  'http://', 'user', ':', 'pass', '@dev-machine.test:8081',
].join('');
const credentialBearingExplicitUrl = [
  'https://', 'user', ':', 'pass', '@api.test',
].join('');

describe('resolveApiOrigin', () => {
  it('uses an explicit valid origin before both development host sources', () => {
    expect(resolveApiOrigin({
      explicitOrigin: 'https://api.test/',
      isDev: true,
      expoHostUri: '192.0.2.44:8081',
      bundleScriptUrl: 'http://10.0.2.2:8081/index.bundle?platform=android',
    })).toBe('https://api.test');
  });

  it.each([
    ['physical IPv4 Metro host', '192.0.2.44:8081', 'http://192.0.2.44:3000'],
    ['Android emulator Metro host', '10.0.2.2:8081', 'http://10.0.2.2:3000'],
    ['iOS simulator localhost', 'localhost:8081', 'http://localhost:3000'],
    ['iOS simulator loopback', '127.0.0.1:8081', 'http://127.0.0.1:3000'],
    ['development hostname', 'dev-machine.test:8081', 'http://dev-machine.test:3000'],
    ['bracketed IPv6', '[2001:db8::44]:8081', 'http://[2001:db8::44]:3000'],
    ['Expo URI', 'exp://dev-machine.test:8081', 'http://dev-machine.test:3000'],
    ['secure Expo URI', 'exps://dev-machine.test:8081', 'http://dev-machine.test:3000'],
    ['HTTP Metro URI', 'http://dev-machine.test:8081', 'http://dev-machine.test:3000'],
    ['HTTPS Metro URI', 'https://dev-machine.test:8081', 'http://dev-machine.test:3000'],
  ])('derives the API origin from the %s', (_label, expoHostUri, expected) => {
    expect(resolveApiOrigin({ isDev: true, expoHostUri })).toBe(expected);
  });

  it('uses the native bundle script URL when the Expo host URI is absent', () => {
    expect(resolveApiOrigin({
      isDev: true,
      expoHostUri: null,
      bundleScriptUrl: 'http://10.0.2.2:8081/apps/mobile/index.bundle?platform=android&dev=true',
    })).toBe('http://10.0.2.2:3000');
  });

  it.each([
    [
      'physical TEST-NET IPv4 host',
      'http://192.0.2.44:8081/apps/mobile/index.bundle?platform=ios&dev=true#bundle',
      'http://192.0.2.44:3000',
    ],
    [
      'Android emulator host',
      'http://10.0.2.2:8081/index.bundle?platform=android',
      'http://10.0.2.2:3000',
    ],
    [
      'iOS simulator loopback',
      'http://127.0.0.1:8081/index.bundle?platform=ios',
      'http://127.0.0.1:3000',
    ],
    [
      'development hostname',
      'https://dev-machine.test:8081/index.bundle',
      'http://dev-machine.test:3000',
    ],
    [
      'bracketed IPv6 host',
      'http://[2001:db8::44]:8081/index.bundle?platform=ios',
      'http://[2001:db8::44]:3000',
    ],
  ])('derives the API origin from the %s bundle URL', (_label, bundleScriptUrl, expected) => {
    expect(resolveApiOrigin({ isDev: true, bundleScriptUrl })).toBe(expected);
  });

  it('uses a valid Expo host URI before the bundle script URL', () => {
    expect(resolveApiOrigin({
      isDev: true,
      expoHostUri: 'dev-machine.test:8081',
      bundleScriptUrl: 'http://10.0.2.2:8081/index.bundle?platform=android',
    })).toBe('http://dev-machine.test:3000');
  });

  it('falls back to a valid bundle URL when the Expo host URI is malformed', () => {
    expect(resolveApiOrigin({
      isDev: true,
      expoHostUri: 'not a host',
      bundleScriptUrl: 'http://10.0.2.2:8081/index.bundle?platform=android',
    })).toBe('http://10.0.2.2:3000');
  });

  it.each([
    undefined,
    null,
    '',
    'not a host',
    'ftp://dev-machine.test:8081',
    credentialBearingDevelopmentUrl,
    'http://dev-machine.test:8081/path',
    'http://dev-machine.test:8081?query=value',
    'http://dev-machine.test:8081#fragment',
  ])('rejects a missing or malformed development host URI: %s', (expoHostUri) => {
    expect(() => resolveApiOrigin({ isDev: true, expoHostUri }))
      .toThrow(/EXPO_PUBLIC_API_URL|Expo/i);
  });

  it.each([
    'not a URL',
    '/index.bundle?platform=ios',
    'ftp://dev-machine.test:8081/index.bundle',
    credentialBearingDevelopmentUrl,
  ])('rejects a malformed or unsafe bundle URL: %s', (bundleScriptUrl) => {
    expect(() => resolveApiOrigin({ isDev: true, bundleScriptUrl }))
      .toThrow(/bundle URL/i);
  });

  it.each([
    'ftp://api.test',
    credentialBearingExplicitUrl,
    'https://api.test/path',
    'https://api.test?query=value',
    'https://api.test#fragment',
  ])('rejects an unsafe explicit origin: %s', (explicitOrigin) => {
    expect(() => resolveApiOrigin({ explicitOrigin, isDev: true }))
      .toThrow(/API origin/i);
  });

  it('permits an HTTP override only in development', () => {
    expect(resolveApiOrigin({
      explicitOrigin: 'http://api.test:3000',
      isDev: true,
    })).toBe('http://api.test:3000');

    expect(() => resolveApiOrigin({
      explicitOrigin: 'http://api.test:3000',
      isDev: false,
    })).toThrow(/HTTPS/i);
  });

  it('uses the canonical HTTPS origin outside development and ignores dev sources', () => {
    expect(resolveApiOrigin({
      isDev: false,
      expoHostUri: 'not a host',
      bundleScriptUrl: 'ftp://dev-machine.test/index.bundle',
    })).toBe('https://api.swift.gy');
  });
});

describe('getReactNativeBundleScriptUrl', () => {
  it('reads the direct legacy constant shape', () => {
    expect(getReactNativeBundleScriptUrl({
      scriptURL: 'http://10.0.2.2:8081/index.bundle',
    })).toBe('http://10.0.2.2:8081/index.bundle');
  });

  it('reads the current getConstants shape', () => {
    expect(getReactNativeBundleScriptUrl({
      getConstants: () => ({
        scriptURL: 'http://127.0.0.1:8081/index.bundle?platform=ios',
      }),
    })).toBe('http://127.0.0.1:8081/index.bundle?platform=ios');
  });

  it.each([
    null,
    undefined,
    {},
    { scriptURL: '' },
    { scriptURL: 42 },
    { getConstants: () => null },
    { getConstants: () => ({ scriptURL: 42 }) },
    { getConstants: () => { throw new Error('native module unavailable'); } },
  ])('returns undefined for an unavailable or invalid SourceCode module: %s', (sourceCode) => {
    expect(getReactNativeBundleScriptUrl(sourceCode)).toBeUndefined();
  });
});
