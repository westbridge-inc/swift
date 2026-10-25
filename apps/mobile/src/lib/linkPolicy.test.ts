import { describe, it, expect } from 'vitest';
import { classifyLink, normalizeHost, policyFrom, restrictPolicy, type LinkPolicy } from './linkPolicy';

// ---------------------------------------------------------------------------
// [MOB-002 / TST-005] The link policy, tested by making it REFUSE.
//
// The old parser accepted any http/https/swift URL whose path was shaped like
// ours, so an attacker's QR with /store/valid-slug behaved exactly like a
// printed Swift sign. Every case below is a way an origin can lie: a different
// host, a suffix-confusion host, punycode, a trailing dot, credentials, a
// port, a fragment, an encoded separator, a downgrade to http, an unknown
// custom-scheme authority. Each one is null-with-a-reason, never a resolve.
// ---------------------------------------------------------------------------

const PROD: LinkPolicy = policyFrom({ webUrl: 'https://swiftgy.com', isDev: false });
const DEV: LinkPolicy = policyFrom({ webUrl: 'http://localhost:3001', isDev: true });
const PREVIEW: LinkPolicy = policyFrom({ webUrl: 'https://swiftgy.com', previewHosts: 'preview.swiftgy.com, Staging.SwiftGy.COM', isDev: false });

const ok = (url: string, policy = PROD) => {
  const v = classifyLink(url, policy);
  if (!v.ok) throw new Error(`expected ${url} accepted, got ${v.reason}`);
  return v;
};
const reason = (url: string, policy = PROD): string => {
  const v = classifyLink(url, policy);
  return v.ok ? `ACCEPTED as ${v.origin}` : v.reason;
};

describe('the production policy is derived from the one web origin the app already uses', () => {
  it('holds exactly the origin host and its www twin, lowercase, and nothing else', () => {
    expect(PROD.hosts).toEqual(['swiftgy.com', 'www.swiftgy.com']);
    expect(policyFrom({ webUrl: 'https://WWW.SwiftGy.com/', isDev: false }).hosts).toEqual(['www.swiftgy.com', 'swiftgy.com']);
    expect(PROD.previewHosts).toEqual([]);
    expect(PROD.allowInsecureLoopback).toBe(false);
    expect(PROD.scheme).toBe('swift');
  });
  it('a loopback web origin yields NO production host — development never becomes an allow-all', () => {
    expect(DEV.hosts).toEqual([]);
    expect(DEV.allowInsecureLoopback).toBe(true);
  });
  it('preview hosts are explicit, normalized, and refused when they cannot be exact hosts', () => {
    expect(PREVIEW.previewHosts).toEqual(['preview.swiftgy.com', 'staging.swiftgy.com']);
    expect(policyFrom({ webUrl: 'https://swiftgy.com', previewHosts: 'preview.swiftgy.com:8443, xn--swft-gy.com, trailing.swiftgy.com., swiftgy.com', isDev: false }).previewHosts).toEqual([]);
    expect(normalizeHost('SwiftGy.COM')).toBe('swiftgy.com');
    expect(normalizeHost('swiftgy.com.')).toBeNull();
    expect(normalizeHost('xn--swft-gy.com')).toBeNull();
    expect(normalizeHost('swiftgy.com:443')).toBeNull();
    expect(normalizeHost('a b')).toBeNull();
  });
  it('a rollback can only SHRINK the allowlist — never widen it, never allow-all', () => {
    const smaller = restrictPolicy(PREVIEW, ['swiftgy.com', 'attacker.example', 'preview.swiftgy.com']);
    expect(smaller.hosts).toEqual(['swiftgy.com']);
    expect(smaller.previewHosts).toEqual(['preview.swiftgy.com']);
    expect(restrictPolicy(PROD, []).hosts).toEqual([]);
    expect(restrictPolicy(PROD, ['attacker.example']).hosts).toEqual([]);
    expect(classifyLink('https://www.swiftgy.com/s/BCDFGHJKMN', smaller)).toMatchObject({ ok: false, reason: 'host_not_allowed' });
  });
});

describe('universal links: exact production hosts over https, nothing else', () => {
  it('accepts the printed shapes on the exact hosts, normalizing case and the default port', () => {
    expect(ok('https://swiftgy.com/s/BCDFGHJKMN')).toMatchObject({ origin: 'production', host: 'swiftgy.com', parts: ['s', 'BCDFGHJKMN'] });
    expect(ok('https://www.swiftgy.com/store/green-bowl?src=qr&c=bcdfghjkmn')).toMatchObject({ origin: 'production', parts: ['store', 'green-bowl'] });
    expect(ok('HTTPS://WWW.SWIFTGY.COM/s/BCDFGHJKMN').host).toBe('www.swiftgy.com');
    expect(ok('https://swiftgy.com:443/s/BCDFGHJKMN').host).toBe('swiftgy.com');
  });
  it('an attacker host with a valid-looking Swift path is not ours', () => {
    expect(reason('https://attacker.example/store/valid-slug')).toBe('host_not_allowed');
    expect(reason('https://attacker.example/s/BCDFGHJKMN')).toBe('host_not_allowed');
  });
  it('suffix and prefix confusion are not ours', () => {
    expect(reason('https://swiftgy.com.attacker.example/s/BCDFGHJKMN')).toBe('host_not_allowed');
    expect(reason('https://www.swiftgy.com.attacker.example/store/green-bowl')).toBe('host_not_allowed');
    expect(reason('https://attacker-swiftgy.com/s/BCDFGHJKMN')).toBe('host_not_allowed');
    expect(reason('https://swiftgy.com-attacker.example/s/BCDFGHJKMN')).toBe('host_not_allowed');
    expect(reason('https://SWIFTGY.COM.attacker.example/s/BCDFGHJKMN')).toBe('host_not_allowed');
    expect(reason('https://xswiftgy.com/s/BCDFGHJKMN')).toBe('host_not_allowed');
  });
  it('punycode and Unicode lookalikes are not ours', () => {
    expect(reason('https://xn--swft-6pa.gy/s/BCDFGHJKMN')).toBe('host_punycode'); // the IDNA form of swïft.gy
    expect(reason('https://swïft.gy/s/BCDFGHJKMN')).toBe('host_punycode'); // WHATWG turns this into xn--swft-6pa.gy
    // an INVALID punycode label does not even parse — rejected either way, never resolved
    expect(['unparseable', 'host_punycode']).toContain(reason('https://xn--swft-gy.com/s/BCDFGHJKMN'));
  });
  it('a trailing dot is not the same host', () => {
    expect(reason('https://swiftgy.com./s/BCDFGHJKMN')).toBe('host_trailing_dot');
  });
  it('credentials in the authority are refused, including the classic host@attacker trick', () => {
    expect(reason('https://user:pw@swiftgy.com/s/BCDFGHJKMN')).toBe('credentials');
    expect(reason('https://swiftgy.com@attacker.example/s/BCDFGHJKMN')).toBe('credentials');
    expect(reason('https://swiftgy.com:@attacker.example/s/BCDFGHJKMN')).toBe('credentials');
  });
  it('a non-default port is refused', () => {
    expect(reason('https://swiftgy.com:8443/s/BCDFGHJKMN')).toBe('port');
    expect(reason('https://swiftgy.com:80/s/BCDFGHJKMN')).toBe('port');
  });
  it('a fragment is refused — our links never carry one', () => {
    expect(reason('https://swiftgy.com/s/BCDFGHJKMN#fragment')).toBe('fragment');
    expect(reason('https://swiftgy.com/store/green-bowl#')).toBe('fragment');
  });
  it('percent-encoding in the path is refused — an encoded separator is not a path', () => {
    expect(reason('https://swiftgy.com/store/abc%2Fdef')).toBe('encoded_path');
    expect(reason('https://swiftgy.com/s%2FBCDFGHJKMN')).toBe('encoded_path');
    expect(reason('https://swiftgy.com/store/green%2Dbowl')).toBe('encoded_path');
    expect(reason('https://swiftgy.com/store/green-bowl%00')).toBe('encoded_path');
  });
  it('http is a downgrade, even on the real host, even in development', () => {
    expect(reason('http://swiftgy.com/s/BCDFGHJKMN')).toBe('http_downgrade');
    expect(reason('http://www.swiftgy.com/store/green-bowl')).toBe('http_downgrade');
    expect(reason('http://swiftgy.com/s/BCDFGHJKMN', DEV)).toBe('http_downgrade');
    expect(reason('http://localhost.attacker.example/s/BCDFGHJKMN', DEV)).toBe('http_downgrade');
  });
  it('other schemes are not links at all', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://swiftgy.com/s/BCDFGHJKMN', 'data:text/html,hi', 'WIFI:S=cafe;T=WPA;P=hunter2;;', '', 'not a url']) {
      const v = classifyLink(url, PROD);
      expect(v.ok, url).toBe(false);
      if (!v.ok) expect(['scheme', 'unparseable']).toContain(v.reason);
    }
  });
});

describe('preview and development origins are explicit, never implied', () => {
  it('a preview host is refused by the production policy and accepted only when the build names it', () => {
    expect(reason('https://preview.swiftgy.com/s/BCDFGHJKMN')).toBe('host_not_allowed');
    expect(ok('https://preview.swiftgy.com/s/BCDFGHJKMN', PREVIEW).origin).toBe('preview');
    expect(ok('https://Staging.SwiftGy.COM/store/green-bowl', PREVIEW).origin).toBe('preview');
    expect(reason('https://preview.swiftgy.com.attacker.example/s/BCDFGHJKMN', PREVIEW)).toBe('host_not_allowed');
  });
  it('a development build tolerates plain http to a loopback host only — and any port there', () => {
    expect(ok('http://localhost:3001/s/BCDFGHJKMN', DEV).origin).toBe('loopback');
    expect(ok('http://127.0.0.1:3001/store/green-bowl', DEV).origin).toBe('loopback');
    expect(reason('http://localhost:3001/s/BCDFGHJKMN', PROD)).toBe('http_downgrade');
    expect(reason('http://10.0.0.9:3001/s/BCDFGHJKMN', DEV)).toBe('http_downgrade');
    expect(reason('https://attacker.example/s/BCDFGHJKMN', DEV)).toBe('host_not_allowed');
  });
});

describe('the custom scheme has one exact grammar: swift://{s|store}/…', () => {
  it('accepts the two route words as the authority and folds them into the parts', () => {
    expect(ok('swift://s/BCDFGHJKMN')).toMatchObject({ origin: 'custom-scheme', host: 's', parts: ['s', 'BCDFGHJKMN'] });
    expect(ok('swift://store/green-bowl?c=BCDFGHJKMN')).toMatchObject({ origin: 'custom-scheme', parts: ['store', 'green-bowl'] });
  });
  it('an unknown authority, a hostname, credentials, a port or a fragment there is not a Swift link', () => {
    expect(reason('swift://attacker.example/s/BCDFGHJKMN')).toBe('custom_scheme_authority');
    expect(reason('swift://s.evil/BCDFGHJKMN')).toBe('custom_scheme_authority');
    expect(reason('swift://swiftgy.com/s/BCDFGHJKMN')).toBe('custom_scheme_authority');
    expect(reason('swift://user@s/BCDFGHJKMN')).toBe('credentials');
    expect(reason('swift://s:1/BCDFGHJKMN')).toBe('custom_scheme_port');
    expect(reason('swift://s/BCDFGHJKMN#x')).toBe('fragment');
    expect(reason('swift://s/BCDF%2FGHJKMN')).toBe('encoded_path');
    expect(reason('swift:///s/BCDFGHJKMN')).toBe('custom_scheme_authority');
  });
  it('another app’s scheme is not ours', () => {
    expect(reason('swiftpay://s/BCDFGHJKMN')).toBe('scheme');
    expect(reason('swift://s/BCDFGHJKMN', { ...PROD, scheme: 'swiftapp' })).toBe('scheme');
  });
});
