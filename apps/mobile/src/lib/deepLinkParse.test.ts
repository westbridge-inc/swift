import { describe, it, expect, beforeEach } from 'vitest';
import { destinationForUrl, explainUrl, linkDecisionCounters, resetLinkDecisionsForTests, setLinkDecisionObserver, setLinkPolicyForTests } from './deepLinkParse';
import { policyFrom, type LinkDecision } from './linkPolicy';

// Edge row 20's law in miniature: any unrecognized path is null — the app
// opens normally, never crashes, never guesses a store.
//
// [MOB-002 / TST-005] And the ORIGIN is judged before the path: a valid-looking
// Swift path on a hostile host is null too, with a reason the router and the
// scanner can count.

const PROD = policyFrom({ webUrl: 'https://swift.gy', isDev: false });

beforeEach(() => {
  setLinkPolicyForTests(PROD);
  setLinkDecisionObserver(null);
  resetLinkDecisionsForTests();
});

describe('destinationForUrl', () => {
  it('parses storefront links, carrying a valid ?c= through', () => {
    expect(destinationForUrl('https://swift.gy/store/green-bowl-x7k2m9')).toEqual({
      kind: 'store', slug: 'green-bowl-x7k2m9', code: null,
    });
    expect(destinationForUrl('https://swift.gy/store/green-bowl?src=qr&c=bcdfghjkmn&t=card')).toEqual({
      kind: 'store', slug: 'green-bowl', code: 'BCDFGHJKMN',
    });
    // A malformed c is dropped, the store still opens.
    expect(destinationForUrl('https://swift.gy/store/green-bowl?c=<script>')).toEqual({
      kind: 'store', slug: 'green-bowl', code: null,
    });
  });

  it('parses short links case-insensitively to canonical uppercase', () => {
    expect(destinationForUrl('https://swift.gy/s/bcdfghjkmn')).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
    expect(destinationForUrl('https://www.swift.gy/s/bcdfghjkmn')).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
    expect(destinationForUrl('swift://s/BCDFGHJKMN')).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
  });

  it('everything else is null — deeper paths, bad slugs, bad codes, junk', () => {
    for (const url of [
      'https://swift.gy/',
      'https://swift.gy/store',
      'https://swift.gy/store/a/b',
      'https://swift.gy/store/UPPER..CASE',
      'https://swift.gy/s/SHORT',
      'https://swift.gy/s/AEIOUAEIOU', // vowels — not our charset
      'https://swift.gy/qr/retired',
      'not a url',
      'file:///etc/passwd',
      'https://swift.gy/store/' + 'a'.repeat(120),
    ]) {
      expect(destinationForUrl(url)).toBeNull();
    }
  });
});

describe('[MOB-002] a valid-looking Swift path on a hostile origin is NOT ours', () => {
  it('the attacker host, the http lookalike and the crafted custom-scheme URL from the register are all null', () => {
    expect(destinationForUrl('https://attacker.example/store/valid-slug')).toBeNull();
    expect(destinationForUrl('https://attacker.example/s/BCDFGHJKMN')).toBeNull();
    expect(destinationForUrl('http://swift.gy/s/BCDFGHJKMN')).toBeNull();
    expect(destinationForUrl('swift://attacker.example/s/BCDFGHJKMN')).toBeNull();
  });

  it('every origin lie is null, and explainUrl says which one', () => {
    const cases: Array<[string, string]> = [
      ['https://swift.gy.attacker.example/s/BCDFGHJKMN', 'host_not_allowed'],
      ['https://xn--swft-6pa.gy/s/BCDFGHJKMN', 'host_punycode'],
      ['https://swïft.gy/s/BCDFGHJKMN', 'host_punycode'],
      ['https://SWIFT.GY.attacker.example/store/green-bowl', 'host_not_allowed'],
      ['https://swift.gy./s/BCDFGHJKMN', 'host_trailing_dot'],
      ['https://user:pw@swift.gy/s/BCDFGHJKMN', 'credentials'],
      ['https://swift.gy@attacker.example/s/BCDFGHJKMN', 'credentials'],
      ['https://swift.gy:8443/s/BCDFGHJKMN', 'port'],
      ['https://swift.gy/s/BCDFGHJKMN#x', 'fragment'],
      ['https://swift.gy/store/abc%2Fdef', 'encoded_path'],
      ['http://www.swift.gy/store/green-bowl', 'http_downgrade'],
      ['swift://s.evil/BCDFGHJKMN', 'custom_scheme_authority'],
      ['swift://user@s/BCDFGHJKMN', 'credentials'],
    ];
    for (const [url, reason] of cases) {
      expect(destinationForUrl(url), url).toBeNull();
      expect(explainUrl(url), url).toMatchObject({ ok: false, reason });
    }
  });

  it('mixed case on the REAL host normalizes and opens; the same letters on another host do not', () => {
    expect(destinationForUrl('HTTPS://WWW.SWIFT.GY/s/bcdfghjkmn')).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
    expect(destinationForUrl('HTTPS://WWW.SWIFT.GY.ATTACKER.EXAMPLE/s/bcdfghjkmn')).toBeNull();
  });

  it('a preview host opens only in a build that names it; a development build opens loopback http only', () => {
    expect(destinationForUrl('https://preview.swift.gy/s/BCDFGHJKMN')).toBeNull();
    setLinkPolicyForTests(policyFrom({ webUrl: 'https://swift.gy', previewHosts: 'preview.swift.gy', isDev: false }));
    expect(destinationForUrl('https://preview.swift.gy/s/BCDFGHJKMN')).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
    setLinkPolicyForTests(policyFrom({ webUrl: 'http://localhost:3001', isDev: true }));
    expect(destinationForUrl('http://localhost:3001/store/green-bowl')).toEqual({ kind: 'store', slug: 'green-bowl', code: null });
    expect(destinationForUrl('https://attacker.example/store/green-bowl')).toBeNull();
    expect(destinationForUrl('http://10.0.0.9:3001/store/green-bowl')).toBeNull();
  });

  it('the policy is an argument, so a caller cannot widen it by omission — an allow-nothing policy opens nothing', () => {
    const nothing = policyFrom({ webUrl: 'not a url', isDev: false });
    expect(nothing.hosts).toEqual([]);
    expect(destinationForUrl('https://swift.gy/s/BCDFGHJKMN', nothing)).toBeNull();
    expect(destinationForUrl('swift://s/BCDFGHJKMN', nothing)).toEqual({ kind: 'short', code: 'BCDFGHJKMN' }); // the custom scheme needs no host
  });
});

describe('[MOB-002] every decision is observable: accepted origins and rejection reasons', () => {
  it('counts accepted by origin and rejected by reason, and hands each decision to the observer', () => {
    const seen: LinkDecision[] = [];
    setLinkDecisionObserver((d) => seen.push(d));
    destinationForUrl('https://swift.gy/s/BCDFGHJKMN');
    destinationForUrl('swift://s/BCDFGHJKMN');
    destinationForUrl('https://attacker.example/s/BCDFGHJKMN');
    destinationForUrl('https://attacker.example/store/x');
    destinationForUrl('https://swift.gy/qr/retired');
    destinationForUrl('http://swift.gy/s/BCDFGHJKMN');
    expect(linkDecisionCounters()).toEqual({
      accepted: { production: 1, 'custom-scheme': 1 },
      rejected: { host_not_allowed: 2, path_shape: 1, http_downgrade: 1 },
    });
    expect(seen).toEqual([
      { kind: 'accepted', origin: 'production', host: 'swift.gy' },
      { kind: 'accepted', origin: 'custom-scheme', host: 's' },
      { kind: 'rejected', reason: 'host_not_allowed', host: 'attacker.example' },
      { kind: 'rejected', reason: 'host_not_allowed', host: 'attacker.example' },
      { kind: 'rejected', reason: 'path_shape', host: 'swift.gy' },
      { kind: 'rejected', reason: 'http_downgrade', host: 'swift.gy' },
    ]);
  });

  it('a throwing observer never breaks a link', () => {
    setLinkDecisionObserver(() => { throw new Error('boom'); });
    expect(destinationForUrl('https://swift.gy/s/BCDFGHJKMN')).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
  });
});
